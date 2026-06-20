import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;
  const rows = await prisma.domain.findMany({ where: { serverId: id }, orderBy: { name: "asc" } });
  return json(rows);
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;
  const body = await req.json();
  if (!body.name) return json({ error: "name is required" }, { status: 400 });
  const row = await prisma.domain.create({
    data: {
      name: body.name.trim(),
      serverId: id,
      service: body.service ?? null,
      proxyTarget: body.proxyTarget ?? null,
      sslAutoRenew: body.sslAutoRenew ?? false,
      notes: body.notes ?? null,
    },
  });
  return json(row, { status: 201 });
});
