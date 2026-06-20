import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const VALID_KINDS = ["DATABASE", "VOLUME", "CONFIG", "UPLOAD", "FULL"] as const;
type BackupTargetKind = (typeof VALID_KINDS)[number];

export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string; scheduleId: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id, scheduleId } = await ctx.params;
  const body = await req.json();

  const existing = await prisma.backupSchedule.findUnique({ where: { id: scheduleId } });
  if (!existing || existing.serverId !== id) return json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    data.name = body.name.trim();
  }
  if (body.targetKind !== undefined) {
    if (!VALID_KINDS.includes(body.targetKind)) {
      return json({ error: "Invalid targetKind" }, { status: 400 });
    }
    data.targetKind = body.targetKind as BackupTargetKind;
  }
  if (body.targetRef !== undefined) data.targetRef = body.targetRef;
  if (body.cronExpr !== undefined) data.cronExpr = body.cronExpr;
  if (body.retainDays !== undefined) data.retainDays = Number(body.retainDays);
  if (body.destination !== undefined) data.destination = body.destination;
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  if (body.lastRunAt !== undefined) data.lastRunAt = body.lastRunAt ? new Date(body.lastRunAt) : null;
  if (body.nextRunAt !== undefined) data.nextRunAt = body.nextRunAt ? new Date(body.nextRunAt) : null;

  const updated = await prisma.backupSchedule.update({
    where: { id: scheduleId },
    data,
    include: {
      _count: { select: { jobs: true } },
    },
  });

  return json(updated);
});

export const DELETE = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string; scheduleId: string }> }) => {
  await requireRole(req, "ADMIN");
  const { id, scheduleId } = await ctx.params;

  const existing = await prisma.backupSchedule.findUnique({ where: { id: scheduleId } });
  if (!existing || existing.serverId !== id) return json({ error: "Not found" }, { status: 404 });

  await prisma.backupSchedule.delete({ where: { id: scheduleId } });

  return json({ ok: true });
});
