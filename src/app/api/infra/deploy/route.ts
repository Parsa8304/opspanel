import { NextRequest } from "next/server";
import { handler, json, getSetting, setSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createJob, runJob } from "@/lib/jobs";
import { hostSpawn } from "@/lib/server";

export const dynamic = "force-dynamic";

// ──────────────────────────── Config ────────────────────────────

export interface DeployStep {
  label: string;
  cmd: string;
  /** If true, a non-zero exit code is logged as a warning but doesn't abort. */
  allowFail?: boolean;
}

export interface InfraDeployConfig {
  steps: DeployStep[];
  dryRunSteps: DeployStep[];
  timeoutSec: number;
}

const SETTING_KEY = "infra_deploy_config";

// Default deploy target on the host. Override with INFRA_DEPLOY_DIR, or edit
// the steps in the Infrastructure Deploy page (stored in the DB Setting).
const DEPLOY_DIR = process.env.INFRA_DEPLOY_DIR || "/opt/app";
const COMPOSE = `${DEPLOY_DIR}/docker-compose.yml`;

const DEFAULT_CONFIG: InfraDeployConfig = {
  timeoutSec: 600,
  steps: [
    { label: "git pull", cmd: `git -C ${DEPLOY_DIR} pull origin main` },
    { label: "docker compose up", cmd: `docker compose -f ${COMPOSE} up -d --build` },
    { label: "prune images", cmd: "docker image prune -f", allowFail: true },
    { label: "show status", cmd: `docker compose -f ${COMPOSE} ps`, allowFail: true },
  ],
  dryRunSteps: [
    { label: "git fetch", cmd: `git -C ${DEPLOY_DIR} fetch origin` },
    { label: "git log (incoming)", cmd: `git -C ${DEPLOY_DIR} log HEAD..origin/main --oneline` },
    { label: "docker compose build", cmd: `docker compose -f ${COMPOSE} build --no-cache` },
  ],
};

async function getInfraDeployConfig(): Promise<InfraDeployConfig> {
  return getSetting<InfraDeployConfig>(SETTING_KEY, DEFAULT_CONFIG);
}

// ──────────────────────────── Routes ────────────────────────────

// GET /api/infra/deploy — list recent deploy jobs + return current config
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  const [jobs, cfg] = await Promise.all([
    prisma.backgroundJob.findMany({
      where: { kind: "infra.deploy" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, label: true, state: true, progress: true,
        error: true, createdAt: true, startedAt: true, finishedAt: true,
        params: true, createdById: true,
      },
    }),
    getInfraDeployConfig(),
  ]);

  // Enrich with user emails
  const seen = new Set<string>();
  const userIds: string[] = [];
  for (const j of jobs) {
    if (j.createdById && !seen.has(j.createdById)) {
      seen.add(j.createdById);
      userIds.push(j.createdById);
    }
  }
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.email]));
  const enriched = jobs.map(({ createdById, ...j }) => ({
    ...j,
    createdBy: createdById ? { email: userMap[createdById] ?? createdById } : null,
  }));

  return json({ jobs: enriched, config: cfg });
});

// PUT /api/infra/deploy — save config (steps editor)
export const PUT = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = await req.json();
  const cfg: InfraDeployConfig = {
    steps: Array.isArray(body.steps) ? body.steps : DEFAULT_CONFIG.steps,
    dryRunSteps: Array.isArray(body.dryRunSteps) ? body.dryRunSteps : DEFAULT_CONFIG.dryRunSteps,
    timeoutSec: Number(body.timeoutSec) > 0 ? Number(body.timeoutSec) : DEFAULT_CONFIG.timeoutSec,
  };
  await setSetting(SETTING_KEY, cfg);
  await audit(u.id, "infra.deploy.config.saved", undefined, { stepCount: cfg.steps.length });
  return json({ ok: true, config: cfg });
});

// POST /api/infra/deploy — trigger a deploy
export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = await req.json().catch(() => ({}));
  const dryRun: boolean = !!body?.dryRun;

  // One MN deploy at a time
  const inProgress = await prisma.backgroundJob.findFirst({
    where: { kind: "infra.deploy", state: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inProgress) {
    return json({ error: "A deploy is already in progress", jobId: inProgress.id }, { status: 409 });
  }

  const cfg = await getInfraDeployConfig();
  const steps = dryRun ? cfg.dryRunSteps : cfg.steps;
  const label = dryRun ? "MN infra dry-run" : "MN infra deploy";

  const job = await createJob({
    kind: "infra.deploy",
    label,
    params: { dryRun, stepCount: steps.length },
    createdById: u.id,
  });

  runJob(job.id, async (ctx) => {
    await ctx.log(`=== ${label} started ===`);
    await ctx.log(`Triggered by: ${u.email}`);
    await ctx.log(`Steps: ${steps.length}`);
    await ctx.log("");

    const timeoutMs = cfg.timeoutSec * 1000;

    for (let i = 0; i < steps.length; i++) {
      if (ctx.cancelled()) {
        await ctx.log("=== Cancelled ===");
        break;
      }
      const step = steps[i];
      await ctx.log(`>>> [${i + 1}/${steps.length}] ${step.label}`);
      await ctx.log(`    $ ${step.cmd}`);
      ctx.progress(Math.round((i / steps.length) * 90));

      try {
        await hostSpawn(
          step.cmd,
          (line) => { ctx.log(line); },
          timeoutMs
        );
        await ctx.log(`    ✓ done`);
      } catch (e: any) {
        const msg = e?.message || String(e);
        await ctx.log(`    ✗ ${msg}`);
        if (!step.allowFail) {
          await ctx.log(`=== Deploy FAILED at step: ${step.label} ===`);
          throw new Error(`Step "${step.label}" failed: ${msg}`);
        }
        await ctx.log(`    (continuing — step is marked allow-fail)`);
      }
      await ctx.log("");
    }

    ctx.progress(100);
    await ctx.log(`=== ${dryRun ? "Dry-run" : "Deploy"} complete ===`);
    return { dryRun, steps: steps.length };
  });

  await audit(u.id, "infra.deploy.triggered", job.id, { dryRun });
  return json({ jobId: job.id }, { status: 202 });
});
