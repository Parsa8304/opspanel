import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createJob, runJob } from "@/lib/jobs";
import { remoteSpawn } from "@/lib/remote";
import { hostSpawn } from "@/lib/server";

export const dynamic = "force-dynamic";

// GET /api/servers/[id]/exec — list recent exec jobs for this server
export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const jobs = await prisma.backgroundJob.findMany({
    where: { kind: "server.exec", params: { path: ["serverId"], equals: id } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true, label: true, state: true, progress: true,
      error: true, createdAt: true, startedAt: true, finishedAt: true, params: true,
    },
  });

  return json({ jobs });
});

// POST /api/servers/[id]/exec — run a command on a remote server
export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const cmd: string = (body?.cmd || "").trim();
  if (!cmd) return json({ error: "cmd is required" }, { status: 400 });

  const serverName = id === "local"
    ? "This server"
    : (await prisma.remoteServer.findUnique({ where: { id }, select: { name: true } }))?.name;
  if (!serverName) return json({ error: "Server not found" }, { status: 404 });

  const inProgress = await prisma.backgroundJob.findFirst({
    where: { kind: "server.exec", state: { in: ["QUEUED", "RUNNING"] }, params: { path: ["serverId"], equals: id } },
  });
  if (inProgress) {
    return json({ error: "A command is already running on this server", jobId: inProgress.id }, { status: 409 });
  }

  const job = await createJob({
    kind: "server.exec",
    label: `exec on ${serverName}: ${cmd.slice(0, 60)}`,
    params: { serverId: id, cmd },
    createdById: u.id,
  });

  runJob(job.id, async (jobCtx) => {
    await jobCtx.log(`=== Running on ${serverName} ===`);
    await jobCtx.log(`$ ${cmd}`);
    await jobCtx.log("");
    jobCtx.progress(10);

    try {
      if (id === "local") {
        await hostSpawn(cmd, (line) => { jobCtx.log(line); }, 300000);
      } else {
        await remoteSpawn(id, cmd, (line) => { jobCtx.log(line); }, 300000);
      }
      jobCtx.progress(100);
      await jobCtx.log("");
      await jobCtx.log("=== Command finished ===");
    } catch (e: any) {
      const msg = e?.message || String(e);
      await jobCtx.log(`=== Command FAILED: ${msg} ===`);
      throw e;
    }
    return { cmd };
  });

  await audit(u.id, "servers.exec.triggered", id, { cmd });
  return json({ jobId: job.id }, { status: 202 });
});
