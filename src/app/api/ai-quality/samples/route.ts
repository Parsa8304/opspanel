import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { recordSample } from "@/lib/aiquality";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const where: Prisma.AiSampleWhereInput = {};
  const moduleParam = u.searchParams.get("module");
  const flag = u.searchParams.get("flag");
  const reviewStatus = u.searchParams.get("reviewStatus");
  if (moduleParam) where.module = moduleParam;
  if (flag) where.flag = flag as any;
  if (reviewStatus) where.reviewStatus = reviewStatus as any;
  const limit = Math.min(
    Math.max(Number(u.searchParams.get("limit")) || 100, 1),
    1000
  );
  const rows = await prisma.aiSample.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return json({ rows });
});

const schema = z.object({
  module: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().optional().nullable(),
  inputText: z.string().min(1),
  outputText: z.string().min(1),
  costUsd: z.number().min(0).optional().nullable(),
  latencyMs: z.number().int().min(0).optional().nullable(),
  flag: z.enum(["NONE", "HALLUCINATION", "REFUSAL", "ERROR"]).optional(),
  notes: z.string().optional().nullable(),
  tokensIn: z.number().int().min(0).optional(),
  tokensOut: z.number().int().min(0).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const row = await recordSample(body);
  await audit(user.id, "aiquality.sample.record", row.id, {
    module: row.module,
    model: row.model,
  });
  return json(row, { status: 201 });
});
