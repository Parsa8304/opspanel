import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const severity = url.searchParams.get("severity");
  const source = url.searchParams.get("source");
  const limit = Math.min(
    500,
    parseInt(url.searchParams.get("limit") || "100", 10) || 100
  );

  const where: any = {};
  if (status) where.ackStatus = status;
  if (severity) where.severity = severity;
  if (source) where.source = source;

  const events = await prisma.alertEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      rule: { select: { id: true, name: true, builtin: true } },
      deliveries: {
        include: { channel: { select: { id: true, name: true, type: true } } },
      },
    },
  });
  return json({ events });
});
