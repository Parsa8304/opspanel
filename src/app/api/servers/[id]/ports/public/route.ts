import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { publicFindings, hostNameForServer } from "@/lib/serverPorts";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(req, "READONLY");
    const { id } = await ctx.params;
    const hostName = await hostNameForServer(id);
    const out = (await publicFindings(id)).map((f) => ({ hostName, ...f }));
    return json(out);
  }
);
