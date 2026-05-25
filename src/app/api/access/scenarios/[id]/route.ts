import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { requireAdminAudited, withScenarioStatus } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    staleAfterDays: z.number().int().positive().optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "Nothing to update" });

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const actor = await requireRole(req, "ENGINEER");
    const body = patchSchema.parse(await req.json());
    const s = await prisma.accessScenario.update({
      where: { id: ctx.params.id },
      data: body,
      include: { verifiedBy: { select: { id: true, name: true } } },
    });
    await audit(actor.id, "access.scenario.update", s.id, body);
    return json(withScenarioStatus(s));
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const actor = await requireAdminAudited(req, "access.scenario.delete");
    await prisma.accessScenario.delete({ where: { id: ctx.params.id } });
    await audit(actor.id, "access.scenario.delete", ctx.params.id);
    return json({ ok: true });
  }
);
