import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PrismaClient } from "@prisma/client";
import {
  analyzeRepo,
  recordCodeMetric,
  benchmarkEndpoint,
  recordAiCost,
  aiCostAgg,
} from "../src/lib/codeanalysis";

const prisma = new PrismaClient();

const createdCode: string[] = [];
const createdApi: string[] = [];
const createdAi: string[] = [];
const tmpDirs: string[] = [];

async function mkTmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "bench-test-"));
  tmpDirs.push(d);
  return d;
}

test("analyzeRepo on real source dir yields real non-zero metrics", async () => {
  const res = await analyzeRepo("/home/parsa/panel/src", {
    skipTools: true,
  });
  assert.ok(res.loc > 0, `expected loc > 0, got ${res.loc}`);
  assert.ok(res.files > 0, `expected files > 0, got ${res.files}`);
  assert.ok(
    typeof res.duplicationPct === "number" &&
      res.duplicationPct >= 0 &&
      res.duplicationPct <= 100,
    `duplicationPct must be a real 0..100 number, got ${res.duplicationPct}`
  );
  assert.ok(
    res.cyclomatic >= 0,
    `cyclomatic must be >= 0, got ${res.cyclomatic}`
  );
});

test("HONESTY: analyzeRepo on an empty temp dir yields loc 0 (not fabricated)", async () => {
  const dir = await mkTmp();
  const res = await analyzeRepo(dir, { skipTools: true });
  assert.equal(res.loc, 0);
  assert.equal(res.files, 0);
  assert.equal(res.duplicationPct, 0);
});

test("analyzeRepo computes duplication from real repeated content", async () => {
  const dir = await mkTmp();
  const block = Array.from(
    { length: 12 },
    (_, i) => `const v${i} = ${i} + 1;`
  ).join("\n");
  // Two files with the exact same 12-line block → real duplication.
  await fs.writeFile(path.join(dir, "a.ts"), block + "\n");
  await fs.writeFile(path.join(dir, "b.ts"), block + "\n");
  const res = await analyzeRepo(dir, { skipTools: true });
  assert.ok(res.loc > 0);
  assert.ok(
    res.duplicationPct > 0,
    `expected duplication > 0 for repeated blocks, got ${res.duplicationPct}`
  );
});

test("recordCodeMetric persists to real Postgres and reads back", async () => {
  const row = await recordCodeMetric({
    loc: 4321,
    cyclomatic: 3.14,
    duplicationPct: 12.5,
    lintWarnings: 7,
    typeErrors: null,
  });
  createdCode.push(row.id);
  const back = await prisma.codeMetric.findUnique({ where: { id: row.id } });
  assert.ok(back);
  assert.equal(back!.loc, 4321);
  assert.equal(back!.cyclomatic, 3.14);
  assert.equal(back!.duplicationPct, 12.5);
  assert.equal(back!.lintWarnings, 7);
  assert.equal(back!.typeErrors, null);
  assert.ok(typeof back!.commitSha === "string" && back!.commitSha.length > 0);
});

test("benchmarkEndpoint hits a real HTTP server and persists a real row", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${addr.port}/`;

  try {
    const result = await benchmarkEndpoint(url, { n: 20, persist: true });
    assert.equal(result.n, 20);
    assert.ok(
      Number.isFinite(result.p50Ms) &&
        Number.isFinite(result.p95Ms) &&
        Number.isFinite(result.p99Ms)
    );
    assert.ok(
      result.p50Ms <= result.p95Ms && result.p95Ms <= result.p99Ms,
      `expected p50<=p95<=p99, got ${result.p50Ms}/${result.p95Ms}/${result.p99Ms}`
    );

    const persisted = await prisma.apiBenchmark.findFirst({
      where: { endpoint: url },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(persisted, "expected a persisted ApiBenchmark row");
    createdApi.push(persisted!.id);
    assert.equal(persisted!.p50Ms, result.p50Ms);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("HONESTY: unreachable URL throws and persists no row", async () => {
  // Reserve then release a port so nothing is listening there.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const addr = probe.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const deadPort = addr.port;
  await new Promise<void>((r) => probe.close(() => r()));
  const url = `http://127.0.0.1:${deadPort}/`;

  const before = await prisma.apiBenchmark.count({ where: { endpoint: url } });
  await assert.rejects(
    () => benchmarkEndpoint(url, { n: 5, persist: true }),
    /unreachable/i
  );
  const after = await prisma.apiBenchmark.count({ where: { endpoint: url } });
  assert.equal(after, before, "no row must be persisted for unreachable URL");
});

test("aiCostAgg math (sum cost, p95 latency) is correct over real rows", async () => {
  const mod = `BENCH_TEST_MOD_${Date.now()}`;
  const latencies = [100, 200, 300, 400, 500];
  const costs = [0.01, 0.02, 0.03, 0.04, 0.05];
  for (let i = 0; i < 5; i++) {
    const r = await recordAiCost({
      module: mod,
      model: "test-model",
      tokensIn: 10,
      tokensOut: 20,
      costUsd: costs[i],
      latencyMs: latencies[i],
    });
    createdAi.push(r.id);
  }
  const agg = await aiCostAgg(1);
  const mine = agg.find((a) => a.module === mod);
  assert.ok(mine, "expected aggregate for test module");
  assert.equal(mine!.runs, 5);
  assert.equal(mine!.tokensIn, 50);
  assert.equal(mine!.tokensOut, 100);
  // sum cost = 0.15
  assert.equal(Math.round(mine!.costUsd * 100) / 100, 0.15);
  assert.equal(Math.round(mine!.costPerRun * 1000) / 1000, 0.03);
  // p95 of [100..500] (ceil(0.95*5)-1 = idx 4) => 500
  assert.equal(mine!.p95LatencyMs, 500);
  assert.equal(mine!.avgLatencyMs, 300);
});

test("cleanup: remove only rows + temp dirs created by this test", async () => {
  await prisma.codeMetric.deleteMany({ where: { id: { in: createdCode } } });
  await prisma.apiBenchmark.deleteMany({ where: { id: { in: createdApi } } });
  await prisma.aiCostMetric.deleteMany({ where: { id: { in: createdAi } } });
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
  const leftCode = await prisma.codeMetric.count({
    where: { id: { in: createdCode } },
  });
  const leftApi = await prisma.apiBenchmark.count({
    where: { id: { in: createdApi } },
  });
  const leftAi = await prisma.aiCostMetric.count({
    where: { id: { in: createdAi } },
  });
  assert.equal(leftCode, 0);
  assert.equal(leftApi, 0);
  assert.equal(leftAi, 0);
  await prisma.$disconnect();
});
