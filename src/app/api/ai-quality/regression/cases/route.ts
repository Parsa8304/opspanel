import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cases = await prisma.aiRegressionCase.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      runs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return json({ cases });
});

const schema = z.object({
  module: z.string().min(1),
  inputText: z.string().min(1),
  expectedNote: z.string().optional().nullable(),
  baselineOutput: z.string().optional().nullable(),
  baselineModel: z.string().optional().nullable(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const created = await prisma.aiRegressionCase.create({
    data: {
      module: body.module,
      inputText: body.inputText,
      expectedNote: body.expectedNote ?? null,
      baselineOutput: body.baselineOutput ?? null,
      baselineModel: body.baselineModel ?? null,
    },
  });
  await audit(user.id, "aiquality.regression.case.create", created.id, {
    module: created.module,
  });
  return json(created, { status: 201 });
});
