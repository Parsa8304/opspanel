import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withEffective } from "@/lib/qa";

export const dynamic = "force-dynamic";

const ENVS = ["DEV", "STAGING", "DEMO", "OPERATIONAL", "PROD"] as const;

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const item = await prisma.regressionItem.findUnique({
      where: { id: ctx.params.id },
      include: {
        verifiedBy: { select: { id: true, name: true } },
        evidence: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!item) throw new Response("Not found", { status: 404 });
    return json(withEffective(item));
  }
);

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  testSteps: z.string().nullable().optional(),
  environment: z.enum(ENVS).optional(),
  staleAfterDays: z.number().int().positive().optional(),
});

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const data = patchSchema.parse(await req.json());
    const item = await prisma.regressionItem.update({
      where: { id: ctx.params.id },
      data,
      include: {
        verifiedBy: { select: { id: true, name: true } },
        evidence: { orderBy: { createdAt: "asc" } },
      },
    });
    await audit(user.id, "qa.regression.update", item.id, data);
    return json(withEffective(item));
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    await prisma.regressionItem.delete({ where: { id: ctx.params.id } });
    await audit(user.id, "qa.regression.delete", ctx.params.id);
    return json({ ok: true });
  }
);
