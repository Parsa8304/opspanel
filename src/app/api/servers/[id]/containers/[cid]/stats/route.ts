import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { statsSnapshot } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; cid: string }> }) => {
    await requireRole(req, "READONLY");
    const { id, cid } = await ctx.params;
    const stats = await statsSnapshot(id, cid);
    return json(stats);
  }
);
