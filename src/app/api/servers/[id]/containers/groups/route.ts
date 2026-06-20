import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { groupByCompose } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

// GET /api/servers/[id]/containers/groups — containers grouped by compose project → service
export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const { projects, ungrouped } = await groupByCompose(id);
  const mask = (c: any) => ({ ...c, env: maskSecrets(c.env) });
  return json({
    projects: projects.map((p) => ({
      ...p,
      services: p.services.map((s) => ({
        ...s,
        containers: s.containers.map(mask),
      })),
    })),
    ungrouped: ungrouped.map(mask),
  });
});
