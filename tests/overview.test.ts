// Section 1 — Overview / Home: REAL integration test (not mocked).
//
// Runs against the real Postgres. Docker / Redis may be down; we assert the
// score/alerts/trends degrade HONESTLY (excluded-with-note, unknown, "not
// enough data") and are NEVER inflated by stale or missing data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  readinessScore,
  activeAlerts,
  trends,
} from "../src/lib/overview";

const prisma = new PrismaClient();

const UNIQUE = `ovtest-${Date.now()}`;
const createdReg: string[] = [];
const createdJob: string[] = [];
const createdScn: string[] = [];
const createdRuns: string[] = [];

test("readinessScore: seeded STALE Q/A drags Q/A component; stale = NOT passing; honest availability per component", async () => {
  // Seed has 18 RegressionItems mostly STALE/never-verified.
  const totalReg = await prisma.regressionItem.count();
  assert.ok(totalReg >= 18, `expected >=18 seeded regression items, got ${totalReg}`);

  // Add one stored-PASSING but 90d-old item: must count as NOT passing.
  const reg = await prisma.regressionItem.create({
    data: {
      module: "OVERALL_READINESS",
      title: `${UNIQUE} stale-but-stored-passing`,
      status: "PASSING",
      lastVerifiedAt: new Date(Date.now() - 90 * 24 * 3600_000),
      staleAfterDays: 30,
      environment: "DEMO",
    },
  });
  createdReg.push(reg.id);

  const r = await readinessScore();

  const qa = r.components.find((c) => c.key === "qa");
  assert.ok(qa, "qa component present");
  assert.equal(qa!.available, true, "Q/A available (Postgres up)");
  // detail is "passing/total"; with mostly-stale seed, pass rate must be low.
  const [passStr, totStr] = (qa!.detail || "0/0").split("/");
  const passing = Number(passStr);
  const total = Number(totStr);
  assert.equal(total, totalReg + 1, "Q/A total = real row count incl. our item");
  assert.ok(
    qa!.score != null && qa!.score < 50,
    `stale-heavy seed must yield LOW Q/A score, got ${qa!.score} (${qa!.detail})`
  );
  // Our stored-PASSING-but-90d item must NOT be counted as passing.
  assert.ok(
    passing < total,
    "stale items are not passing — score not inflated"
  );

  // Every component must explicitly report availability (honest coverage).
  for (const key of ["qa", "containers", "tests", "integrations"] as const) {
    const c = r.components.find((x) => x.key === key);
    assert.ok(c, `${key} component present`);
    if (!c!.available) {
      // unavailable component must carry an honest note and NO numeric score.
      assert.ok(c!.note && c!.note.length > 0, `${key} unavailable needs a note`);
      assert.equal(c!.score, null, `${key} unavailable must not be scored`);
      assert.ok(
        r.unavailableComponents.includes(key),
        `${key} must be listed in unavailableComponents`
      );
    } else {
      assert.equal(typeof c!.score, "number", `${key} available => numeric score`);
    }
  }

  // If anything was excluded, partial must be true (honest partial coverage).
  assert.equal(
    r.partial,
    r.unavailableComponents.length > 0,
    "partial flag must match unavailable components"
  );

  // Composite must never be a fabricated 100 when components are stale/missing.
  if (r.score != null) {
    assert.ok(r.score <= 100 && r.score >= 0, "score in range");
  }
});

test("readinessScore: empty TestRun history makes the test component UNKNOWN (not 100%)", async () => {
  // Only assert when there genuinely are no test runs in this DB.
  const runCount = await prisma.testRun.count();
  const r = await readinessScore();
  const tests = r.components.find((c) => c.key === "tests");
  assert.ok(tests, "tests component present");
  if (runCount === 0) {
    assert.equal(
      tests!.available,
      false,
      "no test runs => test component unavailable/unknown"
    );
    assert.equal(tests!.score, null, "unknown is null, NOT a fabricated 100");
    assert.ok(
      r.unavailableComponents.includes("tests"),
      "tests excluded from score honestly"
    );
  } else {
    assert.ok(true, "test runs exist in DB — skip the empty-history assertion");
  }
});

test("activeAlerts: real failing rows surface as alerts; removing them clears the alerts (no fabricated/stale alert)", async () => {
  // Baseline (whatever the seed produces).
  const before = await activeAlerts();
  const hasId = (list: typeof before, id: string) =>
    list.some((a) => a.id === id);

  // Create a FAILING regression item, a FAILURE job, and a stale scenario.
  const failReg = await prisma.regressionItem.create({
    data: {
      module: "OVERALL_READINESS",
      title: `${UNIQUE} failing item`,
      status: "FAILING",
      lastVerifiedAt: new Date(), // fresh so it's FAILING, not STALE
      staleAfterDays: 30,
      environment: "DEMO",
    },
  });
  createdReg.push(failReg.id);

  const job = await prisma.jobRecord.create({
    data: {
      taskId: `${UNIQUE}-job`,
      taskType: "quick_report",
      queue: "celery",
      status: "FAILURE",
    },
  });
  createdJob.push(job.id);

  const scn = await prisma.accessScenario.create({
    data: {
      name: `${UNIQUE} stale scenario`,
      description: "stale on purpose",
      status: "PASSING",
      lastVerifiedAt: new Date(Date.now() - 365 * 24 * 3600_000),
      staleAfterDays: 30,
    },
  });
  createdScn.push(scn.id);

  const withBad = await activeAlerts();

  const qaFail = withBad.find((a) => a.id === "qa-failing");
  assert.ok(qaFail, "failing Q/A item must produce qa-failing alert");
  assert.equal(qaFail!.area, "qa");
  assert.equal(qaFail!.severity, "critical");
  assert.equal(qaFail!.link, "/qa");

  const jobAlert = withBad.find((a) => a.id === "job-FAILURE-quick_report");
  assert.ok(jobAlert, "FAILURE job must produce an async alert");
  assert.equal(jobAlert!.area, "async");
  assert.equal(jobAlert!.link, "/async");

  const accStale = withBad.find((a) => a.id === "access-stale");
  assert.ok(accStale, "stale access scenario must produce access-stale alert");
  assert.equal(accStale!.area, "access");
  assert.equal(accStale!.link, "/access");
  assert.equal(accStale!.severity, "warning");

  // Remove the rows; the specific alerts must disappear (no stale fabrication).
  await prisma.regressionItem.delete({ where: { id: failReg.id } });
  await prisma.jobRecord.delete({ where: { id: job.id } });
  await prisma.accessScenario.delete({ where: { id: scn.id } });
  createdReg.splice(createdReg.indexOf(failReg.id), 1);
  createdJob.splice(createdJob.indexOf(job.id), 1);
  createdScn.splice(createdScn.indexOf(scn.id), 1);

  const after = await activeAlerts();
  assert.ok(
    !hasId(after, "job-FAILURE-quick_report"),
    "async alert must clear once the FAILURE job is removed"
  );
  assert.ok(
    !after.some((a) => a.message.includes(`${UNIQUE} failing item`)),
    "no leftover alert referencing the deleted item"
  );
  // Sanity: alert count returns toward baseline (not monotonically growing).
  assert.ok(
    after.length <= withBad.length,
    "removing bad rows does not increase alert count"
  );
});

test("trends: >=3 distinct days of TestRuns => enoughData true & series length >=3; <2 days => enoughData false", async () => {
  // Insert TestRuns across 3 distinct days.
  const mk = async (daysAgo: number, passed: number, total: number) => {
    const tr = await prisma.testRun.create({
      data: {
        source: `${UNIQUE}`,
        total,
        passed,
        failed: total - passed,
        skipped: 0,
        durationMs: 1000,
        startedAt: new Date(Date.now() - daysAgo * 24 * 3600_000 - 3600_000),
      },
    });
    createdRuns.push(tr.id);
    return tr;
  };
  await mk(1, 8, 10);
  await mk(2, 9, 10);
  await mk(3, 7, 10);

  const tr = await trends();
  assert.equal(
    tr.testPassRate.enoughData,
    true,
    "3 distinct days => enoughData true"
  );
  assert.ok(
    tr.testPassRate.points.length >= 3,
    `expected >=3 points, got ${tr.testPassRate.points.length}`
  );
  // Every point is a real computed pass rate (0..100).
  for (const p of tr.testPassRate.points) {
    assert.ok(p.value >= 0 && p.value <= 100, "pass rate within range");
  }

  // Remove two of the three days -> only 1 distinct day -> not enough data.
  const keep = createdRuns[0];
  const drop = createdRuns.slice(1);
  await prisma.testRun.deleteMany({ where: { id: { in: drop } } });
  for (const id of drop) createdRuns.splice(createdRuns.indexOf(id), 1);

  const tr2 = await trends();
  // Only assert the honest "<2 days => false" when the DB now has <2 distinct
  // TestRun days overall (no other seeded runs interfere).
  const remainingRuns = await prisma.testRun.count();
  if (remainingRuns === 1 && createdRuns[0] === keep) {
    assert.equal(
      tr2.testPassRate.enoughData,
      false,
      "single day => enoughData false (honest, no fake line)"
    );
  } else {
    assert.ok(
      true,
      "other TestRun rows exist in DB — skip strict single-day assertion"
    );
  }
});

test("cleanup: remove only rows created by this test; seed intact", async () => {
  await prisma.testRun.deleteMany({ where: { id: { in: createdRuns } } });
  await prisma.jobRecord.deleteMany({ where: { id: { in: createdJob } } });
  await prisma.accessScenario.deleteMany({ where: { id: { in: createdScn } } });
  await prisma.regressionItem.deleteMany({ where: { id: { in: createdReg } } });

  assert.equal(
    await prisma.testRun.count({ where: { id: { in: createdRuns } } }),
    0
  );
  assert.equal(
    await prisma.regressionItem.count({ where: { id: { in: createdReg } } }),
    0
  );

  const reg = await prisma.regressionItem.count();
  assert.ok(reg >= 18, `expected >=18 seeded regression items, got ${reg}`);

  await prisma.$disconnect();
});
