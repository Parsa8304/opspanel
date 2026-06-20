import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { remoteExec } from "@/lib/remote";
import { hostExec } from "@/lib/server";

export const dynamic = "force-dynamic";

// GET /api/servers/[id]/containers — docker ps on a remote server (or the local host for id="local")
export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  let containers: { name: string; image: string; status: string; running: boolean }[] = [];
  let error: string | null = null;

  try {
    const cmd = `docker ps -a --format '{{json .}}' 2>&1`;
    const result = id === "local" ? await hostExec(cmd, 15000) : await remoteExec(id, cmd, 15000);
    const lines = result.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    containers = lines.map((l) => {
      const obj = JSON.parse(l);
      const status: string = obj.Status ?? "?";
      return {
        name: obj.Names ?? "?",
        image: obj.Image ?? "?",
        status,
        running: status.toLowerCase().startsWith("up"),
      };
    });
  } catch (e: any) {
    error = e?.message || String(e);
  }

  return json({ containers, error });
});
