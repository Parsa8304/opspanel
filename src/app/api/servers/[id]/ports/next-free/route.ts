import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { nextFreePort } from "@/lib/serverPorts";

export const dynamic = "force-dynamic";

/** GET /api/servers/[id]/ports/next-free?from=&to= */
export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(req, "READONLY");
    const { id } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    const from = parseInt(sp.get("from") || "", 10);
    const to = parseInt(sp.get("to") || "", 10);
    if (!Number.isFinite(from) || !Number.isFinite(to))
      throw new Response("from and to are required", { status: 400 });
    const port = await nextFreePort(id, from, to);
    return json({ from, to, port });
  }
);
