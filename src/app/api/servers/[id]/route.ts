import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// DELETE /api/servers/[id] — remove a registered server
export const DELETE = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;

  if (id === "local") return json({ error: "Cannot remove the local server" }, { status: 400 });

  const server = await prisma.remoteServer.findUnique({ where: { id }, select: { name: true } });
  if (!server) return json({ error: "Server not found" }, { status: 404 });

  await prisma.remoteServer.delete({ where: { id } });
  await audit(u.id, "servers.deleted", id, { name: server.name });
  return json({ ok: true });
});
