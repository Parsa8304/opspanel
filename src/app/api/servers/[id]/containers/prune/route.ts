import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { pruneContainers } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

// POST /api/servers/[id]/containers/prune — remove all stopped containers on this server
export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;

  const result = await pruneContainers(id);
  await audit(u.id, "container.prune", id, result, req.headers.get("x-forwarded-for") || undefined);
  return json({ ok: true, ...result });
});
