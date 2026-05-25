import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { applyProposalEffect } from "@/lib/discovery";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const p = await prisma.discoveryProposal.findUnique({
      where: { id: ctx.params.id },
    });
    if (!p) throw new Response("Not found", { status: 404 });
    if (p.status !== "pending")
      throw new Response(`Proposal is ${p.status}, not pending`, {
        status: 409,
      });

    const result = await applyProposalEffect(p.proposed as any);
    const updated = await prisma.discoveryProposal.update({
      where: { id: p.id },
      data: {
        status: "accepted",
        decidedById: u.id,
        decidedAt: new Date(),
      },
    });
    await audit(
      u.id,
      "discovery.proposal.accept",
      p.id,
      { effect: result.applied, ref: result.ref },
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json({ proposal: updated, applied: result });
  }
);
