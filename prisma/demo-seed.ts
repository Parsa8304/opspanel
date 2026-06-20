/**
 * DEMO dataset — presentation use only. Clearly reversible:
 *   npx tsx prisma/demo-seed.ts seed   # load demo data into empty sections
 *   npx tsx prisma/demo-seed.ts wipe   # remove it / reset Q/A to STALE
 * Real live data (containers, git, async, discovery) is untouched either way.
 */
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const mode = process.argv[2] || "seed";
const now = Date.now();
const D = 86400000;
const ago = (d: number) => new Date(now - d * D);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const ri = (a: number, b: number) => Math.round(rnd(a, b));
const pick = <T>(x: T[]) => x[Math.floor(Math.random() * x.length)];

const MODULES = [
  "quick_report", "decision_engine", "gtm_strategy",
  "pitch_deck", "find_experts", "ai_research_assistant",
];
const DEMO_TABLES = [
  "testCase", "testRun", "coverageMetric", "integrationCall", "integrationIncident",
  "billingEvent", "providerPricing", "billingBudget", "reconciliationRun",
  "aiSample", "aiCostMetric", "codeMetric", "apiBenchmark", "deployRun",
  "release", "jobRecord", "alertEvent",
] as const;

async function wipe() {
  for (const t of DEMO_TABLES) {
    // @ts-ignore
    await p[t].deleteMany({}).catch(() => {});
  }
  await p.deployment.deleteMany({ where: { version: { startsWith: "v2." } } }).catch(() => {});
  await p.regressionItem.updateMany({
    data: { status: "STALE", lastVerifiedAt: null, verifiedById: null },
  });
  await p.accessScenario.updateMany({
    data: { status: "STALE", lastVerifiedAt: null, verifiedById: null },
  });
  console.log("Demo data wiped; Q/A + access scenarios reset to STALE.");
}

async function seed() {
  await wipe();
  const admin = await p.user.findFirst({ where: { role: "ADMIN" } });
  const uid = admin?.id;

  // ── Q/A: all regression items verified passing recently ──
  const regs = await p.regressionItem.findMany();
  for (const r of regs) {
    await p.regressionItem.update({
      where: { id: r.id },
      data: {
        status: "PASSING",
        lastVerifiedAt: ago(ri(1, 9)),
        verifiedById: uid,
        testSteps: r.testSteps || "Smoke + functional pass on demo environment.",
      },
    });
  }
  const scs = await p.accessScenario.findMany();
  for (const s of scs)
    await p.accessScenario.update({
      where: { id: s.id },
      data: { status: "PASSING", lastVerifiedAt: ago(ri(1, 6)), verifiedById: uid },
    });
  const covs = await p.coverageItem.findMany();
  const covStatus = ["DONE", "DONE", "IN_PROGRESS", "DONE", "IN_PROGRESS", "DONE", "DONE"];
  for (let i = 0; i < covs.length; i++)
    await p.coverageItem.update({
      where: { id: covs[i].id },
      data: {
        status: covStatus[i % covStatus.length] as any,
        owner: pick(["Reza", "Sara", "Mehdi", "Niloofar"]),
        deadline: ago(-ri(10, 45)),
        notes: "Tracked; on plan.",
      },
    });

  // ── Test runs (14 days, high pass rate, a little flaky) ──
  const sha = "769514b";
  for (let d = 14; d >= 0; d--) {
    const total = ri(180, 220);
    const failed = Math.random() < 0.25 ? ri(1, 4) : 0;
    const skipped = ri(0, 3);
    const passed = total - failed - skipped;
    const run = await p.testRun.create({
      data: {
        commitSha: sha, source: "ci", ciUrl: "https://ci.internal/run",
        total, passed, failed, skipped,
        durationMs: ri(120000, 240000),
        startedAt: ago(d), finishedAt: ago(d),
      },
    });
    const types = ["UNIT", "INTEGRATION", "API", "E2E", "FRONTEND", "WORKER"];
    const cases = [];
    for (let i = 0; i < 14; i++) {
      const isFail = i === 0 && failed > 0;
      cases.push({
        testRunId: run.id,
        name: `test_${pick(MODULES)}_${i}`,
        classname: `suite.${pick(types).toLowerCase()}`,
        type: pick(types) as any,
        status: (isFail ? "FAILED" : Math.random() < 0.02 ? "SKIPPED" : "PASSED") as any,
        durationMs: ri(20, 4000),
        failureMessage: isFail ? "AssertionError: expected 200, got 503 (flaky upstream)" : null,
      });
    }
    await p.testCase.createMany({ data: cases });
  }
  const QAMODS = ["auth", "projects", "quick_report", "decision_engine", "gtm", "pitch_deck", "search", "storage"];
  for (let d = 14; d >= 0; d -= 2)
    for (const m of QAMODS)
      await p.coverageMetric.create({
        data: { module: m, linesPct: rnd(78, 94), commitSha: sha, createdAt: ago(d) },
      });

  // ── Integrations: enable + 30d of calls ~98% success ──
  const ints = await p.integration.findMany();
  for (const it of ints) {
    await p.integration.update({
      where: { id: it.id },
      data: { enabled: true, credentialExpiresAt: ago(-ri(60, 200)) },
    });
    const calls = [];
    const n = ri(220, 380);
    for (let i = 0; i < n; i++) {
      const ok = Math.random() < 0.985;
      const ai = it.category === "AI_PROVIDER";
      calls.push({
        integrationId: it.id,
        success: ok,
        statusCode: ok ? 200 : pick([429, 500, 503]),
        latencyMs: ri(ai ? 600 : 120, ai ? 2600 : 900),
        costUsd: ai ? rnd(0.001, 0.03) : null,
        error: ok ? null : "upstream timeout",
        createdAt: ago(rnd(0, 30)),
      });
    }
    await p.integrationCall.createMany({ data: calls });
  }
  const firstInt = ints[0];
  if (firstInt)
    await p.integrationIncident.create({
      data: {
        integrationId: firstInt.id,
        title: "Elevated latency (resolved)",
        description: "Provider-side latency spike; auto-recovered.",
        severity: "minor", startedAt: ago(6), resolvedAt: ago(6),
      },
    });

  // ── Billing: pricing, 30d events, budget, clean reconciliation ──
  const pricing = [
    { provider: "openrouter", model: "google/gemini-2.5-flash", inP: 0.3, outP: 2.5, cIn: 0.075 },
    { provider: "openrouter", model: "anthropic/claude-sonnet", inP: 3, outP: 15, cIn: 0.3 },
    { provider: "gemini", model: "gemini-2.5-flash", inP: 0.3, outP: 2.5, cIn: 0.075 },
  ];
  for (const pr of pricing)
    await p.providerPricing.create({
      data: {
        provider: pr.provider, model: pr.model,
        inPricePerM: pr.inP, outPricePerM: pr.outP, cachedInPricePerM: pr.cIn,
        effectiveFrom: ago(120),
      },
    });
  await p.billingBudget.create({
    data: { provider: "openrouter", period: "monthly", limitAmount: 500, thresholds: [50, 80, 100], actionOnBreach: "alert", enabled: true },
  });
  let gen = 1;
  for (let d = 30; d >= 0; d--) {
    const perDay = ri(40, 90);
    const evs = [];
    for (let i = 0; i < perDay; i++) {
      const pr = pick(pricing);
      const tin = ri(800, 9000), tout = ri(300, 3500), tc = ri(0, 1500);
      const cost = (tin / 1e6) * pr.inP + (tout / 1e6) * pr.outP;
      evs.push({
        provider: pr.provider, model: pr.model, endpoint: "/chat/completions",
        generationId: `gen-demo-${gen++}`, requestId: `req-${gen}`,
        requestAt: ago(rnd(d, d + 0.9)),
        tokensIn: tin, tokensOut: tout, tokensReasoning: ri(0, 600), tokensCached: tc,
        unitCost: null, totalCost: +cost.toFixed(5), currency: "USD",
        module: pick(MODULES), isByok: false, isFreeTier: false,
        createdAt: ago(d),
      });
    }
    await p.billingEvent.createMany({ data: evs });
  }
  for (let d = 7; d >= 1; d--) {
    const cap = +rnd(8, 22).toFixed(2);
    await p.reconciliationRun.create({
      data: {
        provider: "openrouter", forDate: ago(d),
        capturedTotal: cap, providerTotal: +(cap * rnd(0.995, 1.005)).toFixed(2),
        driftAbs: +rnd(0, 0.15).toFixed(3), driftPct: +rnd(0, 0.9).toFixed(2),
        flagged: false, status: "ok",
      },
    });
  }

  // ── AI quality: samples + cost metrics ──
  for (let i = 0; i < 48; i++) {
    const m = pick(MODULES);
    const flagged = Math.random() < 0.06;
    await p.aiSample.create({
      data: {
        module: m, model: "google/gemini-2.5-flash", modelVersion: "2.5-flash-001",
        inputText: `Sample prompt for ${m} #${i}`,
        outputText: "High-quality structured output produced for the demo dataset.",
        humanRating: flagged ? ri(2, 3) : ri(4, 5),
        notes: flagged ? "Minor formatting issue, flagged for review." : "Looks good.",
        costUsd: +rnd(0.002, 0.04).toFixed(4), latencyMs: ri(700, 2600),
        flag: (flagged ? "HALLUCINATION" : "NONE") as any,
        reviewStatus: (flagged ? "PENDING" : "REVIEWED") as any,
        reviewedById: flagged ? null : uid,
        createdAt: ago(rnd(0, 21)),
      },
    });
  }
  for (let d = 21; d >= 0; d--)
    for (const m of MODULES)
      await p.aiCostMetric.create({
        data: {
          module: m, model: "google/gemini-2.5-flash",
          tokensIn: ri(3000, 12000), tokensOut: ri(1000, 5000),
          costUsd: +rnd(0.05, 0.6).toFixed(4), latencyMs: ri(800, 2400),
          createdAt: ago(d),
        },
      });

  // ── Code benchmarks: trend + api latency ──
  for (let d = 14; d >= 0; d--)
    await p.codeMetric.create({
      data: {
        commitSha: sha,
        loc: ri(48000, 52000), cyclomatic: +rnd(3.1, 4.2).toFixed(2),
        duplicationPct: +rnd(1.5, 4).toFixed(2),
        lintWarnings: ri(2, 14), typeErrors: 0,
        buildTimeMs: ri(95000, 140000), bundleBytes: ri(900000, 1200000),
        createdAt: ago(d),
      },
    });
  for (const ep of ["/api/projects", "/api/quick-report", "/api/decision-engine", "/api/auth/login"])
    for (let d = 14; d >= 0; d -= 2)
      await p.apiBenchmark.create({
        data: {
          endpoint: ep,
          p50Ms: rnd(40, 120), p95Ms: rnd(150, 420), p99Ms: rnd(400, 900),
          commitSha: sha, createdAt: ago(d),
        },
      });

  // ── Deploy history + releases ──
  const envs = ["DEV", "STAGING", "DEMO", "PROD"];
  for (let k = 0; k < 8; k++) {
    const env = pick(envs);
    const dep = await p.deployment.create({
      data: {
        environment: env as any, commitSha: sha, version: `v2.${ri(2, 9)}.${ri(0, 9)}`,
        status: "active", deployedById: uid, deployedAt: ago(ri(1, 25)),
      },
    });
    await p.deployRun.create({
      data: {
        environment: env as any, commitSha: sha, service: "backend",
        strategy: "blue_green", state: "SUCCEEDED",
        deploymentId: dep.id, triggeredById: uid,
        log: "preflight ok\nbuild ok\nhealth ok\nswitched\ndrained old\n",
        startedAt: ago(ri(1, 25)), finishedAt: ago(ri(1, 25)),
      },
    });
  }
  for (let k = 0; k < 4; k++)
    await p.release.create({
      data: {
        version: `v2.${5 + k}.0`, commitSha: sha,
        changelog: "- fixes and improvements\n- perf tuning\n- new module polish",
        deployedById: uid, date: ago(ri(2, 40)),
      },
    });

  // ── Async job history (6 task types, mostly success) ──
  let jid = 1;
  for (let d = 7; d >= 0; d--)
    for (const tt of MODULES) {
      const n = ri(20, 60);
      const jobs = [];
      for (let i = 0; i < n; i++) {
        const fail = Math.random() < 0.04;
        jobs.push({
          taskId: `demo-${tt}-${jid++}`,
          taskType: tt, queue: "celery",
          status: (fail ? "FAILURE" : "SUCCESS") as any,
          workerName: `celery@worker-${ri(1, 3)}`,
          durationMs: ri(800, 45000),
          error: fail ? "Task timeout after retry" : null,
          createdAt: ago(rnd(d, d + 0.9)), finishedAt: ago(d),
        });
      }
      await p.jobRecord.createMany({ data: jobs });
    }

  // ── A few alerts (mostly resolved) ──
  const alerts = [
    { sev: "WARN", src: "billing_budget", title: "OpenRouter spend at 50% of monthly budget", ack: "acked" },
    { sev: "INFO", src: "deploy", title: "Deploy to PROD succeeded (v2.7.1)", ack: "acked" },
    { sev: "ERROR", src: "container_logs", title: "api-backend: transient 503 (auto-recovered)", ack: "acked" },
    { sev: "INFO", src: "tests", title: "Nightly test suite passed (214/214)", ack: "acked" },
  ];
  for (const a of alerts)
    await p.alertEvent.create({
      data: {
        severity: a.sev as any, source: a.src, title: a.title,
        ackStatus: a.ack, ackById: uid, ackedAt: ago(rnd(0, 4)),
        createdAt: ago(rnd(0, 7)),
      },
    });

  console.log("Demo dataset loaded. Reversible with: npx tsx prisma/demo-seed.ts wipe");
}

(mode === "wipe" ? wipe() : seed())
  .then(() => p.$disconnect())
  .catch(async (e) => { console.error(e); await p.$disconnect(); process.exit(1); });
