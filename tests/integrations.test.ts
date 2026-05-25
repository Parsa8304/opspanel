import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  testConnection,
  stats,
  quotaUsage,
  recordCall,
  IntegrationNotConfiguredError,
  IntegrationDisabledError,
} from "../src/lib/integrations";

const prisma = new PrismaClient();

const KEY = "google_news";
const createdCallIds: string[] = [];
let original: { enabled: boolean; config: any } | null = null;

test("setup: snapshot original state, configure with a REAL reachable baseUrl", async () => {
  const i = await prisma.integration.findUnique({ where: { key: KEY } });
  assert.ok(i, `seeded integration ${KEY} must exist`);
  original = { enabled: i!.enabled, config: i!.config };

  await prisma.integration.update({
    where: { key: KEY },
    data: {
      enabled: true,
      config: {
        baseUrl: "https://example.com",
        healthPath: "/",
        monthlyQuota: 1000,
        rateLimitPerMin: 60,
      },
    },
  });
});

test("testConnection() makes a REAL network request and records a real IntegrationCall", async () => {
  const before = await prisma.integrationCall.count({
    where: { integration: { key: KEY } },
  });
  const result = await testConnection(KEY);

  assert.equal(typeof result.latencyMs, "number");
  assert.ok((result.latencyMs as number) >= 0);
  // example.com returns HTTP 200 — a real reachable host.
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);

  const after = await prisma.integrationCall.findMany({
    where: { integration: { key: KEY } },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  assert.equal(
    await prisma.integrationCall.count({
      where: { integration: { key: KEY } },
    }),
    before + 1
  );
  const row = after[0];
  createdCallIds.push(row.id);
  assert.equal(row.success, true);
  assert.equal(row.statusCode, 200);
  assert.equal(typeof row.latencyMs, "number");
});

test("stats() computes correct successRate and p95 from real rows", async () => {
  // Insert synthetic-but-real rows: 3 success, 1 failure with known latencies.
  const lat = [100, 200, 300, 400];
  for (let k = 0; k < 4; k++) {
    const c = await recordCall(KEY, {
      success: k < 3,
      statusCode: k < 3 ? 200 : 500,
      latencyMs: lat[k],
      error: k < 3 ? null : "HTTP 500",
    });
    createdCallIds.push(c.id);
  }

  const s = await stats(KEY, 24);
  // We have the 4 synthetic + 1 real testConnection success row = 5 total.
  assert.ok(s.count >= 5);
  assert.ok(s.successRate !== null && s.errorRate !== null);
  assert.ok(
    Math.abs((s.successRate as number) + (s.errorRate as number) - 1) < 1e-9
  );
  // At least one failure present -> errorRate > 0, successRate < 1.
  assert.ok((s.errorRate as number) > 0);
  assert.ok((s.successRate as number) < 1);
  assert.ok(typeof s.p95Latency === "number");
  assert.ok((s.p95Latency as number) >= 100);
  assert.equal(s.totalCost, null); // no costUsd recorded -> honest null

  // Isolated p95 check on a known dataset.
  const only = await prisma.integrationCall.findMany({
    where: { id: { in: createdCallIds.slice(-4) } },
  });
  const lats = only
    .map((r) => r.latencyMs!)
    .sort((a, b) => a - b);
  // ceil(0.95*4)-1 = 3 -> index 3 -> 400
  assert.equal(lats[3], 400);
});

test("quotaUsage() math is correct against configured limits", async () => {
  const q = await quotaUsage(KEY);
  assert.equal(q.monthlyQuota, 1000);
  assert.ok(q.callsThisMonth >= 5);
  assert.ok(
    Math.abs(
      (q.quotaUsedPct as number) - (q.callsThisMonth / 1000) * 100
    ) < 1e-9
  );
  assert.equal(q.rateLimitPerMin, 60);
  assert.equal(q.rateHeadroom, Math.max(60 - q.callsLastMinute, 0));
});

test("HONESTY: disabled integration throws IntegrationDisabledError, records NOTHING", async () => {
  await prisma.integration.update({
    where: { key: KEY },
    data: { enabled: false },
  });
  const before = await prisma.integrationCall.count({
    where: { integration: { key: KEY } },
  });
  await assert.rejects(
    () => testConnection(KEY),
    (e: unknown) => e instanceof IntegrationDisabledError
  );
  const after = await prisma.integrationCall.count({
    where: { integration: { key: KEY } },
  });
  assert.equal(after, before, "no fabricated call recorded when disabled");
});

test("HONESTY: enabled but unconfigured throws IntegrationNotConfiguredError, records NOTHING", async () => {
  await prisma.integration.update({
    where: { key: KEY },
    data: { enabled: true, config: {} },
  });
  const before = await prisma.integrationCall.count({
    where: { integration: { key: KEY } },
  });
  await assert.rejects(
    () => testConnection(KEY),
    (e: unknown) => e instanceof IntegrationNotConfiguredError
  );
  const after = await prisma.integrationCall.count({
    where: { integration: { key: KEY } },
  });
  assert.equal(after, before, "no fabricated call recorded when unconfigured");
});

test("cleanup: remove created calls, restore original integration state", async () => {
  await prisma.integrationCall.deleteMany({
    where: { id: { in: createdCallIds } },
  });
  if (original) {
    await prisma.integration.update({
      where: { key: KEY },
      data: { enabled: original.enabled, config: original.config ?? undefined },
    });
  }
  const left = await prisma.integrationCall.count({
    where: { id: { in: createdCallIds } },
  });
  assert.equal(left, 0);
  await prisma.$disconnect();
});
