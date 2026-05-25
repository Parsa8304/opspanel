import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(u.searchParams.get("limit")) || 200, 1),
    1000
  );
  const rows = await prisma.codeMetric.findMany({
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return json({ rows });
});
