import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jobStreamResponse } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// GET /api/servers/exec/[jobId]/stream — SSE log stream for an exec job
export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) => {
  await requireRole(req, "READONLY");
  const { jobId } = await ctx.params;

  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) return new Response("Job not found", { status: 404 });

  return jobStreamResponse(jobId);
});
