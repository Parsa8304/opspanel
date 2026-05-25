import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withEffective } from "@/lib/qa";

export const dynamic = "force-dynamic";

const schema = z.object({ result: z.enum(["PASSING", "FAILING"]) });

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const { result } = schema.parse(await req.json());
    const item = await prisma.regressionItem.update({
      where: { id: ctx.params.id },
      data: {
        status: result,
        lastVerifiedAt: new Date(),
        verifiedById: user.id,
      },
      include: {
        verifiedBy: { select: { id: true, name: true } },
        evidence: { orderBy: { createdAt: "asc" } },
      },
    });
    await audit(user.id, "qa.regression.verify", item.id, { result });
    return json(withEffective(item));
  }
);
