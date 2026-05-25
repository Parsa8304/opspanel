import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deliver } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/** Send a real test message through the channel. Honest result. */
export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = ctx.params;
    const ch = await prisma.alertChannel.findUnique({ where: { id } });
    if (!ch) throw new Response("Not found", { status: 404 });

    // Create a transient test event + delivery, attempt a real send.
    const ev = await prisma.alertEvent.create({
      data: {
        severity: "INFO",
        source: "alerts_test",
        title: "Panel test alert",
        payload: { line: "This is a real test message from the panel." },
      },
    });
    const del = await prisma.alertDelivery.create({
      data: { eventId: ev.id, channelId: ch.id, status: "pending" },
    });
    const result = await deliver(del.id);
    const fresh = await prisma.alertDelivery.findUnique({
      where: { id: del.id },
    });
    await audit(u.id, "alerts.channel.test", id, { status: result.status });
    return json({
      status: result.status,
      delivered: result.status === "delivered",
      lastError: fresh?.lastError ?? null,
      eventId: ev.id,
    });
  }
);
