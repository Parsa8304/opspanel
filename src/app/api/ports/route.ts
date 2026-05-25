import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** GET /api/ports?host=&exposure=&range=&service= */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const sp = req.nextUrl.searchParams;
  const host = sp.get("host") || undefined;
  const exposure = sp.get("exposure") || undefined; // public | local
  const service = sp.get("service") || undefined;
  const range = sp.get("range") || undefined; // "from-to"

  const where: Record<string, unknown> = {};
  if (host) where.hostName = host;
  if (exposure === "public") where.isPublic = true;
  if (exposure === "local") where.isPublic = false;
  if (range) {
    const [a, b] = range.split("-").map((x) => parseInt(x.trim(), 10));
    if (Number.isFinite(a) && Number.isFinite(b))
      where.port = { gte: a, lte: b };
  }
  if (service) {
    where.OR = [
      { serviceName: { contains: service, mode: "insensitive" } },
      { containerName: { contains: service, mode: "insensitive" } },
      { processName: { contains: service, mode: "insensitive" } },
    ];
  }

  const rows = await prisma.portAllocation.findMany({
    where,
    orderBy: [{ hostName: "asc" }, { port: "asc" }],
  });
  return json(rows);
});
