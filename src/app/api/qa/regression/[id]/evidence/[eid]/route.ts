import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string; eid: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const ev = await prisma.evidence.findUnique({
      where: { id: ctx.params.eid },
    });
    if (!ev || ev.regressionItemId !== ctx.params.id)
      throw new Response("Not found", { status: 404 });
    await prisma.evidence.delete({ where: { id: ctx.params.eid } });
    await audit(user.id, "qa.regression.evidence.remove", ctx.params.id, {
      evidenceId: ctx.params.eid,
    });
    return json({ ok: true });
  }
);
