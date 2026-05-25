import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Strategy } from "@/lib/migration";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const plans = await prisma.migrationPlan.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return json(plans);
});

interface Body {
  sourceHostName: string;
  targetHostName: string;
  service: string;
  volumes?: string[];
  strategy: Strategy;
  expectedDowntime?: string;
}

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const b = (await req.json()) as Body;
  if (!b?.sourceHostName || !b?.targetHostName || !b?.service || !b?.strategy) {
    return json(
      { error: "sourceHostName, targetHostName, service and strategy are required" },
      { status: 400 }
    );
  }
  const plan = await prisma.migrationPlan.create({
    data: {
      sourceHostName: b.sourceHostName,
      targetHostName: b.targetHostName,
      service: b.service,
      volumes: b.volumes ?? [],
      strategy: b.strategy,
      expectedDowntime: b.expectedDowntime ?? null,
      status: "planned",
      createdById: u.id,
    },
  });
  await audit(
    u.id,
    "migration.plan.create",
    plan.id,
    { service: b.service, strategy: b.strategy },
    req.headers.get("x-forwarded-for") ?? undefined
  );
  return json(plan);
});
