import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Samples needing manual review: a non-NONE flag OR still PENDING review. */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(u.searchParams.get("limit")) || 200, 1),
    1000
  );
  const rows = await prisma.aiSample.findMany({
    where: {
      OR: [{ flag: { not: "NONE" } }, { reviewStatus: "PENDING" }],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return json({ rows });
});
