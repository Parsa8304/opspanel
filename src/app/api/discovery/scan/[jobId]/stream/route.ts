import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { jobStreamResponse } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { jobId: string } }) => {
    await requireRole(req, "READONLY");
    return jobStreamResponse(ctx.params.jobId);
  }
);
