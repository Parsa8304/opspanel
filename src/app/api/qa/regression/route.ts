import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withEffective } from "@/lib/qa";

export const dynamic = "force-dynamic";

const MODULES = [
  "LOGIN","PROJECT_MANAGEMENT","QUICK_REPORT","DECISION_ENGINE","GTM_STRATEGY",
  "PITCH_DECK","PITCH_TO_VC","FIND_EXPERTS","AI_RESEARCH_ASSISTANT","ASYNC_PROCESSING",
  "WEBSOCKET","STORAGE","SEARCH","EXTERNAL_INTEGRATIONS","AI_INTEGRATIONS",
  "ACCESS_CONTROL","DEPLOYMENT","OVERALL_READINESS",
] as const;
const ENVS = ["DEV","STAGING","DEMO","OPERATIONAL","PROD"] as const;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const items = await prisma.regressionItem.findMany({
    orderBy: { module: "asc" },
    include: {
      verifiedBy: { select: { id: true, name: true } },
      evidence: { orderBy: { createdAt: "asc" } },
    },
  });
  return json(items.map((i) => withEffective(i)));
});

const createSchema = z.object({
  module: z.enum(MODULES),
  title: z.string().min(1),
  testSteps: z.string().optional().nullable(),
  environment: z.enum(ENVS).optional(),
  staleAfterDays: z.number().int().positive().optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = createSchema.parse(await req.json());
  const item = await prisma.regressionItem.create({
    data: {
      module: body.module,
      title: body.title,
      testSteps: body.testSteps ?? null,
      environment: body.environment ?? "DEMO",
      staleAfterDays: body.staleAfterDays ?? 30,
      status: "STALE",
    },
    include: {
      verifiedBy: { select: { id: true, name: true } },
      evidence: true,
    },
  });
  await audit(user.id, "qa.regression.create", item.id, { title: item.title });
  return json(withEffective(item), { status: 201 });
});
