import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const schema = z.object({
  type: z.enum(["SCREENSHOT", "VIDEO", "TEST_OUTPUT", "LOG_LINK"]),
  url: z.string().min(1),
  label: z.string().optional().nullable(),
});

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const body = schema.parse(await req.json());
    const exists = await prisma.regressionItem.findUnique({
      where: { id: ctx.params.id },
      select: { id: true },
    });
    if (!exists) throw new Response("Not found", { status: 404 });
    const ev = await prisma.evidence.create({
      data: {
        regressionItemId: ctx.params.id,
        type: body.type,
        url: body.url,
        label: body.label ?? null,
      },
    });
    await audit(user.id, "qa.regression.evidence.add", ctx.params.id, {
      evidenceId: ev.id,
      type: ev.type,
    });
    return json(ev, { status: 201 });
  }
);
