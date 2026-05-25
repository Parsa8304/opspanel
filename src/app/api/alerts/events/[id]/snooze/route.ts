import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const Body = z.object({ hours: z.number().positive().max(720).default(1) });

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id } = ctx.params;
    const ev = await prisma.alertEvent.findUnique({ where: { id } });
    if (!ev) throw new Response("Not found", { status: 404 });
    const { hours } = Body.parse(await req.json().catch(() => ({})));
    const updated = await prisma.alertEvent.update({
      where: { id },
      data: {
        ackStatus: "snoozed",
        ackById: u.id,
        snoozeUntil: new Date(Date.now() + hours * 3600_000),
      },
    });
    await audit(u.id, "alerts.event.snooze", id, { hours });
    return json({ event: updated });
  }
);
