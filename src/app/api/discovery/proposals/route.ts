import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const proposals = await prisma.discoveryProposal.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
  });
  return json(proposals);
});
