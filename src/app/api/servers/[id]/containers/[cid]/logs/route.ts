import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { getLogs } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; cid: string }> }) => {
    await requireRole(req, "READONLY");
    const { id, cid } = await ctx.params;
    const url = new URL(req.url);
    const tailRaw = url.searchParams.get("tail");
    const tail = tailRaw && tailRaw !== "all" ? parseInt(tailRaw, 10) || 500 : "all";
    const since = url.searchParams.get("since") || undefined;
    const download = url.searchParams.get("download") === "1";

    const text = await getLogs(id, cid, { tail, since });

    if (download) {
      return new Response(text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${cid.slice(0, 12)}-logs.txt"`,
        },
      });
    }
    return new Response(JSON.stringify({ logs: text }), {
      headers: { "content-type": "application/json" },
    });
  }
);
