import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const VALID_KINDS = ["DATABASE", "VOLUME", "CONFIG", "UPLOAD", "FULL"] as const;
type BackupTargetKind = (typeof VALID_KINDS)[number];

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const schedules = await prisma.backupSchedule.findMany({
    where: { serverId: id },
    include: {
      _count: { select: { jobs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return json(schedules);
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;
  const body = await req.json();

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return json({ error: "name is required" }, { status: 400 });
  }
  if (!body.targetKind || !VALID_KINDS.includes(body.targetKind)) {
    return json({ error: "targetKind required and must be one of: " + VALID_KINDS.join(", ") }, { status: 400 });
  }
  if (!body.targetRef || typeof body.targetRef !== "string" || !body.targetRef.trim()) {
    return json({ error: "targetRef is required" }, { status: 400 });
  }
  if (!body.cronExpr || typeof body.cronExpr !== "string" || !body.cronExpr.trim()) {
    return json({ error: "cronExpr is required" }, { status: 400 });
  }

  const schedule = await prisma.backupSchedule.create({
    data: {
      name: body.name.trim(),
      serverId: id,
      targetKind: body.targetKind as BackupTargetKind,
      targetRef: body.targetRef.trim(),
      cronExpr: body.cronExpr.trim(),
      retainDays: typeof body.retainDays === "number" ? body.retainDays : 7,
      destination: body.destination ?? "local",
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
    },
    include: {
      _count: { select: { jobs: true } },
    },
  });

  return json(schedule, { status: 201 });
});
