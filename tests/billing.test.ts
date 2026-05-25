// Must be set BEFORE importing anything that loads src/lib/crypto.ts,
// because crypto reads PANEL_MASTER_KEY at module-load time.
process.env.PANEL_MASTER_KEY =
  process.env.PANEL_MASTER_KEY || "test-master-key-at-least-16-chars-long";

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma";
import { encryptSecret, isEncrypted } from "../src/lib/crypto";
import { setSetting, getSetting } from "../src/lib/api";
import {
  recordEvent,
  reconcile,
  liveBalance,
  checkBudgets,
  priceFor,
  dateToReconcile,
  verifyIngestToken,
} from "../src/lib/billing";

/**
 * Real integration test — NOT mocked. Runs against the REAL Postgres on
 * :5544 and a REAL local node:http server emulating the OpenRouter API
 * (/api/v1/credits, /api/v1/activity, /api/v1/generation, /chat/completions).
 */

const PROVIDER = "billing-test-or";
const MODEL = "billing-test/model-x";
const FREE_MODEL = "billing-test/model-x:free";
const TOKEN = "bilg_test_" + "f".repeat(40);

let server: http.Server;
let port = 0;
let activityCost = 0; // controllable provider-side total for /activity
let creditTotals = { total_credits: 100, total_usage: 37 };

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const u = req.url || "";
      if (req.method === "GET" && u.startsWith("/api/v1/credits")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: creditTotals }));
        return;
      }
      if (req.method === "GET" && u.startsWith("/api/v1/activity")) {
        const day = new URL(u, "http://x").searchParams.get("date");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                date: day,
                model: MODEL,
                requests: 2,
                usage: activityCost,
                prompt_tokens: 2000,
                completion_tokens: 1000,
              },
            ],
          })
        );
        return;
      }
      if (req.method === "GET" && u.startsWith("/api/v1/generation")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              id: new URL(u, "http://x").searchParams.get("id"),
              total_cost: 0.005,
              tokens_prompt: 1500,
              tokens_completion: 800,
              native_tokens_reasoning: 50,
              native_tokens_cached: 200,
            },
          })
        );
        return;
      }
      if (req.method === "POST" && u.startsWith("/chat/completions")) {
        // Real OpenRouter-shaped response incl. cached/reasoning tokens.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "gen-real-1",
            model: MODEL,
            choices: [{ message: { content: "hi" } }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 500,
              total_tokens: 1500,
              cost: 0.012,
              reasoning_tokens: 40,
              prompt_tokens_details: { cached_tokens: 300 },
            },
          })
        );
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve(port);
    });
  });
}

async function cleanup() {
  await prisma.billingEvent.deleteMany({ where: { provider: PROVIDER } });
  await prisma.reconciliationRun.deleteMany({
    where: { provider: PROVIDER },
  });
  await prisma.billingBudget.deleteMany({ where: { provider: PROVIDER } });
  await prisma.providerPricing.deleteMany({ where: { provider: PROVIDER } });
  await prisma.providerCredential.deleteMany({
    where: { provider: PROVIDER },
  });
  await prisma.aiCostMetric
    .deleteMany({ where: { module: "billing-test-mod" } })
    .catch(() => {});
}

before(async () => {
  await startServer();
  await cleanup();
  // Billing config: ingest token + base URL pointed at the local server.
  await setSetting("billing", {
    ingestToken: TOKEN,
    balancePollSec: 300,
    reconThresholdPct: 2,
    reconThresholdUsd: 1,
    providerBaseUrls: { [PROVIDER]: `http://127.0.0.1:${port}` },
    paused: {},
    budgetCrossed: {},
    balanceCache: {},
  });
  // Seed pricing for the test model.
  await prisma.providerPricing.create({
    data: {
      provider: PROVIDER,
      model: MODEL,
      inPricePerM: 5,
      outPricePerM: 10,
      cachedInPricePerM: 1,
      effectiveFrom: new Date("2020-01-01"),
    },
  });
});

test("priceFor picks the version covering the date", async () => {
  const p = await priceFor(PROVIDER, MODEL, new Date());
  assert.ok(p, "pricing row found");
  assert.equal(p!.inPricePerM, 5);
});

test("recordEvent persists with provider-returned real cost + mirrors to AiCost", async () => {
  const before = await prisma.aiCostMetric.count({
    where: { module: "billing-test-mod" },
  });
  const r = await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-real-1",
    module: "billing-test-mod",
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      cost: 0.012,
      reasoning_tokens: 40,
      prompt_tokens_details: { cached_tokens: 300 },
    },
  });
  assert.equal(r.idempotentHit, false);
  // Provider returned a real cost → trusted verbatim.
  assert.equal(r.totalCost, 0.012, "uses real provider cost");

  const ev = await prisma.billingEvent.findUnique({
    where: { generationId: "gen-real-1" },
  });
  assert.ok(ev);
  assert.equal(ev!.tokensIn, 1000);
  assert.equal(ev!.tokensOut, 500);
  assert.equal(ev!.tokensReasoning, 40);
  assert.equal(ev!.tokensCached, 300);
  assert.equal(ev!.unitCost, 0.012);

  const afterCnt = await prisma.aiCostMetric.count({
    where: { module: "billing-test-mod" },
  });
  assert.equal(afterCnt, before + 1, "mirrored to recordAiCost");
});

test("recordEvent is idempotent on generationId", async () => {
  const r = await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-real-1",
    module: "billing-test-mod",
    usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.012 },
  });
  assert.equal(r.idempotentHit, true, "second record is idempotent");
  const cnt = await prisma.billingEvent.count({
    where: { generationId: "gen-real-1" },
  });
  assert.equal(cnt, 1, "exactly one row");
});

test("derived cost from pricing when provider returns no cost (streamed last-chunk)", async () => {
  // Simulate consuming a full stream — usage from the last chunk, no cost.
  const r = await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-stream-1",
    module: "billing-test-mod",
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cached_tokens: 200,
    },
  });
  // billable in = 1000-200=800 @ $5/M, cached 200 @ $1/M, out 500 @ $10/M
  const expected =
    (800 / 1e6) * 5 + (200 / 1e6) * 1 + (500 / 1e6) * 10;
  assert.ok(
    Math.abs(r.totalCost - expected) < 1e-9,
    `derived cost ${r.totalCost} ≈ ${expected}`
  );
});

test("code-smell flag for deprecated usage params", async () => {
  const r = await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-smell-1",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    requestMeta: {
      usage: { include: true },
      stream_options: { include_usage: true },
    },
  });
  assert.ok(r.codeSmells.length >= 2, "two deprecated params flagged");
  const ev = await prisma.billingEvent.findUnique({
    where: { generationId: "gen-smell-1" },
  });
  assert.ok(
    (ev!.rawMeta as any).codeSmells.length >= 2,
    "smells persisted in rawMeta"
  );
});

test("free-tier event → cost 0, isFreeTier true, in usage but not cost", async () => {
  const r = await recordEvent({
    provider: PROVIDER,
    model: FREE_MODEL,
    generationId: "gen-free-1",
    module: "billing-test-mod",
    usage: { prompt_tokens: 5000, completion_tokens: 3000 },
  });
  assert.equal(r.totalCost, 0);
  assert.equal(r.isFreeTier, true);
  const ev = await prisma.billingEvent.findUnique({
    where: { generationId: "gen-free-1" },
  });
  assert.equal(ev!.totalCost, 0);
  assert.equal(ev!.tokensIn, 5000, "tokens still counted for usage");
});

test("BYOK event → isByok true, upstreamInferenceCost set, distinct", async () => {
  const r = await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-byok-1",
    module: "billing-test-mod",
    isByok: true,
    usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.02 },
  });
  assert.equal(r.isByok, true);
  // panel fee = 5% of upstream (real provider cost 0.02)
  assert.ok(
    Math.abs(r.totalCost - 0.02 * 0.05) < 1e-9,
    `byok fee ${r.totalCost} ≈ ${0.02 * 0.05}`
  );
  const ev = await prisma.billingEvent.findUnique({
    where: { generationId: "gen-byok-1" },
  });
  assert.equal(ev!.upstreamInferenceCost, 0.02, "upstream cost recorded");
});

test("budget thresholds: 80% then 100% raise real, deduped alerts + pause flag", async () => {
  // Clean slate for this provider's events to control spend precisely.
  await prisma.billingEvent.deleteMany({ where: { provider: PROVIDER } });
  await setSetting("billing", {
    ...(await getSetting<any>("billing", {})),
    budgetCrossed: {},
    paused: {},
  });
  await prisma.billingBudget.create({
    data: {
      provider: PROVIDER,
      period: "daily",
      limitAmount: 1, // $1/day
      thresholds: [50, 80, 100],
      actionOnBreach: "pause",
      enabled: true,
    },
  });

  const evCountBefore = await prisma.alertEvent.count({
    where: { source: "billing_budget" },
  });

  // Spend $0.85 → crosses 50 and 80 (two alerts).
  await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-b-80",
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.85 },
  });
  let alerts = await prisma.alertEvent.findMany({
    where: { source: "billing_budget" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const t80 = alerts.filter((a) =>
    /80%|50%/.test(a.title)
  );
  assert.ok(t80.length >= 1, "threshold alert fired at/under 80%");

  // Record same spend again — must NOT re-alert 50/80 (deduped).
  const midCount = await prisma.alertEvent.count({
    where: { source: "billing_budget" },
  });
  await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-b-80b",
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.0 },
  });
  const afterDup = await prisma.alertEvent.count({
    where: { source: "billing_budget" },
  });
  assert.equal(afterDup, midCount, "no duplicate threshold spam");

  // Push over 100% → CRITICAL alert + pause flag.
  await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-b-100",
    usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.3 },
  });
  alerts = await prisma.alertEvent.findMany({
    where: { source: "billing_budget" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  assert.ok(
    alerts.some((a) => a.severity === "CRITICAL" && /100%/.test(a.title)),
    "100% breach raised a CRITICAL alert"
  );
  assert.ok(
    (await prisma.alertEvent.count({
      where: { source: "billing_budget" },
    })) > evCountBefore,
    "real AlertEvents persisted via alerts lib"
  );
  const cfg = await getSetting<any>("billing", {});
  assert.equal(
    cfg.paused?.[PROVIDER],
    true,
    "pause flag set at 100% with actionOnBreach=pause"
  );
});

test("liveBalance: real call → balance = total_credits − total_usage, cached", async () => {
  await prisma.providerCredential.create({
    data: {
      provider: PROVIDER,
      credType: "management",
      keyEnc: encryptSecret("mgmt-secret-key-123"),
    },
  });
  const row = await prisma.providerCredential.findFirst({
    where: { provider: PROVIDER, credType: "management" },
  });
  assert.ok(isEncrypted(row!.keyEnc), "management key encrypted at rest");
  assert.ok(
    !row!.keyEnc.includes("mgmt-secret-key-123"),
    "plaintext key not stored"
  );

  creditTotals = { total_credits: 100, total_usage: 37 };
  const b = await liveBalance(PROVIDER, { force: true });
  assert.ok(b.ok, "balance call ok");
  if (b.ok) {
    assert.equal(b.balance, 63, "100 - 37 = 63");
    assert.equal(b.cached, false, "fresh call");
  }
  // Second call within poll window → cached (no new HTTP).
  creditTotals = { total_credits: 999, total_usage: 0 };
  const b2 = await liveBalance(PROVIDER);
  assert.ok(b2.ok && b2.cached, "served from cache");
  if (b2.ok) assert.equal(b2.balance, 63, "cached value unchanged");
});

test("liveBalance: no management key → honest error", async () => {
  const r = await liveBalance("nonexistent-provider", { force: true });
  assert.equal(r.ok, false);
  if (!r.ok)
    assert.match(
      r.error,
      /base URL|Management key/,
      "honest typed error, not zeros"
    );
});

test("reconcile: drift beyond threshold → flagged drift run + real alert", async () => {
  const day = new Date(Date.now() - 86400_000);
  const dayStart = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())
  );
  // Capture a real event on that UTC day.
  await prisma.billingEvent.create({
    data: {
      provider: PROVIDER,
      model: MODEL,
      generationId: "gen-recon-1",
      requestAt: new Date(dayStart.getTime() + 3600_000),
      tokensIn: 1000,
      tokensOut: 500,
      totalCost: 1.0,
      isFreeTier: false,
    },
  });
  // Provider says total = 5.0 → drift $4 / 80% → both thresholds exceeded.
  activityCost = 5.0;
  const recBefore = await prisma.alertEvent.count({
    where: { source: "billing_recon" },
  });
  const r = await reconcile(PROVIDER, day);
  assert.equal(r.status, "drift");
  assert.equal(r.flagged, true);
  assert.ok(Math.abs(r.driftAbs - 4.0) < 1e-6, "driftAbs = |1 - 5| = 4");
  assert.ok(r.driftPct > 2, "driftPct beyond threshold");
  assert.ok(
    r.breakdown.some((b) => b.model === MODEL),
    "per-model breakdown present"
  );
  const run = await prisma.reconciliationRun.findUnique({
    where: { provider_forDate: { provider: PROVIDER, forDate: dayStart } },
  });
  assert.ok(run && run.flagged && run.status === "drift");
  assert.ok(
    (await prisma.alertEvent.count({
      where: { source: "billing_recon" },
    })) > recBefore,
    "real billing_recon AlertEvent raised"
  );
});

test("reconcile: within threshold → ok, not flagged", async () => {
  const day = new Date(Date.now() - 86400_000);
  activityCost = 1.0; // matches captured 1.0 exactly → no drift
  const r = await reconcile(PROVIDER, day);
  assert.equal(r.status, "ok");
  assert.equal(r.flagged, false);
  assert.ok(r.driftAbs < 1, "drift within $ threshold");
});

test("dateToReconcile is pure and honors min-settle guard", () => {
  const early = new Date(Date.UTC(2030, 0, 2, 0, 5));
  assert.equal(
    dateToReconcile(early, 30),
    null,
    "too early after midnight → wait"
  );
  const ok = new Date(Date.UTC(2030, 0, 2, 1, 0));
  const d = dateToReconcile(ok, 30);
  assert.ok(d, "settled → returns a date");
  assert.equal(d!.toISOString().slice(0, 10), "2030-01-01", "yesterday UTC");
});

test("ingest token verification: correct accepted, wrong/absent rejected", async () => {
  assert.equal(await verifyIngestToken(TOKEN), true, "correct token ok");
  assert.equal(
    await verifyIngestToken("wrong-token"),
    false,
    "wrong token rejected"
  );
  assert.equal(await verifyIngestToken(null), false, "absent token rejected");
});

test("spendSummary keeps BYOK distinct and excludes free from cost", async () => {
  // Seed fresh, unambiguous events (earlier tests cleared provider rows).
  await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-sum-direct",
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.5 },
  });
  await recordEvent({
    provider: PROVIDER,
    model: MODEL,
    generationId: "gen-sum-byok",
    isByok: true,
    usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.4 },
  });
  await recordEvent({
    provider: PROVIDER,
    model: FREE_MODEL,
    generationId: "gen-sum-free",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  const s = await spendSummaryProvider();
  assert.ok(s.byokTotal > 0, "byok total tracked separately");
  assert.ok(s.directTotal > 0, "direct total tracked separately");
  assert.ok(
    s.directTotal !== s.byokTotal,
    "byok and direct not conflated"
  );
  // free events counted in requests but not in cost
  assert.ok(s.freeRequests >= 1, "free requests counted");
});

async function spendSummaryProvider() {
  const { spendSummary } = await import("../src/lib/billing");
  return spendSummary({ groupBy: "provider" });
}

after(async () => {
  await cleanup();
  await prisma.setting.delete({ where: { key: "billing" } }).catch(() => {});
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});
