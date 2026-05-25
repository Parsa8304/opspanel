import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { withScenarioStatus } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const schema = z.object({
  result: z.enum(["PASSING", "FAILING"]),
  notes: z.string().nullable().optional(),
});

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const actor = await requireRole(req, "ENGINEER");
    const { result, notes } = schema.parse(await req.json());
    const s = await prisma.accessScenario.update({
      where: { id: ctx.params.id },
      data: {
        status: result,
        lastVerifiedAt: new Date(),
        verifiedById: actor.id,
        ...(notes !== undefined ? { notes } : {}),
      },
      include: { verifiedBy: { select: { id: true, name: true } } },
    });
    await audit(actor.id, "access.scenario.verify", s.id, { result });
    return json(withScenarioStatus(s));
  }
);
