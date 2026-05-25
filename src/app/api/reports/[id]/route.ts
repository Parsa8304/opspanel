import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "REVIEWER");
    const report = await prisma.report.findUnique({
      where: { id: ctx.params.id },
      include: { createdBy: { select: { name: true } } },
    });
    if (!report) throw new Response("Not found", { status: 404 });
    return json(report);
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const existing = await prisma.report.findUnique({
      where: { id: ctx.params.id },
      select: { id: true, title: true, version: true },
    });
    if (!existing) throw new Response("Not found", { status: 404 });
    await prisma.report.delete({ where: { id: ctx.params.id } });
    await audit(user.id, "report.delete", existing.id, {
      title: existing.title,
      version: existing.version,
    });
    return json({ ok: true });
  }
);
