import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** GET /api/servers/[id]/ports?exposure=&range=&service= */
export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(req, "READONLY");
    const { id } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    const exposure = sp.get("exposure") || undefined; // public | local
    const service = sp.get("service") || undefined;
    const range = sp.get("range") || undefined; // "from-to"

    const where: Record<string, unknown> = { serverId: id };
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
      orderBy: [{ port: "asc" }],
    });
    return json(rows);
  }
);
