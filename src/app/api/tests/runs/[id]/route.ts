import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: any) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;
  const run = await prisma.testRun.findUnique({
    where: { id },
    include: {
      cases: {
        orderBy: [{ status: "asc" }, { classname: "asc" }, { name: "asc" }],
      },
    },
  });
  if (!run)
    throw new Response(JSON.stringify({ error: "Run not found" }), {
      status: 404,
    });
  return json(run);
});
