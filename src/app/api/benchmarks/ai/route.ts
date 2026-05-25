import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { aiCostAgg, recordAiCost } from "@/lib/codeanalysis";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const days = Math.min(
    Math.max(Number(u.searchParams.get("days")) || 30, 1),
    365
  );
  const agg = await aiCostAgg(days);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.aiCostMetric.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });
  return json({ agg, rows, days });
});

const schema = z.object({
  module: z.string().min(1),
  model: z.string().min(1),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  latencyMs: z.number().int().min(0).optional().nullable(),
  commitSha: z.string().optional().nullable(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const row = await recordAiCost(body);
  await audit(user.id, "benchmarks.ai.record", row.id, {
    module: row.module,
    model: row.model,
    costUsd: row.costUsd,
  });
  return json(row, { status: 201 });
});
