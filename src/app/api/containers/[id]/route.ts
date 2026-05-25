import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { inspectContainer, statsSnapshot } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const { id } = ctx.params;
    const inspect: any = await inspectContainer(id);
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
      if (inspect?.State?.Running) stats = await statsSnapshot(id);
    } catch (e) {
      statsError = e instanceof Error ? e.message : "stats unavailable";
    }
    return json({ inspect, stats, statsError });
  }
);
