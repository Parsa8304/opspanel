import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { statsSnapshot } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const stats = await statsSnapshot(ctx.params.id);
    return json(stats);
  }
);
