import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { stats } from "@/lib/aiquality";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const days = Math.min(
    Math.max(Number(u.searchParams.get("days")) || 30, 1),
    365
  );
  const perModule = await stats(days);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Lightweight time series for charts: real rows, no aggregation lies.
  const series = await prisma.aiSample.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: {
      module: true,
      model: true,
      modelVersion: true,
      humanRating: true,
      costUsd: true,
      flag: true,
      createdAt: true,
    },
    take: 5000,
  });
  return json({ perModule, series, days });
});
