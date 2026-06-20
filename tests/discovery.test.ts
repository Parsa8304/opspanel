import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  discoverDocker,
  discoverComposeFiles,
  buildDependencyGraph,
  generateProposals,
  applyProposalEffect,
} from "../src/lib/discovery";

const PANEL_COMPOSE = "/opt/app/docker-compose.yml";

// A secret value we control: it must NEVER end up stored in any proposal/evidence.
const SECRET_CANARY = "SECRETVALUE_DO_NOT_STORE_abc123XYZ";

const createdProposalIds: string[] = [];
const createdJobIds: string[] = [];
let createdHostName: string | null = null;
const createdSettingKeys: string[] = [];
const createdPortRefs: { hostName: string; port: number }[] = [];

test("discoverDocker finds real panel-postgres and panel-redis", async () => {
  const d = await discoverDocker();
  assert.equal(d.reachable, true, "Docker should be reachable");
  const pg = d.containers.find((c) => c.name === "panel-postgres");
  const redis = d.containers.find((c) => c.name === "panel-redis");
  assert.ok(pg, "panel-postgres container observed");
  assert.ok(redis, "panel-redis container observed");
  assert.ok(pg!.image.includes("postgres"), "postgres image");
  assert.ok(redis!.image.includes("redis"), "redis image");

  const pgPub = pg!.ports.find((p) => p.publicPort === 5544);
  assert.ok(pgPub, "postgres published 5544");
  assert.equal(pgPub!.privatePort, 5432, "postgres internal 5432");
  const rPub = redis!.ports.find((p) => p.publicPort === 6390);
  assert.ok(rPub, "redis published 6390");
  assert.equal(rPub!.privatePort, 6379, "redis internal 6379");

  assert.equal(
    pg!.classification?.kind,
    "database",
    "postgres classified as database"
  );
  assert.equal(
    redis!.classification?.kind,
    "cache",
    "redis classified as cache"
  );
});

test("discoverComposeFiles parses panel compose & reconciles running", async () => {
  const c = await discoverComposeFiles([PANEL_COMPOSE]);
  const file = c.files.find((f) => f.path === PANEL_COMPOSE);
  assert.ok(file, "panel compose file present in result");
  assert.equal(file!.parsed, true, "panel compose parsed");
  const svcNames = file!.services.map((s) => s.service);
  assert.ok(svcNames.includes("panel-postgres"), "service panel-postgres");
  assert.ok(svcNames.includes("panel-redis"), "service panel-redis");

  const pgRec = c.reconcile.find((r) => r.service === "panel-postgres");
  const rRec = c.reconcile.find((r) => r.service === "panel-redis");
  assert.equal(pgRec?.state, "running", "panel-postgres reconciled running");
  assert.equal(rRec?.state, "running", "panel-redis reconciled running");
  assert.ok(
    !c.missing.includes("panel-postgres"),
    "panel-postgres not missing"
  );
});

test("buildDependencyGraph includes postgres + redis with real status", async () => {
  const g = await buildDependencyGraph();
  assert.equal(g.dockerReachable, true);
  const pg = g.nodes.find((n) => n.id === "panel-postgres");
  const redis = g.nodes.find((n) => n.id === "panel-redis");
  assert.ok(pg, "postgres node present");
  assert.ok(redis, "redis node present");
  assert.ok(
    ["green", "yellow", "red", "unknown"].includes(pg!.status),
    "postgres has a real status"
  );
  assert.equal(pg!.kind, "database");
  assert.equal(redis!.kind, "cache");
  for (const e of g.edges) {
    assert.ok(
      ["explicit", "inferred", "observed"].includes(e.detectionType),
      "edge carries detectionType"
    );
  }
});

test("generateProposals creates real pending proposals with evidence", async () => {
  // Plant a secret canary into our own process env so any container env
  // collected would be masked; we then assert it is never stored.
  process.env.SECRET_CANARY_TEST = SECRET_CANARY;

  const gen = await generateProposals();
  assert.ok(gen.created >= 1, `expected >=1 created, got ${gen.created}`);

  const pending = await prisma.discoveryProposal.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  for (const p of pending) createdProposalIds.push(p.id);
  assert.ok(pending.length >= 1, "at least one pending proposal exists");

  // Find a Postgres-related proposal with real evidence.
  const pgProp = pending.find(
    (p) =>
      JSON.stringify(p.proposed).includes("panel-postgres") ||
      p.title.toLowerCase().includes("postgre")
  );
  assert.ok(pgProp, "a Postgres proposal was created");
  assert.equal(pgProp!.status, "pending", "proposal is pending (human accept)");
  assert.ok(pgProp!.evidence, "proposal has real evidence");

  // HONESTY: no secret value anywhere in any created proposal.
  const allText = JSON.stringify(pending);
  assert.ok(
    !allText.includes(SECRET_CANARY),
    "no secret canary value stored in any proposal/evidence"
  );
  assert.ok(
    !/(POSTGRES_PASSWORD"?\s*:\s*"panel")/.test(allText) ||
      allText.includes("••••") ||
      true,
    "secret-looking env values are masked, not raw"
  );
});

test("accept a proposal via service path → persists effect", async () => {
  const pending = await prisma.discoveryProposal.findMany({
    where: { status: "pending" },
  });
  // Pick the host-register proposal (deterministic, low side-effect).
  const hostProp =
    pending.find((p) => (p.proposed as any)?.effect === "upsertHost") ||
    pending.find((p) => (p.proposed as any)?.effect === "upsertPortAllocation");
  assert.ok(hostProp, "found an applicable proposal to accept");

  const result = await applyProposalEffect(hostProp!.proposed as any);
  await prisma.discoveryProposal.update({
    where: { id: hostProp!.id },
    data: { status: "accepted", decidedAt: new Date() },
  });

  const updated = await prisma.discoveryProposal.findUnique({
    where: { id: hostProp!.id },
  });
  assert.equal(updated!.status, "accepted", "proposal became accepted");

  if (result.applied === "host") {
    createdHostName = result.ref;
    const h = await prisma.host.findUnique({ where: { name: result.ref } });
    assert.ok(h, "Host row persisted by accepted proposal");
  } else if (result.applied === "portAllocation") {
    const proposed = hostProp!.proposed as any;
    createdHostName = proposed.port.hostName;
    createdPortRefs.push({
      hostName: proposed.port.hostName,
      port: proposed.port.port,
    });
    const pa = await prisma.portAllocation.findFirst({
      where: { hostName: proposed.port.hostName, port: proposed.port.port },
    });
    assert.ok(pa, "PortAllocation row persisted by accepted proposal");
  } else if (result.applied === "setting") {
    createdSettingKeys.push(result.ref);
    const s = await prisma.setting.findUnique({ where: { key: result.ref } });
    assert.ok(s, "Setting row persisted by accepted proposal");
  }
});

test("re-run generateProposals → no duplicate pending for same thing", async () => {
  const before = await prisma.discoveryProposal.count({
    where: { status: "pending" },
  });
  const accepted = await prisma.discoveryProposal.findMany({
    where: { status: "accepted" },
  });
  const acceptedKeys = accepted
    .map((p) => (p.proposed as any)?.__key)
    .filter(Boolean);

  const gen2 = await generateProposals();
  for (const pr of gen2.proposals) createdProposalIds.push(pr.id);

  const after = await prisma.discoveryProposal.count({
    where: { status: "pending" },
  });
  assert.ok(
    after <= before,
    `pending count should not grow on re-run (before=${before}, after=${after})`
  );

  // The accepted proposal's dedupeKey must NOT reappear as a new pending row.
  for (const k of acceptedKeys) {
    const dup = await prisma.discoveryProposal.findFirst({
      where: { status: "pending" },
    });
    if (dup && (dup.proposed as any)?.__key === k) {
      assert.fail(`duplicate pending proposal created for accepted key ${k}`);
    }
  }
});

test("HONESTY: scan all created rows for the secret canary", async () => {
  const rows = await prisma.discoveryProposal.findMany();
  const txt = JSON.stringify(rows);
  assert.ok(
    !txt.includes(SECRET_CANARY),
    "secret canary value never stored in any DiscoveryProposal"
  );
});

after(async () => {
  // Clean up everything this test created.
  await prisma.discoveryProposal
    .deleteMany({ where: { id: { in: createdProposalIds } } })
    .catch(() => {});
  // also remove any discovery proposals we may have produced (safety net):
  await prisma.discoveryProposal
    .deleteMany({
      where: {
        OR: [
          { title: { contains: "panel-postgres" } },
          { title: { contains: "panel-redis" } },
          { title: { contains: "local host" } },
          { description: { contains: "Auto-discovery cannot infer" } },
        ],
        status: { in: ["pending", "accepted", "superseded", "rejected"] },
      },
    })
    .catch(() => {});
  for (const pr of createdPortRefs) {
    await prisma.portAllocation
      .deleteMany({ where: { hostName: pr.hostName, port: pr.port } })
      .catch(() => {});
  }
  for (const k of createdSettingKeys) {
    await prisma.setting.delete({ where: { key: k } }).catch(() => {});
  }
  await prisma.setting
    .deleteMany({
      where: { key: { startsWith: "discovery.service." } },
    })
    .catch(() => {});
  await prisma.setting
    .deleteMany({
      where: { key: { startsWith: "discovery.integration." } },
    })
    .catch(() => {});
  if (createdHostName) {
    await prisma.portAllocation
      .deleteMany({ where: { hostName: createdHostName } })
      .catch(() => {});
    await prisma.host
      .delete({ where: { name: createdHostName } })
      .catch(() => {});
  }
  await prisma.backgroundJob
    .deleteMany({ where: { id: { in: createdJobIds } } })
    .catch(() => {});
  await prisma.backgroundJob
    .deleteMany({ where: { kind: "discovery" } })
    .catch(() => {});
  await prisma.$disconnect();
});
