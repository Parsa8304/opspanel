import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const Body = z.object({ notes: z.string().optional() }).optional();

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id } = ctx.params;
    const ev = await prisma.alertEvent.findUnique({ where: { id } });
    if (!ev) throw new Response("Not found", { status: 404 });
    const body = Body.parse(await req.json().catch(() => ({})));
    const updated = await prisma.alertEvent.update({
      where: { id },
      data: {
        ackStatus: "acked",
        ackById: u.id,
        ackedAt: new Date(),
        notes: body?.notes ?? ev.notes,
      },
    });
    await audit(u.id, "alerts.event.ack", id);
    return json({ event: updated });
  }
);
