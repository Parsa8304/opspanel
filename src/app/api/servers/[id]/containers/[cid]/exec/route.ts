import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { execInContainer } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

/**
 * Non-interactive command runner for a container on any server (local or
 * remote). Interactive PTY is intentionally not implemented, matching the
 * local-only /api/containers/[id]/exec route.
 */
export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; cid: string }> }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id, cid } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    let cmd: string[] = [];
    if (Array.isArray(body?.cmd)) cmd = body.cmd.map(String);
    else if (typeof body?.cmd === "string" && body.cmd.trim()) cmd = ["/bin/sh", "-c", body.cmd];
    if (cmd.length === 0) return json({ error: "cmd is required" }, { status: 400 });

    const { output, exitCode } = await execInContainer(id, cid, cmd);
    await audit(u.id, "container.exec", cid, { serverId: id, cmd }, req.headers.get("x-forwarded-for") || undefined);
    return json({ output, exitCode });
  }
);
