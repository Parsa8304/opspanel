import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["PENDING", "RUNNING", "SUCCESS", "FAILED", "EXPIRED"] as const;
const VALID_KINDS = ["DATABASE", "VOLUME", "CONFIG", "UPLOAD", "FULL"] as const;

type BackupStatus = (typeof VALID_STATUSES)[number];
type BackupTargetKind = (typeof VALID_KINDS)[number];

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;
  const u = new URL(req.url);
  const status = u.searchParams.get("status");
  const targetKind = u.searchParams.get("targetKind");

  const jobs = await prisma.backupJob.findMany({
    where: {
      serverId: id,
      ...(status && VALID_STATUSES.includes(status as BackupStatus)
        ? { status: status as BackupStatus }
        : {}),
      ...(targetKind && VALID_KINDS.includes(targetKind as BackupTargetKind)
        ? { targetKind: targetKind as BackupTargetKind }
        : {}),
    },
    include: { schedule: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return json(jobs);
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;
  const body = await req.json();

  if (!body.targetKind || !VALID_KINDS.includes(body.targetKind)) {
    return json({ error: "targetKind required and must be one of: " + VALID_KINDS.join(", ") }, { status: 400 });
  }
  if (!body.targetRef || typeof body.targetRef !== "string" || !body.targetRef.trim()) {
    return json({ error: "targetRef is required" }, { status: 400 });
  }

  const destination = body.destination ?? "local";

  const job = await prisma.backupJob.create({
    data: {
      serverId: id,
      targetKind: body.targetKind as BackupTargetKind,
      targetRef: body.targetRef.trim(),
      destination,
      status: "PENDING",
      triggeredById: user.id,
      scheduleId: body.scheduleId ?? null,
    },
    include: { schedule: { select: { id: true, name: true } } },
  });

  return json(job, { status: 201 });
});
