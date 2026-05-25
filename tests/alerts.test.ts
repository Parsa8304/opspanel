// Must be set BEFORE importing anything that loads src/lib/crypto.ts,
// because crypto reads PANEL_MASTER_KEY at module-load time.
process.env.PANEL_MASTER_KEY =
  process.env.PANEL_MASTER_KEY || "test-master-key-at-least-16-chars-long";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/lib/prisma";
import { isEncrypted, decryptSecret, encryptSecret } from "../src/lib/crypto";
import {
  ensureBuiltinRules,
  processLogLine,
  raiseAlert,
  flushQueued,
  deliveryHealth,
  handleTelegramCallback,
} from "../src/lib/alerts";

/**
 * Real integration test — NOT mocked. Runs against the REAL Postgres on
 * :5544 and a REAL local node:http server emulating the Telegram Bot API.
 */

const SVC = "alerts-test-svc";
let tgServer: http.Server;
let tgPort = 0;
let tgHits: any[] = [];
const createdChannelIds: string[] = [];

function startTelegramServer(): Promise<number> {
  return new Promise((resolve) => {
    tgServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (
          req.method === "POST" &&
          /^\/bot[^/]+\/sendMessage$/.test(req.url || "")
        ) {
          let parsed: any = {};
          try {
            parsed = JSON.parse(body);
          } catch {}
          tgHits.push(parsed);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ ok: true, result: { message_id: tgHits.length } })
          );
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });
    tgServer.listen(0, "127.0.0.1", () => {
      tgPort = (tgServer.address() as AddressInfo).port;
      resolve(tgPort);
    });
  });
}

async function setPanelConfig() {
  await prisma.setting.upsert({
    where: { key: "alerts" },
    create: {
      key: "alerts",
      value: { ingestLogs: false, panelBaseUrl: "http://localhost:3000" },
    },
    update: {
      value: { ingestLogs: false, panelBaseUrl: "http://localhost:3000" },
    },
  });
}

test("setup: telegram server + config", async () => {
  await startTelegramServer();
  await setPanelConfig();
  assert.ok(tgPort > 0, "telegram emulator listening");
});

test("Telegram channel stores configEnc encrypted and decrypts back", async () => {
  const cfg = {
    botToken: "123456:FAKE-TEST-TOKEN",
    chatId: "999",
    baseUrl: `http://127.0.0.1:${tgPort}`,
  };
  const ch = await prisma.alertChannel.create({
    data: {
      type: "telegram",
      name: "test-telegram",
      minSeverity: "INFO",
      enabled: true,
      configEnc: encryptSecret(JSON.stringify(cfg)),
    },
  });
  createdChannelIds.push(ch.id);

  const row = await prisma.alertChannel.findUnique({ where: { id: ch.id } });
  assert.ok(row, "channel row exists");
  assert.ok(
    isEncrypted(row!.configEnc),
    "configEnc is encrypted (v1: envelope)"
  );
  assert.ok(
    !row!.configEnc.includes("FAKE-TEST-TOKEN"),
    "raw token not stored in plaintext"
  );
  const back = JSON.parse(decryptSecret(row!.configEnc));
  assert.equal(back.botToken, cfg.botToken, "decrypts back to original token");
  assert.equal(back.chatId, "999");
});

test("ensureBuiltinRules is idempotent", async () => {
  const r1 = await ensureBuiltinRules();
  const r2 = await ensureBuiltinRules();
  assert.ok(r1.total >= 9, "at least 9 built-in rules");
  assert.equal(r2.created, 0, "second run creates nothing");
  assert.equal(r1.total, r2.total, "same total on re-run");
});

test("processLogLine raises real AlertEvent + real Telegram delivery", async () => {
  tgHits = [];
  const before = await prisma.alertEvent.count({ where: { source: "container_logs" } });
  const r = await processLogLine(
    SVC,
    "ERROR: something exploded\nTraceback (most recent call last):"
  );
  assert.ok(r.raised >= 1, "at least one event raised");

  const ev = await prisma.alertEvent.findFirst({
    where: { source: "container_logs", title: { contains: SVC } },
    orderBy: { createdAt: "desc" },
    include: { deliveries: true },
  });
  assert.ok(ev, "AlertEvent created");
  assert.ok(
    ev!.severity === "ERROR" || ev!.severity === "CRITICAL",
    `severity is real (${ev!.severity})`
  );
  assert.equal(ev!.source, "container_logs");
  assert.ok(
    (ev!.payload as any)?.containerName === SVC,
    "container scoped in payload"
  );

  const del = ev!.deliveries.find((d) =>
    createdChannelIds.includes(d.channelId)
  );
  assert.ok(del, "AlertDelivery to telegram channel created");
  assert.equal(del!.status, "delivered", "delivery delivered after real 2xx");
  assert.ok(del!.deliveredAt, "deliveredAt set");

  // The local Telegram server really received a well-formed sendMessage.
  assert.ok(tgHits.length >= 1, "telegram server received a request");
  const hit = tgHits[tgHits.length - 1];
  assert.equal(String(hit.chat_id), "999", "chat_id forwarded");
  assert.match(hit.text, /something exploded|ERROR/, "excerpt in message");
  assert.ok(
    hit.reply_markup?.inline_keyboard?.length >= 1,
    "inline keyboard buttons present"
  );
  const flat = JSON.stringify(hit.reply_markup.inline_keyboard);
  assert.match(flat, /ack:/, "Acknowledge callback button present");
  assert.match(flat, /snooze:/, "Snooze callback button present");
});

test("cooldown suppresses second fire then allows after window", async () => {
  const rule = await prisma.alertRule.findFirst({
    where: { builtin: true, name: "ERROR keyword" },
  });
  assert.ok(rule, "ERROR built-in rule exists");

  // Reset rule state and remove prior events for clean accounting.
  await prisma.alertEvent.deleteMany({ where: { ruleId: rule!.id } });
  await prisma.alertRule.update({
    where: { id: rule!.id },
    data: { lastFiredAt: null, cooldownSec: 300 },
  });

  const a = await raiseAlert({
    ruleId: rule!.id,
    source: "container_logs",
    severity: "ERROR",
    title: `cooldown ${SVC}`,
    containerName: SVC,
    payload: { line: "ERROR one" },
  });
  assert.equal(a.suppressed, false, "first fire creates an event");

  const b = await raiseAlert({
    ruleId: rule!.id,
    source: "container_logs",
    severity: "ERROR",
    title: `cooldown ${SVC}`,
    containerName: SVC,
    payload: { line: "ERROR two" },
  });
  assert.equal(b.suppressed, true, "second within cooldown is suppressed");
  assert.equal(b.eventId, a.eventId, "suppressed onto same event");

  const ev1 = await prisma.alertEvent.findUnique({
    where: { id: a.eventId },
  });
  assert.equal(ev1!.suppressedCount, 1, "real suppressed count incremented");

  const countBefore = await prisma.alertEvent.count({
    where: { ruleId: rule!.id },
  });

  // Move lastFiredAt outside the cooldown window → next fire is new.
  await prisma.alertRule.update({
    where: { id: rule!.id },
    data: { lastFiredAt: new Date(Date.now() - 301_000) },
  });
  const c = await raiseAlert({
    ruleId: rule!.id,
    source: "container_logs",
    severity: "ERROR",
    title: `cooldown ${SVC}`,
    containerName: SVC,
    payload: { line: "ERROR three" },
  });
  assert.equal(c.suppressed, false, "after window a new event is created");
  assert.notEqual(c.eventId, a.eventId, "different event id");
  const countAfter = await prisma.alertEvent.count({
    where: { ruleId: rule!.id },
  });
  assert.equal(countAfter, countBefore + 1, "exactly one new event added");
});

test("Telegram-unreachable → queued + lastError + health delayed; recover via flush", async () => {
  // Channel pointed at a closed port (nothing listening).
  const closedCfg = {
    botToken: "123456:UNREACHABLE",
    chatId: "555",
    baseUrl: "http://127.0.0.1:1", // port 1: connection refused
  };
  const ch = await prisma.alertChannel.create({
    data: {
      type: "telegram",
      name: "test-telegram-unreachable",
      minSeverity: "INFO",
      enabled: true,
      configEnc: encryptSecret(JSON.stringify(closedCfg)),
    },
  });
  createdChannelIds.push(ch.id);

  // Disable the working channel so this delivery is isolated and queued.
  await prisma.alertChannel.update({
    where: { id: createdChannelIds[0] },
    data: { enabled: false },
  });

  const r = await raiseAlert({
    source: "tests",
    severity: "ERROR",
    title: "unreachable-path",
    payload: { line: "boom" },
  });
  const del = await prisma.alertDelivery.findFirst({
    where: { eventId: r.eventId, channelId: ch.id },
  });
  assert.ok(del, "delivery row created");
  assert.equal(del!.status, "queued", "queued, NOT delivered (no real 2xx)");
  assert.ok(del!.lastError && del!.lastError.length > 0, "lastError set");
  assert.ok(del!.attempts >= 1, "attempts incremented");

  const health = await deliveryHealth();
  assert.ok(health.queued >= 1, "health reports queued");
  assert.equal(health.delayed, true, "delivery delayed banner flag true");

  // Repoint the channel at the REAL working telegram server, then flush.
  await prisma.alertChannel.update({
    where: { id: ch.id },
    data: {
      configEnc: encryptSecret(
        JSON.stringify({
          botToken: "123456:NOW-WORKS",
          chatId: "555",
          baseUrl: `http://127.0.0.1:${tgPort}`,
        })
      ),
    },
  });
  const hitsBefore = tgHits.length;
  const f = await flushQueued();
  assert.ok(f.delivered >= 1, "flush delivered at least one");

  const del2 = await prisma.alertDelivery.findUnique({
    where: { id: del!.id },
  });
  assert.equal(del2!.status, "delivered", "flipped to delivered on recovery");
  assert.ok(del2!.deliveredAt, "deliveredAt set on recovery");
  assert.ok(
    tgHits.length > hitsBefore,
    "a real request hit the telegram server during flush"
  );

  // Re-enable working channel for cleanliness.
  await prisma.alertChannel.update({
    where: { id: createdChannelIds[0] },
    data: { enabled: true },
  });
});

test("Telegram callback maps event to acked", async () => {
  const ev = await prisma.alertEvent.create({
    data: {
      severity: "ERROR",
      source: "tests",
      title: "callback-ack",
    },
  });
  const res = await handleTelegramCallback({
    callback_query: { data: `ack:${ev.id}` },
  });
  assert.equal(res.handled, true, "callback handled");
  assert.equal(res.action, "ack");
  const fresh = await prisma.alertEvent.findUnique({ where: { id: ev.id } });
  assert.equal(fresh!.ackStatus, "acked", "event marked acked");
  assert.ok(fresh!.ackedAt, "ackedAt set");

  // Honest no-op for unknown event.
  const noop = await handleTelegramCallback({
    callback_query: { data: "ack:does-not-exist" },
  });
  assert.equal(noop.handled, false, "unknown event → honest no-op");
});

after(async () => {
  // Clean up all rows we created.
  const evs = await prisma.alertEvent.findMany({
    where: {
      OR: [
        { source: "container_logs", title: { contains: SVC } },
        { source: "tests" },
        { source: "alerts_test" },
        { title: { contains: SVC } },
      ],
    },
    select: { id: true },
  });
  const evIds = evs.map((e) => e.id);
  await prisma.alertDelivery
    .deleteMany({ where: { eventId: { in: evIds } } })
    .catch(() => {});
  await prisma.alertDelivery
    .deleteMany({ where: { channelId: { in: createdChannelIds } } })
    .catch(() => {});
  await prisma.alertEvent
    .deleteMany({ where: { id: { in: evIds } } })
    .catch(() => {});
  await prisma.alertChannel
    .deleteMany({ where: { id: { in: createdChannelIds } } })
    .catch(() => {});
  // Built-in rules are shared infra; only remove their test-created events.
  await prisma.setting.delete({ where: { key: "alerts" } }).catch(() => {});

  await new Promise<void>((r) => tgServer.close(() => r()));
  await prisma.$disconnect();
});
