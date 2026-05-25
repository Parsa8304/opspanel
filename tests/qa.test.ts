import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { effectiveStatus, isStale, withEffective } from "../src/lib/qa";

const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-05-19T12:00:00.000Z");

// Track ids we create so we never touch the seeded rows.
const createdReg: string[] = [];
const createdCov: string[] = [];

test("HONESTY: item verified 40 days ago with 30d window is STALE", async () => {
  const fortyDaysAgo = new Date(now.getTime() - 40 * DAY);
  const item = await prisma.regressionItem.create({
    data: {
      module: "LOGIN",
      title: "qa-test stale item",
      environment: "DEMO",
      status: "PASSING", // stored PASSING — must NOT be trusted
      lastVerifiedAt: fortyDaysAgo,
      staleAfterDays: 30,
    },
  });
  createdReg.push(item.id);

  assert.equal(
    effectiveStatus(item, now),
    "STALE",
    "stale-by-age must override stored PASSING"
  );
  assert.equal(isStale(item, now), true);
  const dec = withEffective(item, now);
  assert.equal(dec.effectiveStatus, "STALE");
  assert.equal(dec.isStale, true);
});

test("HONESTY: never-verified item is STALE", async () => {
  const item = await prisma.regressionItem.create({
    data: {
      module: "STORAGE",
      title: "qa-test never verified",
      environment: "STAGING",
      status: "PASSING",
      lastVerifiedAt: null,
      staleAfterDays: 30,
    },
  });
  createdReg.push(item.id);
  assert.equal(effectiveStatus(item, now), "STALE");
});

test("item verified today as PASSING resolves PASSING", async () => {
  const item = await prisma.regressionItem.create({
    data: {
      module: "SEARCH",
      title: "qa-test fresh passing",
      environment: "OPERATIONAL",
      status: "PASSING",
      lastVerifiedAt: now,
      staleAfterDays: 30,
    },
  });
  createdReg.push(item.id);
  assert.equal(effectiveStatus(item, now), "PASSING");
  assert.equal(isStale(item, now), false);
});

test("fresh FAILING stays FAILING", async () => {
  const item = await prisma.regressionItem.create({
    data: {
      module: "WEBSOCKET",
      title: "qa-test fresh failing",
      environment: "DEMO",
      status: "FAILING",
      lastVerifiedAt: new Date(now.getTime() - 5 * DAY),
      staleAfterDays: 30,
    },
  });
  createdReg.push(item.id);
  assert.equal(effectiveStatus(item, now), "FAILING");
});

test("evidence can be attached and read back", async () => {
  const item = await prisma.regressionItem.create({
    data: {
      module: "DEPLOYMENT",
      title: "qa-test evidence item",
      environment: "DEMO",
      status: "STALE",
    },
  });
  createdReg.push(item.id);

  await prisma.evidence.create({
    data: {
      regressionItemId: item.id,
      type: "SCREENSHOT",
      url: "https://example.com/shot.png",
      label: "login screen",
    },
  });

  const reloaded = await prisma.regressionItem.findUnique({
    where: { id: item.id },
    include: { evidence: true },
  });
  assert.ok(reloaded);
  assert.equal(reloaded!.evidence.length, 1);
  assert.equal(reloaded!.evidence[0].type, "SCREENSHOT");
  assert.equal(reloaded!.evidence[0].url, "https://example.com/shot.png");
  assert.equal(reloaded!.evidence[0].label, "login screen");
});

test("coverage item transitions NOT_STARTED -> IN_PROGRESS -> DONE and persists", async () => {
  const c = await prisma.coverageItem.create({
    data: {
      title: "qa-test coverage gap",
      area: "billing",
      status: "NOT_STARTED",
    },
  });
  createdCov.push(c.id);
  assert.equal(c.status, "NOT_STARTED");

  await prisma.coverageItem.update({
    where: { id: c.id },
    data: { status: "IN_PROGRESS" },
  });
  let r = await prisma.coverageItem.findUnique({ where: { id: c.id } });
  assert.equal(r!.status, "IN_PROGRESS");

  await prisma.coverageItem.update({
    where: { id: c.id },
    data: { status: "DONE" },
  });
  r = await prisma.coverageItem.findUnique({ where: { id: c.id } });
  assert.equal(r!.status, "DONE", "DONE must be persisted");
});

test("cleanup: remove only rows created by this test", async () => {
  await prisma.evidence.deleteMany({
    where: { regressionItemId: { in: createdReg } },
  });
  await prisma.regressionItem.deleteMany({
    where: { id: { in: createdReg } },
  });
  await prisma.coverageItem.deleteMany({
    where: { id: { in: createdCov } },
  });

  const leftReg = await prisma.regressionItem.count({
    where: { id: { in: createdReg } },
  });
  const leftCov = await prisma.coverageItem.count({
    where: { id: { in: createdCov } },
  });
  assert.equal(leftReg, 0);
  assert.equal(leftCov, 0);

  // Sanity: seeded data still intact.
  const seeded = await prisma.regressionItem.count();
  assert.ok(seeded >= 17, `expected seeded items to remain, got ${seeded}`);

  await prisma.$disconnect();
});
