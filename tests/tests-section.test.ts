import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  parseJunit,
  ingestJunit,
  computeFlaky,
  inferType,
} from "../src/lib/junit";

const prisma = new PrismaClient();

const createdRuns: string[] = [];

// A realistic JUnit XML: two classnames, passed/failed/skipped, failure
// message + traceback inside CDATA, and an explicit type attribute.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="suite" time="3.5">
  <testsuite name="auth.integration" tests="3" failures="1" skipped="1" time="2.0">
    <testcase classname="auth.IntegrationLoginTest" name="logs in with valid creds" time="0.42"/>
    <testcase classname="auth.IntegrationLoginTest" name="rejects bad password" time="0.30">
      <failure message="AssertionError: expected 401 got 200" type="AssertionError"><![CDATA[
Traceback (most recent call last):
  File "auth_test.py", line 42, in rejects_bad_password
    assert resp.status == 401
AssertionError: expected 401 got 200
]]></failure>
    </testcase>
    <testcase classname="auth.IntegrationLoginTest" name="mfa flow (pending)" time="0">
      <skipped/>
    </testcase>
  </testsuite>
  <testsuite name="ui.frontend" tests="2" failures="0" time="1.5">
    <testcase classname="ui.RenderTest" name="renders the dashboard component" time="1.10" type="FRONTEND"/>
    <testcase classname="ui.RenderTest" name="renders empty state" time="0.40"/>
  </testsuite>
</testsuites>`;

test("inferType heuristics", () => {
  assert.equal(inferType("logs in", "auth.IntegrationLoginTest"), "INTEGRATION");
  assert.equal(inferType("renders component", "ui.RenderTest"), "FRONTEND");
  assert.equal(inferType("computes sum", "math.Calc"), "UNIT");
  assert.equal(inferType("e2e checkout", "shop"), "E2E");
  assert.equal(inferType("queue worker drains", "tasks"), "WORKER");
});

test("parseJunit parses counts, types and failure text correctly", () => {
  const run = parseJunit(XML);
  assert.equal(run.total, 5);
  assert.equal(run.passed, 3);
  assert.equal(run.failed, 1);
  assert.equal(run.skipped, 1);
  assert.ok(run.durationMs >= 3500, `durationMs=${run.durationMs}`);

  const fail = run.cases.find((c) => c.status === "FAILED")!;
  assert.equal(fail.name, "rejects bad password");
  assert.equal(fail.type, "INTEGRATION");
  assert.match(fail.failureMessage!, /expected 401 got 200/);
  assert.match(fail.failureTrace!, /Traceback \(most recent call last\)/);
  assert.match(fail.failureTrace!, /AssertionError: expected 401 got 200/);

  const skip = run.cases.find((c) => c.status === "SKIPPED")!;
  assert.equal(skip.name, "mfa flow (pending)");

  // Explicit type attribute overrides inference.
  const fe = run.cases.find((c) => c.name === "renders the dashboard component")!;
  assert.equal(fe.type, "FRONTEND");
});

test("ingestJunit persists run + cases via the API code path", async () => {
  const res = await ingestJunit(XML, {
    commitSha: "abc1234testsection",
    source: "test-suite",
  });
  createdRuns.push(res.id);
  assert.equal(res.total, 5);
  assert.equal(res.passed, 3);
  assert.equal(res.failed, 1);
  assert.equal(res.skipped, 1);

  const back = await prisma.testRun.findUnique({
    where: { id: res.id },
    include: { cases: true },
  });
  assert.ok(back);
  assert.equal(back!.commitSha, "abc1234testsection");
  assert.equal(back!.source, "test-suite");
  assert.equal(back!.cases.length, 5);

  const dbFail = back!.cases.find((c) => c.status === "FAILED")!;
  assert.match(dbFail.failureTrace!, /AssertionError: expected 401 got 200/);
  assert.equal(dbFail.type, "INTEGRATION");
});

test("flaky detection flags a test that was passing then fails", async () => {
  // Second run: the previously-passing 'logs in with valid creds' now fails.
  const XML2 = `<?xml version="1.0"?>
<testsuite name="auth.integration" tests="1" failures="1">
  <testcase classname="auth.IntegrationLoginTest" name="logs in with valid creds" time="0.50">
    <failure message="AssertionError: token missing"><![CDATA[boom]]></failure>
  </testcase>
</testsuite>`;
  const res2 = await ingestJunit(XML2, {
    commitSha: "def5678testsection",
    source: "test-suite",
  });
  createdRuns.push(res2.id);

  // Read back exactly the cases the API/flaky route would aggregate, scoped
  // to the two runs we created so we assert deterministically.
  const cases = await prisma.testCase.findMany({
    where: { testRunId: { in: createdRuns } },
    select: {
      name: true,
      status: true,
      testRun: { select: { startedAt: true } },
    },
  });
  const flaky = computeFlaky(cases as any);
  const entry = flaky.find((f) => f.name === "logs in with valid creds");
  assert.ok(entry, "expected the toggled test to be flagged flaky");
  assert.equal(entry!.passCount, 1);
  assert.equal(entry!.failCount, 1);
  assert.equal(entry!.flakiness, 0.5);

  // A test that only ever failed is NOT flaky.
  assert.equal(
    flaky.find((f) => f.name === "rejects bad password"),
    undefined
  );
});

test("cleanup: remove created TestRuns (cases cascade)", async () => {
  await prisma.testRun.deleteMany({ where: { id: { in: createdRuns } } });
  const left = await prisma.testRun.count({
    where: { id: { in: createdRuns } },
  });
  assert.equal(left, 0);
  const orphanCases = await prisma.testCase.count({
    where: { testRunId: { in: createdRuns } },
  });
  assert.equal(orphanCases, 0);
  await prisma.$disconnect();
});
