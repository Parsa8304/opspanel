import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  chooseStrategyGuard,
  preflight,
  runMigration,
  rollbackMigration,
  commitMigration,
  redisKeyFingerprint,
  MigrationRefusedError,
  PreflightError,
} from "../src/lib/migration";

/**
 * Section 17 — REAL integration test (NOT mocked).
 *
 * Uses a REAL Postgres on :5544 (the panel DB, MigrationPlan/Host rows),
 * a REAL redis:7-alpine container with REAL volume + REAL keys, and REAL
 * docker volume tar in/out. Proves:
 *  (a) the migrated redis key-set is IDENTICAL after a real snapshot
 *      migration (zero loss),
 *  (b) snapshot is REFUSED for an active-write DB with the documented
 *      reason and the target is left untouched,
 *  (c) preflight blocks an unreachable/invalid target,
 *  (d) real rollback (target stopped, source intact, status rolled_back)
 *      and a commit path reaches status committed.
 *
 * Reuses ONLY images already present locally (redis:7-alpine). No heavy
 * pulls. Cleans up every container/volume/temp/DB row it creates.
 */

const prisma = new PrismaClient();
const REDIS_IMAGE = "redis:7-alpine";
const SRC_CONTAINER = "panel-mig-test-redis";
const SRC_VOLUME = "panel-mig-test-redis-data";
const SRC_HOST = "panel-mig-test-src";
const TGT_HOST = "panel-mig-test-tgt";
const DEAD_HOST = "panel-mig-test-dead";

let tmp = "";
const createdPlanIds: string[] = [];
const createdVolumes = new Set<string>([SRC_VOLUME]);

function sh(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
}
function trySh(args: string[]) {
  try {
    return sh(args);
  } catch {
    return "";
  }
}
function targetVolOf(plan: { restorePoint: string | null }): string {
  return (JSON.parse(plan.restorePoint ?? "{}").targetVolumes ?? {})[SRC_VOLUME];
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "panel-mig-"));

  // Clean any leftovers from a previous interrupted run.
  trySh(["rm", "-f", SRC_CONTAINER, `${SRC_CONTAINER}-mig`]);
  trySh(["volume", "rm", "-f", SRC_VOLUME]);

  // ---- REAL redis container with a REAL named volume ----
  sh(["volume", "create", SRC_VOLUME]);
  sh([
    "run",
    "-d",
    "--name",
    SRC_CONTAINER,
    "-v",
    `${SRC_VOLUME}:/data`,
    REDIS_IMAGE,
    "redis-server",
    "--appendonly",
    "no",
    "--save",
    "",
  ]);
  // Wait for redis to accept connections (real probe, no fixed sleep).
  for (let i = 0; i < 50; i++) {
    if (trySh(["exec", SRC_CONTAINER, "redis-cli", "PING"]).includes("PONG")) break;
    execFileSync("sh", ["-c", "sleep 0.1"]);
  }
  // Seed REAL keys, then force a real RDB dump onto the volume.
  for (let i = 0; i < 200; i++) {
    sh(["exec", SRC_CONTAINER, "redis-cli", "SET", `k:${i}`, `v:${i}`]);
  }
  sh(["exec", SRC_CONTAINER, "redis-cli", "SAVE"]);

  // ---- Hosts in REAL Postgres ----
  // TGT_HOST points at the live panel Postgres (:5544) so it is genuinely
  // reachable for the good-path tests. DEAD_HOST points at a port that is
  // definitively closed (connection refused) — a deterministically
  // unreachable/invalid target the preflight must block. (An unroutable IP
  // is NOT used because this host's kernel/router accepts the SYN for
  // RFC5737/private ranges, which would make the probe non-deterministic.)
  const portFor = (n: string) =>
    n === TGT_HOST ? 5544 : n === DEAD_HOST ? 59999 : 22;
  for (const [name, address] of [
    [SRC_HOST, "127.0.0.1"],
    [TGT_HOST, "127.0.0.1"],
    [DEAD_HOST, "127.0.0.1"], // :59999 is closed → connection refused
  ] as const) {
    await prisma.host.upsert({
      where: { name },
      create: { name, address, sshPort: portFor(name), isLocal: true },
      update: { address, sshPort: portFor(name) },
    });
  }
});

test("guard: snapshot is REFUSED for an active-write redis DB (documented reason)", () => {
  let err: MigrationRefusedError | null = null;
  try {
    chooseStrategyGuard({
      strategy: "snapshot",
      service: "redis",
      image: "redis:7-alpine",
      activeWrites: true,
    });
  } catch (e) {
    err = e as MigrationRefusedError;
  }
  assert.ok(err instanceof MigrationRefusedError, "must throw MigrationRefusedError");
  assert.equal(err!.reason, "snapshot_active_write_db");
  assert.match(err!.message, /permanently\s+LOST/i);
  assert.match(err!.message, /Use 'replicate'.*or.*'dump_restore'/is);

  // Sanity: a NON-active redis is allowed (cold maintenance window).
  assert.doesNotThrow(() =>
    chooseStrategyGuard({
      strategy: "snapshot",
      service: "redis",
      image: "redis:7-alpine",
      activeWrites: false,
    })
  );
});

test("run via API path is refused for active-write DB; target untouched", async () => {
  const plan = await prisma.migrationPlan.create({
    data: {
      sourceHostName: SRC_HOST,
      targetHostName: TGT_HOST,
      service: SRC_CONTAINER,
      volumes: [SRC_VOLUME],
      strategy: "snapshot",
      status: "preflight",
    },
  });
  createdPlanIds.push(plan.id);

  await assert.rejects(
    () => runMigration(plan.id, { activeWrites: true }),
    (e: any) => e instanceof MigrationRefusedError && e.reason === "snapshot_active_write_db"
  );

  // PROOF target untouched: no target volume / no target container created.
  const vols = trySh(["volume", "ls", "--format", "{{.Name}}"]);
  assert.ok(
    !vols.split("\n").some((v) => v.startsWith(`${SRC_VOLUME}-mig-`)),
    "no target volume was provisioned by the refused migration"
  );
  assert.ok(
    !trySh(["ps", "-a", "--format", "{{.Names}}"]).includes(`${SRC_CONTAINER}-mig`),
    "no target container created"
  );
  const after = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  assert.notEqual(after!.status, "completed");
});

test("preflight BLOCKS an unreachable/invalid target", async () => {
  const plan = await prisma.migrationPlan.create({
    data: {
      sourceHostName: SRC_HOST,
      targetHostName: DEAD_HOST,
      service: SRC_CONTAINER,
      volumes: [SRC_VOLUME],
      strategy: "snapshot",
      status: "planned",
    },
  });
  createdPlanIds.push(plan.id);

  await assert.rejects(
    () => preflight(plan.id),
    (e: any) =>
      e instanceof PreflightError && /unreachable|invalid|dead target/i.test(e.message)
  );
  const after = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  assert.equal(after!.status, "failed");
  const pf = after!.preflight as any;
  assert.equal(pf.checks.find((c: any) => c.name === "target_reachable").ok, false);
});

test("snapshot migration: redis key-set IDENTICAL after real migration (zero loss)", async () => {
  // Source NOT taking writes now (operator-acknowledged cold window): allowed.
  const before = await redisKeyFingerprint(SRC_CONTAINER);
  assert.equal(before.length, 200, "200 seeded keys present on source");

  const plan = await prisma.migrationPlan.create({
    data: {
      sourceHostName: SRC_HOST,
      targetHostName: TGT_HOST,
      service: SRC_CONTAINER,
      volumes: [SRC_VOLUME],
      strategy: "snapshot",
      status: "preflight",
    },
  });
  createdPlanIds.push(plan.id);

  await runMigration(plan.id, { activeWrites: false, simulateSameDaemon: true });

  const done = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  assert.equal(done!.status, "completed");
  const targetVol = targetVolOf(done!);
  createdVolumes.add(targetVol);

  // Mount the migrated target volume into a fresh redis and read its key-set.
  const verifyName = `${SRC_CONTAINER}-verify`;
  trySh(["rm", "-f", verifyName]);
  sh([
    "run",
    "-d",
    "--name",
    verifyName,
    "-v",
    `${targetVol}:/data`,
    REDIS_IMAGE,
    "redis-server",
    "--appendonly",
    "no",
    "--save",
    "",
  ]);
  try {
    for (let i = 0; i < 50; i++) {
      if (trySh(["exec", verifyName, "redis-cli", "PING"]).includes("PONG")) break;
      execFileSync("sh", ["-c", "sleep 0.1"]);
    }
    const migrated = await redisKeyFingerprint(verifyName);
    // THE PROOF: identical sorted key-sets, zero loss.
    assert.deepEqual(
      migrated,
      before,
      "migrated redis key-set must be IDENTICAL to source (zero loss)"
    );
    assert.equal(migrated.length, 200);
    // Spot-check a value survived intact.
    const v = sh(["exec", verifyName, "redis-cli", "GET", "k:123"]).trim();
    assert.equal(v, "v:123");
  } finally {
    trySh(["rm", "-f", verifyName]);
  }

  // Source still serving (restarted) — restore point intact.
  const srcKeys = await redisKeyFingerprint(SRC_CONTAINER);
  assert.equal(srcKeys.length, 200, "source keeps serving after migration");
});

test("real rollback: target dropped, source intact, status rolled_back", async () => {
  const plan = await prisma.migrationPlan.create({
    data: {
      sourceHostName: SRC_HOST,
      targetHostName: TGT_HOST,
      service: SRC_CONTAINER,
      volumes: [SRC_VOLUME],
      strategy: "snapshot",
      status: "preflight",
    },
  });
  createdPlanIds.push(plan.id);
  await runMigration(plan.id, { activeWrites: false, simulateSameDaemon: true });
  const mid = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  const tv = targetVolOf(mid!);
  createdVolumes.add(tv);
  assert.ok(trySh(["volume", "inspect", tv]).length > 0, "target volume exists pre-rollback");

  await rollbackMigration(plan.id);

  const after = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  assert.equal(after!.status, "rolled_back");
  // Target volume dropped.
  assert.equal(trySh(["volume", "inspect", tv]), "", "target volume removed by rollback");
  // Source data intact and serving.
  const srcKeys = await redisKeyFingerprint(SRC_CONTAINER);
  assert.equal(srcKeys.length, 200, "source data intact after rollback");
  // Cannot roll back twice silently into a committed state etc.
  await assert.rejects(() => commitMigration(plan.id), /must be 'completed'/);
});

test("commit path: completed migration reaches status committed", async () => {
  const plan = await prisma.migrationPlan.create({
    data: {
      sourceHostName: SRC_HOST,
      targetHostName: TGT_HOST,
      service: SRC_CONTAINER,
      volumes: [SRC_VOLUME],
      strategy: "snapshot",
      status: "preflight",
    },
  });
  createdPlanIds.push(plan.id);
  await runMigration(plan.id, { activeWrites: false, simulateSameDaemon: true });
  const mid = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  createdVolumes.add(targetVolOf(mid!));

  await commitMigration(plan.id);
  const after = await prisma.migrationPlan.findUnique({ where: { id: plan.id } });
  assert.equal(after!.status, "committed");
  // A committed migration refuses rollback.
  await assert.rejects(
    () => rollbackMigration(plan.id),
    (e: any) => e instanceof MigrationRefusedError && e.reason === "already_committed"
  );
});

after(async () => {
  // Containers
  trySh(["rm", "-f", SRC_CONTAINER, `${SRC_CONTAINER}-mig`, `${SRC_CONTAINER}-verify`]);
  // Volumes (source + every provisioned target volume)
  for (const v of createdVolumes) trySh(["volume", "rm", "-f", v]);
  // Any stray *-mig-* target volumes from this run
  const vols = trySh(["volume", "ls", "--format", "{{.Name}}"]);
  for (const v of vols.split("\n")) {
    if (v.startsWith(`${SRC_VOLUME}-mig-`)) trySh(["volume", "rm", "-f", v]);
  }
  // NOTE: we do NOT remove redis:7-alpine — it was already local and is reused.

  // DB rows
  for (const id of createdPlanIds) {
    await prisma.migrationPlan.deleteMany({ where: { id } }).catch(() => {});
  }
  await prisma.host
    .deleteMany({ where: { name: { in: [SRC_HOST, TGT_HOST, DEAD_HOST] } } })
    .catch(() => {});
  await prisma.auditLog
    .deleteMany({ where: { action: { startsWith: "migration." } } })
    .catch(() => {});
  await prisma.alertEvent
    .deleteMany({ where: { source: "migration" } })
    .catch(() => {});

  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await prisma.$disconnect();
});
