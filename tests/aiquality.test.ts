import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PrismaClient } from "@prisma/client";
import {
  recordSample,
  rateSample,
  flagSample,
  similarity,
  callModel,
  runRegression,
  stats,
  AiProviderNotConfiguredError,
  AI_PROVIDERS_SETTING_KEY,
} from "../src/lib/aiquality";

const prisma = new PrismaClient();

const createdSamples: string[] = [];
const createdCases: string[] = [];
const createdRuns: string[] = [];
const createdCost: string[] = [];

const MOD_A = `AIQ_TEST_A_${Date.now()}`;
const MOD_B = `AIQ_TEST_B_${Date.now()}`;

let server: http.Server;
let port = 0;
let hitCount = 0;
let savedSetting: any = undefined;
let settingExisted = false;

let REVIEWER_ID = "";

test("setup: real local OpenAI-compatible server + provider Setting", async () => {
  // Snapshot existing Setting so we can restore it.
  const existing = await prisma.setting.findUnique({
    where: { key: AI_PROVIDERS_SETTING_KEY },
  });
  if (existing) {
    settingExisted = true;
    savedSetting = existing.value;
  }

  // rateSample sets reviewedById which is a real FK → need a real User.
  const reviewer = await prisma.user.create({
    data: {
      email: `aiq-test-reviewer-${Date.now()}@example.com`,
      name: "AIQ Test Reviewer",
      passwordHash: "x",
      role: "REVIEWER",
    },
  });
  REVIEWER_ID = reviewer.id;

  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      hitCount++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const prompt = parsed?.messages?.[0]?.content ?? "";
        // Deterministic completion derived from the prompt.
        const completion = `ECHO: ${prompt}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-test",
            choices: [
              { index: 0, message: { role: "assistant", content: completion } },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  port = addr.port;

  await prisma.setting.upsert({
    where: { key: AI_PROVIDERS_SETTING_KEY },
    create: {
      key: AI_PROVIDERS_SETTING_KEY,
      value: {
        active: "custom",
        providers: {
          custom: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "test-key",
            model: "test-model",
            pricePer1kIn: 0.001,
            pricePer1kOut: 0.002,
          },
        },
      },
    },
    update: {
      value: {
        active: "custom",
        providers: {
          custom: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "test-key",
            model: "test-model",
            pricePer1kIn: 0.001,
            pricePer1kOut: 0.002,
          },
        },
      },
    },
  });
});

test("similarity is deterministic, bounded, and meaningful", () => {
  assert.equal(similarity("hello world", "hello world"), 1);
  assert.equal(similarity("abc", "abc"), 1);
  const s = similarity("the quick brown fox", "the quick brown dog");
  assert.ok(s > 0 && s < 1, `expected partial similarity, got ${s}`);
  // Deterministic: same inputs → same output.
  assert.equal(s, similarity("the quick brown fox", "the quick brown dog"));
  assert.equal(similarity("abc", "xyz123"), 0);
});

test("recordSample persists real rows across modules + mirrors cost", async () => {
  const a1 = await recordSample({
    module: MOD_A,
    model: "test-model",
    modelVersion: "v1",
    inputText: "summarize the market",
    outputText: "the market is growing",
    costUsd: 0.01,
    latencyMs: 120,
    tokensIn: 10,
    tokensOut: 20,
  });
  const a2 = await recordSample({
    module: MOD_A,
    model: "test-model",
    modelVersion: "v2",
    inputText: "what is the TAM",
    outputText: "TAM is 1B",
    costUsd: 0.03,
    latencyMs: 300,
  });
  const b1 = await recordSample({
    module: MOD_B,
    model: "test-model",
    inputText: "draft a pitch",
    outputText: "here is a pitch",
    latencyMs: 200,
  });
  createdSamples.push(a1.id, a2.id, b1.id);

  const back = await prisma.aiSample.findUnique({ where: { id: a1.id } });
  assert.ok(back);
  assert.equal(back!.module, MOD_A);
  assert.equal(back!.reviewStatus, "PENDING");
  assert.equal(back!.costUsd, 0.01);

  // Cost mirrored into AiCostMetric for rows with cost/tokens.
  const cm = await prisma.aiCostMetric.findFirst({
    where: { module: MOD_A },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(cm, "expected an AiCostMetric mirror row for MOD_A");
  createdCost.push(
    ...(
      await prisma.aiCostMetric.findMany({
        where: { module: { in: [MOD_A, MOD_B] } },
        select: { id: true },
      })
    ).map((r) => r.id)
  );
});

test("rateSample sets humanRating + REVIEWED", async () => {
  const id = createdSamples[0];
  const updated = await rateSample(id, 4, "good answer", REVIEWER_ID);
  assert.equal(updated.humanRating, 4);
  assert.equal(updated.reviewStatus, "REVIEWED");
  assert.equal(updated.reviewedById, REVIEWER_ID);
  await assert.rejects(() => rateSample(id, 9, null, REVIEWER_ID));
});

test("flagSample HALLUCINATION puts sample back in the queue", async () => {
  const id = createdSamples[1];
  const updated = await flagSample(id, "HALLUCINATION", REVIEWER_ID);
  assert.equal(updated.flag, "HALLUCINATION");
  assert.equal(updated.reviewStatus, "PENDING");

  // Queue = flag != NONE OR reviewStatus PENDING.
  const queue = await prisma.aiSample.findMany({
    where: {
      AND: [
        { id: { in: createdSamples } },
        { OR: [{ flag: { not: "NONE" } }, { reviewStatus: "PENDING" }] },
      ],
    },
  });
  assert.ok(
    queue.some((q) => q.id === id),
    "flagged sample must appear in review queue"
  );
});

test("callModel makes a REAL HTTP request to the local server", async () => {
  const before = hitCount;
  const r = await callModel({ prompt: "hello there" });
  assert.equal(hitCount, before + 1, "expected exactly one real HTTP call");
  assert.equal(r.output, "ECHO: hello there");
  assert.equal(r.tokensIn, 11);
  assert.equal(r.tokensOut, 7);
  // cost = 11/1000*0.001 + 7/1000*0.002 = 0.000011 + 0.000014 = 0.000025
  assert.equal(r.costUsd, 0.000025);
  assert.ok(r.latencyMs >= 0);
});

test("runRegression: real call, persisted run, matchScore = similarity()", async () => {
  const rc = await prisma.aiRegressionCase.create({
    data: {
      module: MOD_A,
      inputText: "the baseline prompt",
      baselineOutput: "ECHO: the baseline prompt",
      baselineModel: "test-model",
    },
  });
  createdCases.push(rc.id);

  const before = hitCount;
  const run = await runRegression(rc.id);
  assert.equal(hitCount, before + 1, "runRegression must hit the real server");
  createdRuns.push(run.id);

  const expectedOutput = "ECHO: the baseline prompt";
  const expectedScore = similarity(rc.baselineOutput!, expectedOutput);
  assert.equal(run.output, expectedOutput);
  assert.ok(
    typeof run.matchScore === "number" &&
      run.matchScore >= 0 &&
      run.matchScore <= 1
  );
  assert.equal(run.matchScore, expectedScore);
  // Identical baseline/output here → perfect score.
  assert.equal(run.matchScore, 1);

  const persisted = await prisma.aiRegressionRun.findUnique({
    where: { id: run.id },
  });
  assert.ok(persisted, "AiRegressionRun must be persisted");
});

test("HONESTY: callModel with NO provider throws and persists no row", async () => {
  // Temporarily clear the Setting.
  await prisma.setting.delete({
    where: { key: AI_PROVIDERS_SETTING_KEY },
  });
  const runsBefore = await prisma.aiRegressionRun.count();
  await assert.rejects(
    () => callModel({ prompt: "x" }),
    (e: any) =>
      e instanceof AiProviderNotConfiguredError &&
      e.name === "AiProviderNotConfiguredError"
  );
  const rc = await prisma.aiRegressionCase.create({
    data: { module: MOD_A, inputText: "p", baselineOutput: "b" },
  });
  createdCases.push(rc.id);
  await assert.rejects(
    () => runRegression(rc.id),
    AiProviderNotConfiguredError
  );
  const runsAfter = await prisma.aiRegressionRun.count();
  assert.equal(runsAfter, runsBefore, "no run row when provider missing");

  // Restore the test provider Setting for any later assertions.
  await prisma.setting.upsert({
    where: { key: AI_PROVIDERS_SETTING_KEY },
    create: {
      key: AI_PROVIDERS_SETTING_KEY,
      value: {
        active: "custom",
        providers: {
          custom: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "test-key",
            model: "test-model",
          },
        },
      },
    },
    update: {
      value: {
        active: "custom",
        providers: {
          custom: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "test-key",
            model: "test-model",
          },
        },
      },
    },
  });
});

test("stats() math over the real rows is correct", async () => {
  const all = await stats(1);
  const a = all.find((s) => s.module === MOD_A);
  const b = all.find((s) => s.module === MOD_B);
  assert.ok(a, "expected stats for MOD_A");
  assert.ok(b, "expected stats for MOD_B");

  // MOD_A: 2 samples. one rated 4, one flagged HALLUCINATION (unrated).
  assert.equal(a!.samples, 2);
  assert.equal(a!.ratedCount, 1);
  assert.equal(a!.avgHumanRating, 4);
  assert.equal(a!.flagCounts.HALLUCINATION, 1);
  assert.equal(a!.hallucinationRate, 0.5); // 1 of 2
  // avg cost over rows with cost = (0.01 + 0.03)/2 = 0.02
  assert.equal(a!.avgCostPerOutput, 0.02);
  // avg latency over [120,300] = 210
  assert.equal(a!.avgLatencyMs, 210);
  // two distinct model versions tracked
  assert.equal(a!.modelVersions.length, 2);

  assert.equal(b!.samples, 1);
  assert.equal(b!.ratedCount, 0);
  assert.equal(b!.avgHumanRating, null);
  assert.equal(b!.hallucinationRate, 0);
});

test("cleanup: remove only rows created here + restore Setting + close server", async () => {
  await prisma.aiRegressionRun.deleteMany({
    where: { id: { in: createdRuns } },
  });
  await prisma.aiRegressionCase.deleteMany({
    where: { id: { in: createdCases } },
  });
  await prisma.aiSample.deleteMany({
    where: { id: { in: createdSamples } },
  });
  await prisma.aiCostMetric.deleteMany({
    where: { module: { in: [MOD_A, MOD_B] } },
  });

  if (settingExisted) {
    await prisma.setting.update({
      where: { key: AI_PROVIDERS_SETTING_KEY },
      data: { value: savedSetting },
    });
  } else {
    await prisma.setting
      .delete({ where: { key: AI_PROVIDERS_SETTING_KEY } })
      .catch(() => {});
  }

  await prisma.auditLog.deleteMany({ where: { userId: REVIEWER_ID } });
  await prisma.user.delete({ where: { id: REVIEWER_ID } }).catch(() => {});

  await new Promise<void>((r) => server.close(() => r()));

  const leftSamples = await prisma.aiSample.count({
    where: { id: { in: createdSamples } },
  });
  const leftCases = await prisma.aiRegressionCase.count({
    where: { module: { in: [MOD_A, MOD_B] } },
  });
  assert.equal(leftSamples, 0);
  assert.equal(leftCases, 0);
  await prisma.$disconnect();
});
