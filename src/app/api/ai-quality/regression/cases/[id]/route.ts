import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const rc = await prisma.aiRegressionCase.findUnique({
      where: { id: ctx.params.id },
      include: { runs: { orderBy: { createdAt: "desc" } } },
    });
    if (!rc) return json({ error: "Not found" }, { status: 404 });
    return json(rc);
  }
);
