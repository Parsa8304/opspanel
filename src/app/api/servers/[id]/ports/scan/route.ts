import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { runPortScanJob } from "@/lib/serverPorts";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = await ctx.params;
    const jobId = await runPortScanJob(id, u.id);
    await audit(
      u.id,
      "ports.scan",
      jobId,
      { serverId: id },
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json({ jobId });
  }
);
