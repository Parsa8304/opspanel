import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["PENDING", "RUNNING", "SUCCESS", "FAILED", "EXPIRED"] as const;
type BackupStatus = (typeof VALID_STATUSES)[number];

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string; jobId: string }> }) => {
  await requireRole(req, "READONLY");
  const { id, jobId } = await ctx.params;

  const job = await prisma.backupJob.findUnique({
    where: { id: jobId },
    include: { schedule: true },
  });
  if (!job || job.serverId !== id) return json({ error: "Not found" }, { status: 404 });
  return json(job);
});

export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string; jobId: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id, jobId } = await ctx.params;
  const body = await req.json();

  const existing = await prisma.backupJob.findUnique({ where: { id: jobId } });
  if (!existing || existing.serverId !== id) return json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return json({ error: "Invalid status" }, { status: 400 });
    }
    data.status = body.status as BackupStatus;
    if (body.status === "RUNNING" && !existing.startedAt) {
      data.startedAt = new Date();
    }
    if ((body.status === "SUCCESS" || body.status === "FAILED") && !existing.finishedAt) {
      data.finishedAt = new Date();
    }
  }

  if (body.log !== undefined) data.log = body.log;
  if (body.error !== undefined) data.error = body.error;
  if (body.path !== undefined) data.path = body.path;
  if (body.sizeBytes !== undefined) data.sizeBytes = BigInt(body.sizeBytes);
  if (body.expiresAt !== undefined) data.expiresAt = new Date(body.expiresAt);
  if (body.startedAt !== undefined) data.startedAt = new Date(body.startedAt);
  if (body.finishedAt !== undefined) data.finishedAt = new Date(body.finishedAt);

  const updated = await prisma.backupJob.update({
    where: { id: jobId },
    data,
    include: { schedule: { select: { id: true, name: true } } },
  });

  return json(updated);
});
