import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordJob } from "@/lib/celery";

export const dynamic = "force-dynamic";

const STATUSES = [
  "PENDING",
  "STARTED",
  "SUCCESS",
  "FAILURE",
  "RETRY",
  "DEAD",
] as const;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || undefined;
  const taskType = url.searchParams.get("taskType") || undefined;
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1),
    500
  );

  const where: Record<string, unknown> = {};
  if (status && (STATUSES as readonly string[]).includes(status))
    where.status = status;
  if (taskType) where.taskType = taskType;

  const jobs = await prisma.jobRecord.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return json({ jobs });
});

const ingestSchema = z.object({
  taskId: z.string().min(1),
  taskType: z.string().min(1),
  queue: z.string().optional(),
  status: z.enum(STATUSES),
  workerName: z.string().optional().nullable(),
  durationMs: z.number().int().optional().nullable(),
  error: z.string().optional().nullable(),
  payloadMeta: z.unknown().optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = ingestSchema.parse(await req.json());
  const rec = await recordJob({
    taskId: body.taskId,
    taskType: body.taskType,
    queue: body.queue,
    status: body.status,
    workerName: body.workerName ?? null,
    durationMs: body.durationMs ?? null,
    error: body.error ?? null,
    payloadMeta: body.payloadMeta,
  });
  await audit(user.id, "async.job.ingest", body.taskId, {
    taskType: body.taskType,
    status: body.status,
  });
  return json({ job: rec });
});
