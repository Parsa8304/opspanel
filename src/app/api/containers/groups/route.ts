import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { groupByCompose } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const { projects, ungrouped } = await groupByCompose();
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
