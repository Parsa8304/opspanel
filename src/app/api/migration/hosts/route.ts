import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const hosts = await prisma.host.findMany({
    orderBy: { name: "asc" },
    select: { name: true, address: true, isLocal: true },
  });
  return json(hosts);
});
