import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { unpauseContainer } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; cid: string }> }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id, cid } = await ctx.params;
    await unpauseContainer(id, cid);
    await audit(u.id, "container.unpause", cid, { serverId: id }, req.headers.get("x-forwarded-for") || undefined);
    return json({ ok: true });
  }
);
