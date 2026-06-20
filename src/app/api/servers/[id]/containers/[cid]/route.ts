import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { inspectContainer, statsSnapshot } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

// GET /api/servers/[id]/containers/[cid] — inspect + live stats for a single container
export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; cid: string }> }) => {
    await requireRole(req, "READONLY");
    const { id, cid } = await ctx.params;

    const inspect: any = await inspectContainer(id, cid);
    if (inspect?.Config?.Env) {
      const envObj: Record<string, string> = {};
      for (const e of inspect.Config.Env as string[]) {
        const i = e.indexOf("=");
        envObj[i === -1 ? e : e.slice(0, i)] = i === -1 ? "" : e.slice(i + 1);
      }
      inspect.Config.Env = maskSecrets(envObj);
    }
    let stats = null;
    let statsError: string | null = null;
    try {
      if (inspect?.State?.Running) stats = await statsSnapshot(id, cid);
    } catch (e) {
      statsError = e instanceof Error ? e.message : "stats unavailable";
    }
    return json({ inspect, stats, statsError });
  }
);
