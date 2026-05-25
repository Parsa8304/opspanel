import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ENVS = ["DEV", "STAGING", "DEMO", "OPERATIONAL", "PROD"] as const;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const rows = [];
  for (const env of ENVS) {
    const active = await prisma.deployment.findFirst({
      where: { environment: env, status: "active" },
      orderBy: { deployedAt: "desc" },
      include: { deployedBy: { select: { id: true, name: true } } },
    });
    rows.push({
      environment: env,
      deployed: !!active,
      version: active?.version ?? null,
      commitSha: active?.commitSha ?? null,
      shortSha: active ? active.commitSha.slice(0, 8) : null,
      deployedBy: active?.deployedBy?.name ?? null,
      deployedAt: active?.deployedAt ?? null,
      rollbackOfId: active?.rollbackOfId ?? null,
    });
  }
  return json(rows);
});
