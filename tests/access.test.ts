import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import {
  signToken,
  verifyToken,
  hashPassword,
  atLeast,
  audit,
} from "../src/lib/auth";
import { canDeleteUser, canDemoteUser, withScenarioStatus } from "../src/lib/access";
import { isStale } from "../src/lib/qa";

const prisma = new PrismaClient();
const SECRET = process.env.JWT_SECRET || "dev-secret";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-05-19T12:00:00.000Z");

const createdUsers: string[] = [];
const createdAudit: string[] = [];
const createdScenarios: string[] = [];

test("real ENGINEER user: signToken/verifyToken round-trips; atLeast denies ADMIN, allows ENGINEER", async () => {
  const u = await prisma.user.create({
    data: {
      email: `acc-test-eng-${Date.now()}@example.com`,
      name: "Access Test Engineer",
      role: "ENGINEER",
      passwordHash: await hashPassword("admin1234"),
    },
  });
  createdUsers.push(u.id);

  const token = signToken({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
  });
  const decoded = verifyToken(token);
  assert.ok(decoded, "verifyToken must accept a freshly signed token");
  assert.equal(decoded!.id, u.id);
  assert.equal(decoded!.role, "ENGINEER");

  assert.equal(atLeast(decoded!.role, "ENGINEER"), true, "ENGINEER allowed");
  assert.equal(atLeast(decoded!.role, "ADMIN"), false, "ADMIN denied");
});

test("expired token (negative expiresIn) is rejected by verifyToken", async () => {
  const expired = jwt.sign(
    { id: "x", email: "x@x.com", name: "X", role: "ADMIN" },
    SECRET,
    { expiresIn: -10 }
  );
  assert.equal(
    verifyToken(expired),
    null,
    "an already-expired token must verify as null"
  );
});

test("cross-tenant style: audit filtering by userId returns only that user's rows", async () => {
  const a = await prisma.user.create({
    data: {
      email: `acc-test-a-${Date.now()}@example.com`,
      name: "User A",
      role: "READONLY",
      passwordHash: await hashPassword("admin1234"),
    },
  });
  const b = await prisma.user.create({
    data: {
      email: `acc-test-b-${Date.now()}@example.com`,
      name: "User B",
      role: "READONLY",
      passwordHash: await hashPassword("admin1234"),
    },
  });
  createdUsers.push(a.id, b.id);

  const la = await prisma.auditLog.create({
    data: { userId: a.id, action: "acc-test.action.a" },
  });
  const lb = await prisma.auditLog.create({
    data: { userId: b.id, action: "acc-test.action.b" },
  });
  createdAudit.push(la.id, lb.id);

  const onlyA = await prisma.auditLog.findMany({ where: { userId: a.id } });
  assert.ok(onlyA.length >= 1);
  assert.ok(
    onlyA.every((r) => r.userId === a.id),
    "filter by userId must not leak other users' entries"
  );
  assert.equal(
    onlyA.find((r) => r.id === lb.id),
    undefined,
    "User B's entry must not appear in User A's filter"
  );
});

test("scenario 45d old / 30d window is STALE; verifying PASSING now flips effective status", async () => {
  const eng = await prisma.user.create({
    data: {
      email: `acc-test-verifier-${Date.now()}@example.com`,
      name: "Verifier",
      role: "ENGINEER",
      passwordHash: await hashPassword("admin1234"),
    },
  });
  createdUsers.push(eng.id);

  const s = await prisma.accessScenario.create({
    data: {
      name: "acc-test stale scenario",
      description: "verified long ago",
      status: "PASSING", // stored PASSING must NOT be trusted
      lastVerifiedAt: new Date(now.getTime() - 45 * DAY),
      staleAfterDays: 30,
    },
  });
  createdScenarios.push(s.id);

  // Shared staleness helper (reused from qa.ts) marks it STALE.
  assert.equal(
    isStale(s, now),
    true,
    "45d-old with 30d window must be STALE via shared helper"
  );
  assert.equal(withScenarioStatus(s, now).effectiveStatus, "STALE");

  // Verify it PASSING now.
  const verified = await prisma.accessScenario.update({
    where: { id: s.id },
    data: {
      status: "PASSING",
      lastVerifiedAt: new Date(),
      verifiedById: eng.id,
    },
  });
  const decorated = withScenarioStatus(verified, new Date());
  assert.equal(decorated.effectiveStatus, "PASSING");
  assert.equal(decorated.isStale, false);
  assert.ok(verified.lastVerifiedAt);
  assert.equal(verified.verifiedById, eng.id);
});

test("last-admin guard: refuses to delete/demote the only ADMIN; allows non-last admin", async () => {
  const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
  assert.ok(adminCount >= 1, "seed should contain at least one ADMIN");

  const seededAdmin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
  });
  assert.ok(seededAdmin);

  if (adminCount === 1) {
    const del = await canDeleteUser(seededAdmin!.id);
    assert.equal(del.allowed, false);
    assert.equal(del.reason, "last_admin");
    const dem = await canDemoteUser(seededAdmin!.id, "ENGINEER");
    assert.equal(dem.allowed, false);
    assert.equal(dem.reason, "last_admin");
  }

  // Add a second admin: now the seeded one is deletable per the guard
  // (we do NOT actually delete it).
  const extraAdmin = await prisma.user.create({
    data: {
      email: `acc-test-admin2-${Date.now()}@example.com`,
      name: "Extra Admin",
      role: "ADMIN",
      passwordHash: await hashPassword("admin1234"),
    },
  });
  createdUsers.push(extraAdmin.id);

  const delNow = await canDeleteUser(seededAdmin!.id);
  assert.equal(
    delNow.allowed,
    true,
    "with 2 admins the guard must allow deleting one"
  );
  // And the extra admin itself is still deletable (other admin remains).
  const delExtra = await canDeleteUser(extraAdmin.id);
  assert.equal(delExtra.allowed, true);
});

test("audit() writes a real AuditLog row that the audit query returns", async () => {
  const u = await prisma.user.create({
    data: {
      email: `acc-test-auditor-${Date.now()}@example.com`,
      name: "Auditor",
      role: "ADMIN",
      passwordHash: await hashPassword("admin1234"),
    },
  });
  createdUsers.push(u.id);

  const marker = `acc-test.audit.${Date.now()}`;
  await audit(u.id, marker, "target-1", { foo: "bar" }, "127.0.0.1");

  const rows = await prisma.auditLog.findMany({
    where: { userId: u.id, action: marker },
    include: { user: { select: { name: true } } },
  });
  assert.equal(rows.length, 1, "audit() must persist exactly one real row");
  assert.equal(rows[0].target, "target-1");
  assert.deepEqual(rows[0].detail, { foo: "bar" });
  assert.equal(rows[0].ip, "127.0.0.1");
  assert.equal(rows[0].user?.name, "Auditor");
  createdAudit.push(rows[0].id);
});

test("cleanup: remove only rows created by this test; seeded data intact", async () => {
  await prisma.auditLog.deleteMany({ where: { id: { in: createdAudit } } });
  await prisma.auditLog.deleteMany({
    where: { userId: { in: createdUsers } },
  });
  await prisma.accessScenario.deleteMany({
    where: { id: { in: createdScenarios } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });

  const leftUsers = await prisma.user.count({
    where: { id: { in: createdUsers } },
  });
  const leftScen = await prisma.accessScenario.count({
    where: { id: { in: createdScenarios } },
  });
  assert.equal(leftUsers, 0);
  assert.equal(leftScen, 0);

  // Seeded data still present.
  const seededAdmin = await prisma.user.findUnique({
    where: { email: "admin@example.com" },
  });
  assert.ok(seededAdmin, "seeded admin must remain intact");
  const seededScenarios = await prisma.accessScenario.count();
  assert.ok(
    seededScenarios >= 4,
    `expected >=4 seeded access scenarios, got ${seededScenarios}`
  );

  await prisma.$disconnect();
});
