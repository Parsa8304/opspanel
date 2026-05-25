import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { PrismaClient } from "@prisma/client";
import { GIT_SETTING_KEY } from "../src/lib/git";
import {
  detectMigrations,
  runDeploy,
  rollback,
  DeployRefusedError,
  DEPLOY_SETTING_KEY,
} from "../src/lib/deploy";
import {
  ensureManagedProxy,
  stopManagedProxy,
} from "../src/lib/proxy";

/**
 * Section 16 — REAL integration test (NOT mocked).
 *
 * Uses: REAL Postgres on :5544, a REAL temp git repo, REAL docker containers
 * (a tiny python:3.11-slim http server image — already present locally, so no
 * pull), and the panel's REAL managed reverse proxy. Proves ZERO dropped
 * requests during a real blue/green container switch, REAL rollback on a
 * forced health failure, refuse rules, and migration classification.
 */

const prisma = new PrismaClient();

const PROXY_PORT = 8492;
const BASE_IMAGE = "python:3.11-slim";
const IMG_V1 = "panel-deploy-test:v1";
const IMG_V2 = "panel-deploy-test:v2";
const SVC = "deploytestapp";
const ENV = "DEV";

let tmp = "";
let gitDir = "";
let v1Sha = "";
let v2Sha = "";
let prevGitSetting: any = null;
let prevDeploySetting: any = null;
const createdRunIds: string[] = [];
const createdDeploymentIds: string[] = [];
const containerNames = [
  `panel-deploy-${ENV.toLowerCase()}-${SVC}-blue`,
  `panel-deploy-${ENV.toLowerCase()}-${SVC}-green`,
];

function sh(cmd: string, args: string[], opts: any = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
}

function rmContainers() {
  for (const n of containerNames) {
    try {
      sh("docker", ["rm", "-f", n]);
    } catch {
      /* not present */
    }
  }
}

test("setup: build tiny v1/v2 images, real git repo, settings", async () => {
  // ---- Build two tiny real images from a LOCAL base (no pull) ----
  const bctx = mkdtempSync(join(tmpdir(), "panel-deploy-img-"));
  for (const [img, ver] of [
    [IMG_V1, "v1"],
    [IMG_V2, "v2"],
  ] as const) {
    const app = `import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200); self.send_header("Content-Type","text/plain"); self.end_headers(); self.wfile.write(b"ok")
        else:
            self.send_response(200); self.send_header("Content-Type","text/plain"); self.end_headers(); self.wfile.write(b"${ver}")
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 8000), H).serve_forever()
`;
    writeFileSync(join(bctx, "app.py"), app);
    writeFileSync(
      join(bctx, "Dockerfile"),
      `FROM ${BASE_IMAGE}\nWORKDIR /app\nCOPY app.py .\nEXPOSE 8000\nCMD ["python","app.py"]\n`
    );
    sh("docker", ["build", "-t", img, bctx]);
  }
  rmSync(bctx, { recursive: true, force: true });

  // ---- Real temp git repo with two commits (v1 -> v2 incl. migrations) ----
  tmp = mkdtempSync(join(tmpdir(), "panel-deploy-git-"));
  gitDir = tmp;
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig("user.email", "test@panel.local");
  await g.addConfig("user.name", "Panel Test");
  await g.addConfig("commit.gpgsign", "false");

  // v1: an additive Django-style migration
  mkdirSync(join(tmp, "app", "migrations"), { recursive: true });
  writeFileSync(join(tmp, "app", "migrations", "__init__.py"), "");
  writeFileSync(
    join(tmp, "app", "migrations", "0001_initial.py"),
    "from django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [migrations.CreateModel(name='Thing', fields=[])]\n"
  );
  writeFileSync(join(tmp, "VERSION"), "v1\n");
  await g.add(".");
  await g.commit("v1");
  v1Sha = (await g.revparse(["HEAD"])).trim();

  // v2: an additive migration (safe path used by the zero-downtime test)
  writeFileSync(
    join(tmp, "app", "migrations", "0002_add_field.py"),
    "from django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [migrations.AddField(model_name='thing', name='note', field=models.TextField(null=True))]\n"
  );
  writeFileSync(join(tmp, "VERSION"), "v2\n");
  await g.add(".");
  await g.commit("v2");
  v2Sha = (await g.revparse(["HEAD"])).trim();

  // a destructive migration commit (used only by the refuse test)
  writeFileSync(
    join(tmp, "app", "migrations", "0003_drop.py"),
    "from django.db import migrations\nclass Migration(migrations.Migration):\n    operations = [migrations.RemoveField(model_name='thing', name='note')]\n"
  );
  await g.add(".");
  await g.commit("v3-destructive");

  // ---- Settings in REAL Postgres (preserve + restore) ----
  const g0 = await prisma.setting.findUnique({ where: { key: GIT_SETTING_KEY } });
  prevGitSetting = g0?.value ?? null;
  const d0 = await prisma.setting.findUnique({ where: { key: DEPLOY_SETTING_KEY } });
  prevDeploySetting = d0?.value ?? null;

  await prisma.setting.upsert({
    where: { key: GIT_SETTING_KEY },
    create: { key: GIT_SETTING_KEY, value: { provider: "local", repoPath: tmp } },
    update: { value: { provider: "local", repoPath: tmp } },
  });
  await prisma.setting.upsert({
    where: { key: DEPLOY_SETTING_KEY },
    create: {
      key: DEPLOY_SETTING_KEY,
      value: {
        proxyMode: "managed",
        proxyListenPort: PROXY_PORT,
        healthPath: "/health",
        healthConsecutive: 3,
        healthIntervalMs: 200,
        drainSec: 2,
        containerPort: 8000,
        statefulServices: ["postgres", "redis", "db"],
      },
    },
    update: {
      value: {
        proxyMode: "managed",
        proxyListenPort: PROXY_PORT,
        healthPath: "/health",
        healthConsecutive: 3,
        healthIntervalMs: 200,
        drainSec: 2,
        containerPort: 8000,
        statefulServices: ["postgres", "redis", "db"],
      },
    },
  });

  rmContainers();
});

test("detectMigrations classifies additive vs destructive from real git diff", async () => {
  const add = await detectMigrations(v1Sha, v2Sha);
  const addMig = add.find((m) => m.file.includes("0002_add_field"));
  assert.ok(addMig, "0002 migration detected");
  assert.equal(addMig!.destructive, false, "AddField is additive");
  assert.equal(addMig!.reversible, true);

  // v2 -> v3 introduces a RemoveField (destructive)
  const v3 = (await simpleGit(gitDir).revparse(["HEAD"])).trim();
  const destr = await detectMigrations(v2Sha, v3);
  const dropMig = destr.find((m) => m.file.includes("0003_drop"));
  assert.ok(dropMig, "0003 migration detected");
  assert.equal(dropMig!.destructive, true, "RemoveField is destructive");
  assert.equal(dropMig!.reversible, false);
});

test("refuse: stateful service is refused, no containers touched", async () => {
  await assert.rejects(
    () =>
      runDeploy(ENV as any, v2Sha, "redis", {
        image: IMG_V2,
        triggeredById: null,
      }),
    (e: any) => e instanceof DeployRefusedError && /stateful/i.test(e.message)
  );
  // No deploy container should exist for redis.
  const ps = sh("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  assert.ok(
    !ps.split("\n").some((n) => n.includes(`${SVC}-`) && n.includes("redis")),
    "no stateful deploy containers created"
  );
});

test("refuse: destructive migration without approval is refused", async () => {
  const v3 = (await simpleGit(gitDir).revparse(["HEAD"])).trim();
  // Seed a live v2 deployment so the plan diffs v2..v3 (destructive present).
  const live = await prisma.deployment.create({
    data: { environment: ENV as any, commitSha: v2Sha, version: "v2", status: "active" },
  });
  createdDeploymentIds.push(live.id);
  await assert.rejects(
    () =>
      runDeploy(ENV as any, v3, SVC, {
        image: IMG_V2,
        approveDestructive: false,
        maintenanceWindow: false,
        triggeredById: null,
      }),
    (e: any) => e instanceof DeployRefusedError && /destructive/i.test(e.message)
  );
  await prisma.deployment.delete({ where: { id: live.id } });
  createdDeploymentIds.splice(createdDeploymentIds.indexOf(live.id), 1);
});

async function waitRun(id: string, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await prisma.deployRun.findUnique({ where: { id } });
    if (r && ["SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"].includes(r.state))
      return r;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("deploy run did not finish in time");
}

test("ZERO-downtime blue/green switch v1 → v2 with continuous traffic", async () => {
  // Start v1 (blue) on a fixed port and put the managed proxy in front of it.
  const blueName = containerNames[0];
  sh("docker", [
    "run", "-d", "--name", blueName, "-p", "8471:8000", IMG_V1,
  ]);
  // Wait until v1 actually serves.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8471/health");
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await ensureManagedProxy(PROXY_PORT, { host: "127.0.0.1", port: 8471 });

  // Sanity: proxy serves v1.
  const pre = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/`)).text();
  assert.equal(pre.trim(), "v1", "proxy serves v1 before deploy");

  // Continuous request loop during the whole deploy.
  let stop = false;
  let total = 0;
  let failed = 0;
  let sawV2 = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/`, {
          // each fetch is a fresh connection — proves the atomic swap
          headers: { connection: "close" },
        });
        if (!res.ok) failed++;
        else {
          const body = (await res.text()).trim();
          if (body !== "v1" && body !== "v2") failed++;
          if (body === "v2") sawV2 = true;
        }
        total++;
      } catch {
        failed++;
        total++;
      }
    }
  })();

  // Seed live v1 deployment as record-of-truth.
  const liveV1 = await prisma.deployment.create({
    data: { environment: ENV as any, commitSha: v1Sha, version: "v1", status: "active" },
  });
  createdDeploymentIds.push(liveV1.id);

  const { deployRunId } = await runDeploy(ENV as any, v2Sha, SVC, {
    image: IMG_V2,
    blueName,
    triggeredById: null,
  });
  createdRunIds.push(deployRunId);

  const run = await waitRun(deployRunId);
  // keep hammering a bit after switch to catch any post-switch drop
  await new Promise((r) => setTimeout(r, 1500));
  stop = true;
  await loop;

  assert.equal(run.state, "SUCCEEDED", `deploy succeeded (state=${run.state})`);
  assert.ok(run.deploymentId, "DeployRun linked to a Deployment row");
  const dep = await prisma.deployment.findUnique({ where: { id: run.deploymentId! } });
  assert.ok(dep, "real Deployment row created");
  assert.equal(dep!.commitSha, v2Sha);
  createdDeploymentIds.push(run.deploymentId!);

  // THE PROOF: zero failed requests across the whole switch.
  console.log(
    `[zero-downtime] total=${total} failed=${failed} sawV2=${sawV2}`
  );
  assert.ok(total > 20, `made a meaningful number of requests (got ${total})`);
  assert.equal(failed, 0, `ZERO dropped requests during switch (failed=${failed})`);
  assert.ok(sawV2, "proxy served v2 at some point during/after the switch");

  // After deploy: proxy serves v2, blue (v1) container stopped.
  const post = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/`)).text();
  assert.equal(post.trim(), "v2", "proxy serves v2 after deploy");
  const ps = sh("docker", ["ps", "--format", "{{.Names}}"]);
  assert.ok(
    !ps.split("\n").map((s) => s.trim()).includes(blueName),
    "old blue (v1) container stopped"
  );

  // Real "deploy" AlertEvent raised.
  const alert = await prisma.alertEvent.findFirst({
    where: { source: "deploy", title: { contains: "SUCCEEDED" } },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(alert, "real deploy success AlertEvent raised");
});

test("forced health failure triggers REAL rollback, still zero downtime", async () => {
  const blueName = containerNames[0];
  // Current green from previous test is now serving v2; treat it as new blue.
  // Re-stage: run a fresh v2 blue and point proxy to it.
  rmContainers();
  sh("docker", ["run", "-d", "--name", blueName, "-p", "8471:8000", IMG_V2]);
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch("http://127.0.0.1:8471/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  await ensureManagedProxy(PROXY_PORT, { host: "127.0.0.1", port: 8471 });

  let stop = false;
  let total = 0;
  let failed = 0;
  const loop = (async () => {
    while (!stop) {
      try {
        const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/`, {
          headers: { connection: "close" },
        });
        if (!res.ok) failed++;
        total++;
      } catch {
        failed++;
        total++;
      }
    }
  })();

  // Live deployment record so plan resolves.
  const liveV2 = await prisma.deployment.create({
    data: { environment: ENV as any, commitSha: v2Sha, version: "v2", status: "active" },
  });
  createdDeploymentIds.push(liveV2.id);

  const { deployRunId } = await runDeploy(ENV as any, v2Sha, SVC, {
    image: IMG_V2,
    blueName,
    _forceHealthFail: true,
    triggeredById: null,
  });
  createdRunIds.push(deployRunId);
  const run = await waitRun(deployRunId);
  await new Promise((r) => setTimeout(r, 1000));
  stop = true;
  await loop;

  assert.equal(run.state, "ROLLED_BACK", `rolled back (state=${run.state})`);
  console.log(`[rollback] total=${total} failed=${failed}`);
  assert.equal(failed, 0, `zero downtime during failed deploy+rollback (failed=${failed})`);

  // Proxy still serves the original blue (v2 in this stage).
  const body = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/`)).text();
  assert.equal(body.trim(), "v2", "proxy still serves blue after rollback");

  const crit = await prisma.alertEvent.findFirst({
    where: { source: "deploy", severity: "CRITICAL" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(crit, "real CRITICAL deploy alert raised on rollback");
});

after(async () => {
  await stopManagedProxy(PROXY_PORT);
  rmContainers();
  try {
    sh("docker", ["rmi", "-f", IMG_V1, IMG_V2]);
  } catch {
    /* ignore */
  }
  // DB cleanup
  for (const id of createdRunIds) {
    await prisma.deployRun.deleteMany({ where: { id } }).catch(() => {});
  }
  await prisma.deployRun
    .deleteMany({ where: { service: SVC } })
    .catch(() => {});
  await prisma.deployment
    .deleteMany({ where: { commitSha: { in: [v1Sha, v2Sha] } } })
    .catch(() => {});
  await prisma.alertEvent
    .deleteMany({ where: { source: "deploy" } })
    .catch(() => {});
  await prisma.backgroundJob
    .deleteMany({ where: { kind: "deploy" } })
    .catch(() => {});

  // restore settings
  if (prevGitSetting != null) {
    await prisma.setting.update({
      where: { key: GIT_SETTING_KEY },
      data: { value: prevGitSetting },
    }).catch(() => {});
  } else {
    await prisma.setting.deleteMany({ where: { key: GIT_SETTING_KEY } }).catch(() => {});
  }
  if (prevDeploySetting != null) {
    await prisma.setting.update({
      where: { key: DEPLOY_SETTING_KEY },
      data: { value: prevDeploySetting },
    }).catch(() => {});
  } else {
    await prisma.setting.deleteMany({ where: { key: DEPLOY_SETTING_KEY } }).catch(() => {});
  }

  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await prisma.$disconnect();
});
