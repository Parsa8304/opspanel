import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { getDeployRun } from "@/lib/deploy";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const run = await getDeployRun(ctx.params.id);
    if (!run) return json({ error: "not found" }, { status: 404 });
    return json(run);
  }
);
