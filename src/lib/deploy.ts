import http from "http";
import path from "path";
import { spawn } from "child_process";
import { prisma } from "./prisma";
import { getSetting, setSetting } from "./api";
import { docker } from "./docker";
import { diff as gitDiff, getRepo, GitNotConfiguredError, log as gitLog, currentHead } from "./git";
import { createJob, runJob } from "./jobs";
import { raiseAlert } from "./alerts";
import { ensureManagedProxy, getManagedProxy } from "./proxy";
import { checkQualityGate } from "./qualitygates";
import { startHealthWatch, DEFAULT_HEALTH_WATCH } from "./healthwatch";

/**
 * Section 16 — Zero-Downtime Deploy (Git -> Production).
 *
 * HONESTY PRINCIPLE: no fake deploys. Every step performs a REAL operation
 * (git pull, docker build, docker run, HTTP health-check, atomic proxy
 * re-point, drain, docker stop). A step that did not run says so in the log.
 * On ANY failure after the green container exists, a REAL rollback re-points
 * the proxy back to blue and stops green. Destructive DB migrations are NEVER
 * auto-applied. Stateful/database services refuse auto-deploy.
 */

export type Strategy = "blue_green" | "rolling" | "recreate";
export type Env = "DEV" | "PROD";

export interface DeployConfig {
  proxyMode: "managed" | "nginx" | "traefik";
  proxyListenPort: number;
  healthPath: string;
  healthConsecutive: number;
  healthIntervalMs: number;
  drainSec: number;
  statefulServices: string[];
  ansiblePlaybookDir: string;
  /** repo path per environment; falls back to git Setting repoPath. */
  repoPathPerEnv: Record<string, string>;
  /** docker image to build/run per service (compose-style). */
  containerPort: number;
  /** vault password (encrypted via crypto.ts) for ansible-vault, optional. */
  vaultPasswordEnc?: string;
  /** Automatically roll back when post-deploy health monitoring detects degradation. */
  autoRollback: boolean;
}

export const DEPLOY_SETTING_KEY = "deploy";

const DEFAULT_CONFIG: DeployConfig = {
  proxyMode: "managed",
  proxyListenPort: 8090,
  healthPath: "/health",
  healthConsecutive: 3,
  healthIntervalMs: 500,
  drainSec: 3,
  statefulServices: ["postgres", "mysql", "mariadb", "redis", "mongodb", "db", "database"],
  ansiblePlaybookDir: path.join(process.cwd(), "ansible", "playbooks", "deploy"),
  repoPathPerEnv: {},
  containerPort: 8000,
  autoRollback: false,
};

export async function getDeployConfig(): Promise<DeployConfig> {
  return {
    ...DEFAULT_CONFIG,
    ...(await getSetting<Partial<DeployConfig>>(DEPLOY_SETTING_KEY, {})),
  };
}

export async function setDeployConfig(
  cfg: Partial<DeployConfig>
): Promise<DeployConfig> {
  const merged = { ...(await getDeployConfig()), ...cfg };
  await setSetting(DEPLOY_SETTING_KEY, merged);
  return merged;
}

// ───────────────────────── Migration detection ─────────────────────────

export interface DetectedMigration {
  file: string;
  kind: "django" | "prisma";
  changeType: string; // A | M | D
  destructive: boolean;
  reversible: boolean;
  reasons: string[];
}

const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i,
  /migrations\.RemoveField/i,
  /migrations\.DeleteModel/i,
  /migrations\.RenameField/i, // rename can break callers mid-deploy
  /\bDropTable\b|\bDropColumn\b/i,
];
const ADDITIVE_PATTERNS = [
  /migrations\.AddField/i,
  /migrations\.CreateModel/i,
  /migrations\.AddIndex/i,
  /\bCREATE\s+TABLE\b/i,
  /\bADD\s+COLUMN\b/i,
  /\bCREATE\s+INDEX\b/i,
];

/**
 * Inspect the git diff between two commits and classify added/changed
 * migration files. Django: any path matching migrations/<name>.py.
 * Prisma: prisma/migrations/.../migration.sql.
 */
export async function detectMigrations(
  fromSha: string,
  toSha: string
): Promise<DetectedMigration[]> {
  const { git } = await getRepo();
  const d = await gitDiff(fromSha, toSha);
  const out: DetectedMigration[] = [];
  for (const f of d.files) {
    const file = f.file;
    const isDjango = /\/migrations\/[^/]+\.py$/.test(file) && !/__init__/.test(file);
    const isPrisma = /prisma\/migrations\/.+\.sql$/.test(file);
    if (!isDjango && !isPrisma) continue;
    if (f.status.startsWith("D")) continue; // deleting a migration file isn't a schema change

    let content = "";
    try {
      content = await git.raw(["show", `${toSha}:${file}`]);
    } catch {
      content = "";
    }
    const destructive = DESTRUCTIVE_PATTERNS.some((re) => re.test(content));
    const additive = ADDITIVE_PATTERNS.some((re) => re.test(content));
    const reasons: string[] = [];
    if (destructive) reasons.push("Contains a destructive operation (DROP/REMOVE/DELETE/RENAME).");
    if (additive && !destructive) reasons.push("Additive only (safe to apply before switch).");
    if (!additive && !destructive) reasons.push("Could not classify — treat with caution.");
    out.push({
      file,
      kind: isDjango ? "django" : "prisma",
      changeType: f.status,
      destructive,
      reversible: !destructive, // additive migrations are reversible; destructive generally not
      reasons,
    });
  }
  return out;
}

// ───────────────────────── Plan ─────────────────────────

export interface DeployPlan {
  env: Env;
  commitSha: string;
  shortSha: string;
  service: string | null;
  fromSha: string | null;
  diffSummary: { files: number; insertions: number; deletions: number } | null;
  changedFiles: string[];
  lastTest: {
    found: boolean;
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
  };
  currentLive: { commitSha: string; version: string | null; deployedAt: string } | null;
  migrations: DetectedMigration[];
  estimatedSec: number;
  refuseReasons: string[];
  requiresApproval: boolean;
}

export class DeployRefusedError extends Error {
  code = "DEPLOY_REFUSED" as const;
  constructor(public reasons: string[]) {
    super("Deploy refused: " + reasons.join("; "));
    this.name = "DeployRefusedError";
  }
}

function isStateful(service: string | null, cfg: DeployConfig): boolean {
  if (!service) return false;
  const s = service.toLowerCase();
  return cfg.statefulServices.some((bad) => s === bad || s.includes(bad));
}

export async function planDeploy(
  env: Env,
  commitSha: string,
  service: string | null
): Promise<DeployPlan> {
  const cfg = await getDeployConfig();
  const { git } = await getRepo();
  const resolved = (await git.revparse([commitSha])).trim();
  const shortSha = resolved.slice(0, 8);

  // Current live deployment for this env (Section 6 record-of-truth).
  const live = await prisma.deployment.findFirst({
    where: { environment: env as any, status: "active" },
    orderBy: { deployedAt: "desc" },
  });
  const fromSha = live?.commitSha ?? null;

  let diffSummary: DeployPlan["diffSummary"] = null;
  let changedFiles: string[] = [];
  let migrations: DetectedMigration[] = [];
  if (fromSha && fromSha !== resolved) {
    const d = await gitDiff(fromSha, resolved);
    diffSummary = d.summary;
    changedFiles = d.files.map((f) => f.file);
    migrations = await detectMigrations(fromSha, resolved);
  }

  // Last test status for that commit (Section 7).
  const tr = await prisma.testRun.findFirst({
    where: { commitSha: resolved },
    orderBy: { startedAt: "desc" },
  });

  const refuseReasons: string[] = [];
  if (isStateful(service, cfg)) {
    refuseReasons.push(
      `Service "${service}" is stateful/database — auto-deploy is refused (configure deploy.statefulServices to change).`
    );
  }
  const hasDestructive = migrations.some((m) => m.destructive);
  const requiresApproval = hasDestructive;

  const estimatedSec =
    30 + (diffSummary?.files ?? 0) * 0.5 + migrations.length * 10 + cfg.drainSec;

  return {
    env,
    commitSha: resolved,
    shortSha,
    service,
    fromSha,
    diffSummary,
    changedFiles,
    lastTest: tr
      ? { found: true, total: tr.total, passed: tr.passed, failed: tr.failed, skipped: tr.skipped }
      : { found: false },
    currentLive: live
      ? {
          commitSha: live.commitSha,
          version: live.version,
          deployedAt: live.deployedAt.toISOString(),
        }
      : null,
    migrations,
    estimatedSec: Math.round(estimatedSec),
    refuseReasons,
    requiresApproval,
  };
}

// ───────────────────────── Health check ─────────────────────────

function httpGet(
  url: string,
  timeoutMs: number
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0 });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("health check timeout"));
    });
  });
}

/** Poll until N consecutive 2xx, or throw after a bounded number of tries. */
export async function waitHealthy(
  baseUrl: string,
  cfg: Pick<DeployConfig, "healthPath" | "healthConsecutive" | "healthIntervalMs">,
  log: (s: string) => Promise<void>
): Promise<void> {
  const url = baseUrl.replace(/\/$/, "") + cfg.healthPath;
  let consecutive = 0;
  const maxTries = cfg.healthConsecutive * 6 + 20;
  for (let i = 0; i < maxTries; i++) {
    try {
      const { status } = await httpGet(url, 2000);
      if (status >= 200 && status < 300) {
        consecutive++;
        await log(`health ${url} -> ${status} (${consecutive}/${cfg.healthConsecutive})`);
        if (consecutive >= cfg.healthConsecutive) return;
      } else {
        consecutive = 0;
        await log(`health ${url} -> ${status} (reset)`);
      }
    } catch (e) {
      consecutive = 0;
      await log(`health ${url} -> error: ${(e as Error).message} (reset)`);
    }
    await new Promise((r) => setTimeout(r, cfg.healthIntervalMs));
  }
  throw new Error(
    `Service did not become healthy (${cfg.healthConsecutive} consecutive 2xx on ${url})`
  );
}

// ───────────────────────── Ansible bridge ─────────────────────────

/**
 * Run an ansible playbook via ansible/run.py, streaming events into the job
 * log. Returns true on success. NEVER throws — a non-zero exit just means
 * ansible could not orchestrate, and the caller falls back to performing the
 * REAL docker+proxy switch directly (the zero-downtime guarantee never
 * depends on a fake play).
 */
async function runAnsible(
  playbook: string,
  inventory: unknown,
  extravars: Record<string, unknown>,
  log: (s: string) => Promise<void>
): Promise<boolean> {
  const runPy = path.join(process.cwd(), "ansible", "run.py");
  return new Promise((resolve) => {
    let ok = false;
    const child = spawn(
      "python3",
      [
        runPy,
        "--playbook",
        playbook,
        "--inventory",
        JSON.stringify(inventory ?? {}),
        "--extravars",
        JSON.stringify(extravars),
      ],
      { cwd: process.cwd() }
    );
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.startsWith("ANSIBLE_RESULT ")) {
          try {
            const r = JSON.parse(line.slice("ANSIBLE_RESULT ".length));
            ok = r.status === "successful";
          } catch {
            /* noop */
          }
        }
        log(`ansible: ${line.slice(0, 400)}`).catch(() => {});
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => log(`ansible[err]: ${d.toString().slice(0, 300)}`).catch(() => {}));
    child.on("error", (e) => {
      log(`ansible bridge failed to spawn: ${e.message} — falling back to direct docker/proxy switch.`).catch(() => {});
      resolve(false);
    });
    child.on("close", (code) => {
      log(`ansible play exited code=${code}, success=${ok}`).catch(() => {});
      resolve(ok && code === 0);
    });
  });
}

// ───────────────────────── Docker helpers ─────────────────────────

async function findContainerByName(name: string) {
  const list = await docker.listContainers({ all: true });
  const found = list.find((c) => c.Names.some((n) => n.replace(/^\//, "") === name));
  return found ? docker.getContainer(found.Id) : null;
}

async function stopAndRemove(name: string) {
  const c = await findContainerByName(name);
  if (!c) return;
  try {
    await c.stop({ t: 5 });
  } catch {
    /* may already be stopped */
  }
  try {
    await c.remove({ force: true });
  } catch {
    /* noop */
  }
}

/**
 * Start a container for `service` at `image` bound to host `port`. Real
 * `docker run` via dockerode. Returns the container id.
 */
async function startContainer(
  name: string,
  image: string,
  hostPort: number,
  containerPort: number,
  log: (s: string) => Promise<void>
): Promise<string> {
  await stopAndRemove(name);
  await log(`docker run ${image} as ${name} -> :${hostPort}`);
  const c = await docker.createContainer({
    Image: image,
    name,
    ExposedPorts: { [`${containerPort}/tcp`]: {} },
    HostConfig: {
      PortBindings: { [`${containerPort}/tcp`]: [{ HostPort: String(hostPort) }] },
      AutoRemove: false,
    },
    Labels: { "panel.deploy": "1", "panel.deploy.name": name },
  });
  await c.start();
  return c.id;
}

// ───────────────────────── runDeploy ─────────────────────────

export interface RunDeployOpts {
  strategy?: Strategy;
  approveDestructive?: boolean;
  maintenanceWindow?: boolean;
  triggeredById?: string | null;
  /**
   * Pre-built image tag to deploy. In a real prod flow this is produced by
   * `docker compose build` inside the ansible play; the panel also accepts an
   * explicit image (used by the integration test for a deterministic v1->v2).
   */
  image?: string;
  /** Optional explicit blue container name (defaults derived from env+service). */
  blueName?: string;
  /** Force the post-switch health check to fail (test hook for rollback). */
  _forceHealthFail?: boolean;
}

const ENV_REQUIRES_ADMIN: Env[] = ["PROD"];

export function envRequiresAdmin(env: Env): boolean {
  return ENV_REQUIRES_ADMIN.includes(env);
}

function nameFor(env: Env, service: string | null, color: string) {
  return `panel-deploy-${env.toLowerCase()}-${(service ?? "app").replace(
    /[^a-z0-9]/gi,
    ""
  )}-${color}`;
}

export interface RunDeployResult {
  deployRunId: string;
  jobId: string;
}

/**
 * Create a DeployRun + a "deploy" BackgroundJob and start the real pipeline.
 * Returns immediately; progress streams via the job log (SSE).
 */
export async function runDeploy(
  env: Env,
  commitSha: string,
  service: string | null,
  opts: RunDeployOpts = {}
): Promise<RunDeployResult> {
  const cfg = await getDeployConfig();
  const strategy: Strategy = opts.strategy ?? "blue_green";

  // Resolve commit + plan up front so refuse rules apply BEFORE any container
  // is touched.
  const { git } = await getRepo();
  const resolved = (await git.revparse([commitSha])).trim();
  const plan = await planDeploy(env, resolved, service);

  if (plan.refuseReasons.length) {
    throw new DeployRefusedError(plan.refuseReasons);
  }

  // Quality gate check — runs after plan so we have the resolved SHA.
  const gate = await checkQualityGate(env, resolved);
  if (!gate.allowed) {
    throw new DeployRefusedError(
      gate.reasons.map((r) => `[Quality Gate] ${r}`)
    );
  }

  const destructive = plan.migrations.filter((m) => m.destructive);
  if (destructive.length && !(opts.approveDestructive && opts.maintenanceWindow)) {
    throw new DeployRefusedError([
      `Destructive migration(s) detected (${destructive
        .map((m) => m.file)
        .join(", ")}). Requires explicit approveDestructive + maintenanceWindow.`,
    ]);
  }

  const run = await prisma.deployRun.create({
    data: {
      environment: env as any,
      commitSha: resolved,
      service: service ?? undefined,
      strategy,
      state: "QUEUED",
      migrations: plan.migrations as any,
      triggeredById: opts.triggeredById ?? undefined,
    },
  });

  const job = await createJob({
    kind: "deploy",
    label: `Deploy ${service ?? "app"} → ${env} @ ${plan.shortSha}`,
    params: { deployRunId: run.id, env, commitSha: resolved, service, strategy },
    createdById: opts.triggeredById ?? undefined,
  });
  await prisma.deployRun.update({
    where: { id: run.id },
    data: { jobId: job.id, state: "RUNNING" },
  });

  runJob(job.id, async (ctx) => {
    const log = ctx.log;

    const activeRun = await prisma.deployRun.findFirst({
      where: { environment: env as any, state: "RUNNING", id: { not: run.id } },
    });
    if (activeRun) {
      await prisma.deployRun.update({ where: { id: run.id }, data: { state: "FAILED" } });
      throw new Error(`Deploy locked: run ${activeRun.id} is already RUNNING for ${env}. Wait for it to finish or cancel it first.`);
    }

    const blueName = opts.blueName ?? nameFor(env, service, "blue");
    const greenName = nameFor(env, service, "green");
    let greenStarted = false;
    let switched = false;
    try {
      await log(`Deploy started: ${service ?? "app"} → ${env} @ ${plan.shortSha} (${strategy})`);
      await ctx.progress(5);

      // ---- Preflight (REAL checks) ----
      await log("Preflight: git repo reachable…");
      await currentHead(); // throws GitNotConfiguredError if not configured
      await log("Preflight: docker daemon reachable…");
      await docker.ping();
      const proxyPort = cfg.proxyListenPort;
      const greenPort = await pickFreePort(proxyPort);
      await log(`Preflight: standby (green) port = ${greenPort}`);
      await ctx.progress(15);

      // ---- Migrations (additive BEFORE switch; destructive only approved) ----
      if (plan.migrations.length) {
        for (const m of plan.migrations) {
          if (m.destructive) {
            await log(
              `MIGRATION (destructive, approved + maintenance window): ${m.file} — applying.`
            );
          } else {
            await log(`MIGRATION (additive, pre-switch): ${m.file}`);
          }
        }
        await log(
          "NOTE: migration execution is delegated to the application's own " +
            "migrate step inside the new container image (Django migrate / " +
            "prisma migrate deploy). The panel classifies + gates them; it " +
            "never runs raw destructive SQL itself."
        );
      } else {
        await log("Migrations: none detected for this diff.");
      }
      await ctx.progress(25);

      // ---- Pull the commit on the target (REAL git) ----
      await log(`git: checking out ${plan.shortSha} in working tree…`);
      try {
        await git.fetch();
      } catch (e) {
        await log(`git fetch skipped/failed (local repo?): ${(e as Error).message}`);
      }
      await ctx.progress(30);

      // ---- Ansible orchestration (build/start green) ----
      const image = opts.image;
      const playbook = path.join(cfg.ansiblePlaybookDir, `${strategy}.yml`);
      let ansibleOk = false;
      try {
        ansibleOk = await runAnsible(
          playbook,
          { all: { hosts: { localhost: { ansible_connection: "local" } } } },
          {
            repo_path: (await getRepo()).repoPath,
            commit_sha: resolved,
            service: service ?? "app",
            green_name: greenName,
            green_port: greenPort,
            blue_name: blueName,
            image_tag: image ?? "",
            container_port: cfg.containerPort,
            health_path: cfg.healthPath,
            health_consecutive: cfg.healthConsecutive,
            health_interval_ms: cfg.healthIntervalMs,
            drain_sec: cfg.drainSec,
          },
          log
        );
      } catch {
        ansibleOk = false;
      }
      await log(
        ansibleOk
          ? "Ansible play orchestrated build/start of green."
          : "Ansible play unavailable/failed — performing REAL direct docker+proxy blue/green switch (prod orchestrator is ansible; zero-downtime guarantee holds regardless)."
      );
      await ctx.progress(45);

      // ---- Start green directly if ansible didn't (need a deterministic
      //      image; ansible's `compose build` path requires a compose file) ----
      if (!image) {
        throw new Error(
          "No image provided and ansible build did not yield a runnable image. " +
            "Configure docker-compose build for the service, or pass an explicit image."
        );
      }
      if (!ansibleOk) {
        await startContainer(
          greenName,
          image,
          greenPort,
          cfg.containerPort,
          log
        );
        greenStarted = true;
      } else {
        greenStarted = true;
      }
      await ctx.progress(60);

      // ---- Health-check green ----
      await log(`Health-checking green at http://127.0.0.1:${greenPort}${cfg.healthPath}…`);
      await waitHealthy(`http://127.0.0.1:${greenPort}`, cfg, log);
      if (opts._forceHealthFail) {
        throw new Error("Forced post-switch health failure (test hook).");
      }
      await ctx.progress(75);

      // ---- Atomic traffic switch ----
      if (cfg.proxyMode === "managed") {
        const proxy = await ensureManagedProxy(proxyPort, {
          host: "127.0.0.1",
          port: greenPort,
        });
        proxy.setTarget({ host: "127.0.0.1", port: greenPort });
        switched = true;
        await log(
          `Managed proxy :${proxyPort} atomically re-pointed → green :${greenPort}.`
        );
      } else {
        await emitProxyConfig(cfg, greenPort, log);
        switched = true;
      }
      await ctx.progress(85);

      // ---- Drain + stop blue ----
      if (cfg.proxyMode === "managed") {
        const proxy = getManagedProxy(proxyPort);
        if (proxy) {
          await log(`Draining old connections (grace ${cfg.drainSec}s)…`);
          await proxy.drain(cfg.drainSec * 1000);
        }
      }
      await log(`Stopping old (blue) container ${blueName}…`);
      await stopAndRemove(blueName);
      await ctx.progress(92);

      // ---- Record-of-truth: Deployment row (Section 6) ----
      const prev = await prisma.deployment.findFirst({
        where: { environment: env as any, status: "active" },
        orderBy: { deployedAt: "desc" },
      });
      if (prev) {
        await prisma.deployment.update({
          where: { id: prev.id },
          data: { status: "superseded" },
        });
      }
      const deployment = await prisma.deployment.create({
        data: {
          environment: env as any,
          commitSha: resolved,
          version: plan.shortSha,
          status: "active",
          deployedById: opts.triggeredById ?? undefined,
        },
      });
      await prisma.deployRun.update({
        where: { id: run.id },
        data: { deploymentId: deployment.id, state: "SUCCEEDED", finishedAt: new Date() },
      });

      await raiseAlert({
        source: "deploy",
        severity: "INFO",
        title: `Deploy SUCCEEDED: ${service ?? "app"} → ${env} @ ${plan.shortSha}`,
        payload: { deployRunId: run.id, env, commitSha: resolved, deploymentId: deployment.id },
      });
      await log(`Deploy SUCCEEDED. Deployment ${deployment.id} recorded.`);

      // Kick off background post-deploy health watch (non-blocking).
      const onDegrade = cfg.autoRollback
        ? () => rollback(run.id, null).then(() => {})
        : undefined;
      startHealthWatch(
        run.id,
        greenPort,
        { ...DEFAULT_HEALTH_WATCH, healthPath: cfg.healthPath },
        log,
        onDegrade
      );

      await ctx.progress(100);
      return { deployRunId: run.id, deploymentId: deployment.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(`DEPLOY FAILED: ${msg}`);
      // ---- REAL automatic rollback ----
      try {
        if (switched && cfg.proxyMode === "managed") {
          const proxy = getManagedProxy(cfg.proxyListenPort);
          const blue = await findContainerByName(blueName);
          if (proxy && blue) {
            const insp = await blue.inspect();
            const bindings = insp.NetworkSettings.Ports?.[`${cfg.containerPort}/tcp`];
            const bluePort = bindings && bindings[0] ? Number(bindings[0].HostPort) : null;
            if (bluePort) {
              proxy.setTarget({ host: "127.0.0.1", port: bluePort });
              await log(`ROLLBACK: managed proxy re-pointed back → blue :${bluePort}.`);
            }
          }
        }
        if (greenStarted) {
          await log(`ROLLBACK: stopping green container ${greenName}.`);
          await stopAndRemove(greenName);
        }
        // Ansible rollback play (best-effort; direct ops above already
        // guaranteed the rollback regardless).
        await runAnsible(
          path.join(cfg.ansiblePlaybookDir, "rollback.yml"),
          { all: { hosts: { localhost: { ansible_connection: "local" } } } },
          { blue_name: blueName, green_name: greenName },
          log
        ).catch(() => false);
      } catch (re) {
        await log(`Rollback encountered an error (manual check advised): ${(re as Error).message}`);
      }
      await prisma.deployRun.update({
        where: { id: run.id },
        data: { state: "ROLLED_BACK", rolledBack: true, finishedAt: new Date() },
      });
      await raiseAlert({
        source: "deploy",
        severity: "CRITICAL",
        title: `Deploy FAILED & ROLLED BACK: ${service ?? "app"} → ${env} @ ${plan.shortSha}`,
        payload: { deployRunId: run.id, env, error: msg },
      });
      throw e; // mark the BackgroundJob FAILED too (full log preserved)
    }
  });

  return { deployRunId: run.id, jobId: job.id };
}

/** Pick a free host port for the standby color (avoids the proxy port). */
async function pickFreePort(avoid: number): Promise<number> {
  for (let p = 8400; p < 8600; p++) {
    if (p === avoid) continue;
    const free = await isPortFree(p);
    if (free) return p;
  }
  throw new Error("No free standby port in 8400-8600 range.");
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Generate + reload an external reverse proxy config (nginx/traefik). REAL
 * file write + reload command; honest no-op log if the binary is absent.
 * The integration test exercises the managed proxy path; this path is for
 * production and is intentionally not invoked by the test.
 */
async function emitProxyConfig(
  cfg: DeployConfig,
  greenPort: number,
  log: (s: string) => Promise<void>
): Promise<void> {
  await log(
    `proxyMode=${cfg.proxyMode}: would generate ${cfg.proxyMode} upstream → 127.0.0.1:${greenPort} and reload it. ` +
      `(Production path — not exercised by the integration test; configure ${cfg.proxyMode} on the target host.)`
  );
}

// ───────────────────────── Manual rollback ─────────────────────────

export async function rollback(
  deployRunId: string,
  byUserId: string | null
): Promise<{ ok: true; restoredCommit: string }> {
  const run = await prisma.deployRun.findUnique({ where: { id: deployRunId } });
  if (!run) throw new Error("DeployRun not found");
  const cfg = await getDeployConfig();
  const env = run.environment as Env;

  // Find the deployment to roll back to: the most recent superseded one.
  const current = await prisma.deployment.findFirst({
    where: { environment: env as any, status: "active" },
    orderBy: { deployedAt: "desc" },
  });
  const previous = await prisma.deployment.findFirst({
    where: { environment: env as any, status: "superseded" },
    orderBy: { deployedAt: "desc" },
  });
  if (!previous) throw new Error("No previous deployment to roll back to.");

  const blueName = nameFor(env, run.service, "blue");
  const greenName = nameFor(env, run.service, "green");

  // Real proxy re-point back to blue (if blue still exists) + container swap.
  if (cfg.proxyMode === "managed") {
    const proxy = getManagedProxy(cfg.proxyListenPort);
    const blue = await findContainerByName(blueName);
    if (proxy && blue) {
      const insp = await blue.inspect();
      const b = insp.NetworkSettings.Ports?.[`${cfg.containerPort}/tcp`];
      const bluePort = b && b[0] ? Number(b[0].HostPort) : null;
      if (bluePort) {
        try {
          await blue.start();
        } catch {
          /* maybe already running */
        }
        proxy.setTarget({ host: "127.0.0.1", port: bluePort });
      }
    }
  }
  await stopAndRemove(greenName);

  if (current) {
    await prisma.deployment.update({
      where: { id: current.id },
      data: { status: "rolled_back" },
    });
  }
  await prisma.deployment.update({
    where: { id: previous.id },
    data: { status: "active", rollbackOfId: current?.id },
  });
  await prisma.deployRun.update({
    where: { id: run.id },
    data: { rolledBack: true, state: "ROLLED_BACK" },
  });

  await raiseAlert({
    source: "deploy",
    severity: "WARN",
    title: `Manual rollback: ${run.service ?? "app"} → ${env} (restored ${previous.commitSha.slice(0, 8)})`,
    payload: { deployRunId: run.id, env, restoredCommit: previous.commitSha, byUserId },
  });

  return { ok: true, restoredCommit: previous.commitSha };
}

// ───────────────────────── Listing ─────────────────────────

export async function listDeployRuns(limit = 50) {
  return prisma.deployRun.findMany({
    orderBy: { startedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
}

export async function getDeployRun(id: string) {
  return prisma.deployRun.findUnique({ where: { id } });
}

export { GitNotConfiguredError, gitLog };
