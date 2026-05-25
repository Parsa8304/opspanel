import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { jobStreamResponse } from "@/lib/jobs";
import { getDeployRun } from "@/lib/deploy";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const run = await getDeployRun(ctx.params.id);
    if (!run || !run.jobId) return json({ error: "no job" }, { status: 404 });
    return jobStreamResponse(run.jobId);
  }
);
