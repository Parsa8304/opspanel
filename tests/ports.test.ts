import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  scanLocalPorts,
  scanRemotePorts,
  reconcile,
  detectConflicts,
  publicFindings,
  nextFreePort,
  ensureHost,
  RemoteScanError,
  LOCAL_HOST,
} from "../src/lib/ports";

/**
 * Real integration test — NOT mocked. Runs against the REAL local host
 * (real ss/netstat + real Docker) and the REAL Postgres on :5544.
 */

const REMOTE_HOST = "ports-test-remote-nokey";
const FAKE_PRIOR_PORT = 59999; // unlikely to be a real listening port

test("scanLocalPorts returns real listening ports incl. docker-published 5544/6390", async () => {
  const observed = await scanLocalPorts();
  assert.ok(observed.length > 0, "expected at least one observed port");

  // Every entry must carry a real protocol and a non-empty interface.
  for (const o of observed) {
    assert.ok(
      o.protocol === "tcp" || o.protocol === "udp",
      `real protocol, got ${o.protocol}`
    );
    assert.ok(
      typeof o.iface === "string" && o.iface.length > 0,
      "non-empty interface"
    );
    assert.ok(Number.isInteger(o.port) && o.port > 0, "real port number");
  }

  // panel-postgres publishes 5544, panel-redis publishes 6390 on this host.
  const pg = observed.find((o) => o.port === 5544);
  const redis = observed.find((o) => o.port === 6390);
  assert.ok(pg, "docker-published Postgres port 5544 observed");
  assert.ok(redis, "docker-published Redis port 6390 observed");
  assert.equal(pg!.protocol, "tcp", "5544 is tcp");
  assert.equal(redis!.protocol, "tcp", "6390 is tcp");
  assert.ok(pg!.iface.length > 0, "5544 has a bound interface");
  assert.ok(redis!.iface.length > 0, "6390 has a bound interface");
});

test("reconcile persists rows, no duplicates on re-run, advances lastSeen, marks unseen stale (not deleted)", async () => {
  await ensureHost(LOCAL_HOST);

  // Inject a fake prior row that the real scan will NOT contain.
  const now0 = new Date(Date.now() - 60_000);
  await prisma.portAllocation.upsert({
    where: {
      serverId_hostName_port_protocol_iface: {
        serverId: "local",
        hostName: LOCAL_HOST,
        port: FAKE_PRIOR_PORT,
        protocol: "tcp",
        iface: "0.0.0.0",
      },
    },
    create: {
      hostName: LOCAL_HOST,
      port: FAKE_PRIOR_PORT,
      protocol: "tcp",
      iface: "0.0.0.0",
      serviceName: "fake-prior",
      discoveredVia: "manual",
      isPublic: true,
      status: "active",
      firstSeen: now0,
      lastSeen: now0,
    },
    update: { status: "active", lastSeen: now0 },
  });

  const observed = await scanLocalPorts();
  const r1 = await reconcile(LOCAL_HOST, observed);
  assert.ok(r1.upserted > 0, "rows upserted");

  const countAfter1 = await prisma.portAllocation.count({
    where: { hostName: LOCAL_HOST },
  });
  const sample = await prisma.portAllocation.findFirst({
    where: { hostName: LOCAL_HOST, port: 5544 },
  });
  assert.ok(sample, "PortAllocation row persisted for 5544");
  const lastSeen1 = sample!.lastSeen;

  // The injected fake prior row must now be STALE, not deleted.
  const stale = await prisma.portAllocation.findUnique({
    where: {
      serverId_hostName_port_protocol_iface: {
        serverId: "local",
        hostName: LOCAL_HOST,
        port: FAKE_PRIOR_PORT,
        protocol: "tcp",
        iface: "0.0.0.0",
      },
    },
  });
  assert.ok(stale, "fake prior row NOT deleted");
  assert.equal(stale!.status, "stale", "fake prior row marked stale");

  // Re-run: no duplicate rows (unique constraint honored), lastSeen advances.
  await new Promise((res) => setTimeout(res, 1100));
  const observed2 = await scanLocalPorts();
  await reconcile(LOCAL_HOST, observed2);
  const countAfter2 = await prisma.portAllocation.count({
    where: { hostName: LOCAL_HOST },
  });
  assert.equal(
    countAfter2,
    countAfter1,
    `no duplicate rows on re-run (was ${countAfter1}, now ${countAfter2})`
  );
  const sample2 = await prisma.portAllocation.findFirst({
    where: { hostName: LOCAL_HOST, port: 5544 },
  });
  assert.ok(
    sample2!.lastSeen.getTime() > lastSeen1.getTime(),
    "lastSeen advanced on re-scan"
  );
});

test("detectConflicts flags two different services on same host+port", async () => {
  await ensureHost(LOCAL_HOST);
  const now = new Date();
  // Two allocations, same port, different iface + different service.
  await prisma.portAllocation.upsert({
    where: {
      serverId_hostName_port_protocol_iface: {
        serverId: "local",
        hostName: LOCAL_HOST,
        port: 58881,
        protocol: "tcp",
        iface: "127.0.0.1",
      },
    },
    create: {
      hostName: LOCAL_HOST,
      port: 58881,
      protocol: "tcp",
      iface: "127.0.0.1",
      serviceName: "svc-alpha",
      discoveredVia: "manual",
      isPublic: false,
      status: "active",
      firstSeen: now,
      lastSeen: now,
    },
    update: { serviceName: "svc-alpha", status: "active" },
  });
  await prisma.portAllocation.upsert({
    where: {
      serverId_hostName_port_protocol_iface: {
        serverId: "local",
        hostName: LOCAL_HOST,
        port: 58881,
        protocol: "tcp",
        iface: "0.0.0.0",
      },
    },
    create: {
      hostName: LOCAL_HOST,
      port: 58881,
      protocol: "tcp",
      iface: "0.0.0.0",
      serviceName: "svc-beta",
      discoveredVia: "manual",
      isPublic: true,
      status: "active",
      firstSeen: now,
      lastSeen: now,
    },
    update: { serviceName: "svc-beta", status: "active" },
  });

  const conflicts = await detectConflicts(LOCAL_HOST);
  const hit = conflicts.find((c) => c.port === 58881);
  assert.ok(hit, "conflict detected on port 58881");
  const owners = hit!.claimants.map((c) => c.owner);
  assert.ok(
    owners.includes("svc-alpha") && owners.includes("svc-beta"),
    "both distinct services listed as claimants"
  );
});

test("publicFindings reports a 0.0.0.0-bound port (docker 5544)", async () => {
  const findings = await publicFindings(LOCAL_HOST);
  const pg = findings.find((f) => f.port === 5544);
  assert.ok(pg, "public finding for docker-published 5544");
  assert.ok(
    pg!.iface === "0.0.0.0" || pg!.iface === "::",
    `5544 bound to a wildcard interface (got ${pg!.iface})`
  );
  assert.ok(
    pg!.severity === "high" || pg!.severity === "medium",
    "severity assigned"
  );
});

test("nextFreePort returns an unallocated port in range", async () => {
  const free = await nextFreePort(LOCAL_HOST, 3000, 9000);
  assert.ok(free !== null, "a free port was found");
  assert.ok(free! >= 3000 && free! <= 9000, "free port within range");
  const taken = await prisma.portAllocation.findFirst({
    where: { hostName: LOCAL_HOST, port: free! },
  });
  assert.equal(taken, null, "suggested port is not currently allocated");
});

test("scanRemotePorts with no SSH key throws typed error and writes NO rows", async () => {
  await prisma.host.upsert({
    where: { name: REMOTE_HOST },
    create: {
      name: REMOTE_HOST,
      address: "203.0.113.10",
      sshUser: "root",
      sshPort: 22,
      sshKeyEnc: null,
      isLocal: false,
    },
    update: { sshKeyEnc: null },
  });

  const before = await prisma.portAllocation.count({
    where: { hostName: REMOTE_HOST },
  });

  await assert.rejects(
    () =>
      scanRemotePorts({
        name: REMOTE_HOST,
        address: "203.0.113.10",
        sshUser: "root",
        sshPort: 22,
        sshKeyEnc: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof RemoteScanError, "RemoteScanError thrown");
      assert.equal(
        (e as RemoteScanError).code,
        "NO_SSH_KEY",
        "honest NO_SSH_KEY code"
      );
      return true;
    }
  );

  const afterCount = await prisma.portAllocation.count({
    where: { hostName: REMOTE_HOST },
  });
  assert.equal(
    afterCount,
    before,
    "no PortAllocation rows fabricated for an unscannable remote host"
  );
});

after(async () => {
  await prisma.portAllocation
    .deleteMany({ where: { hostName: LOCAL_HOST } })
    .catch(() => {});
  await prisma.portAllocation
    .deleteMany({ where: { hostName: REMOTE_HOST } })
    .catch(() => {});
  await prisma.host
    .delete({ where: { name: REMOTE_HOST } })
    .catch(() => {});
  // Only remove the auto-created local host if WE created it (no real data
  // beyond this test). It is safe: this section owns the "local" host row.
  await prisma.host.delete({ where: { name: LOCAL_HOST } }).catch(() => {});
  await prisma.backgroundJob
    .deleteMany({ where: { kind: "portscan" } })
    .catch(() => {});
  await prisma.$disconnect();
});
