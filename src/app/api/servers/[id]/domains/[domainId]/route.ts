import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; domainId: string }> }) => {
    await requireRole(req, "READONLY");
    const { id, domainId } = await ctx.params;
    const row = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!row || row.serverId !== id) return json({ error: "Domain not found" }, { status: 404 });
    return json(row);
  }
);

export const PUT = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; domainId: string }> }) => {
    await requireRole(req, "ENGINEER");
    const { id, domainId } = await ctx.params;
    const existing = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!existing || existing.serverId !== id) return json({ error: "Domain not found" }, { status: 404 });

    const body = await req.json();
    const row = await prisma.domain.update({
      where: { id: domainId },
      data: {
        name: body.name?.trim(),
        service: body.service ?? undefined,
        proxyTarget: body.proxyTarget ?? undefined,
        sslAutoRenew: body.sslAutoRenew ?? undefined,
        notes: body.notes ?? undefined,
      },
    });
    return json(row);
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; domainId: string }> }) => {
    await requireRole(req, "ADMIN");
    const { id, domainId } = await ctx.params;
    const existing = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!existing || existing.serverId !== id) return json({ error: "Domain not found" }, { status: 404 });

    await prisma.domain.delete({ where: { id: domainId } });
    return json({ ok: true });
  }
);
