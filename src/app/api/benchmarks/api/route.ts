import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(u.searchParams.get("limit")) || 500, 1),
    2000
  );
  const rows = await prisma.apiBenchmark.findMany({
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const distinct = await prisma.apiBenchmark.findMany({
    select: { endpoint: true },
    distinct: ["endpoint"],
    orderBy: { endpoint: "asc" },
  });
  return json({ rows, endpoints: distinct.map((d) => d.endpoint) });
});
