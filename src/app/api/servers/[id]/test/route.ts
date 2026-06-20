import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { testConnection } from "@/lib/remote";
import { hostExec } from "@/lib/server";

export const dynamic = "force-dynamic";

// POST /api/servers/[id]/test — verify SSH connectivity (or local exec for id="local")
export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;

  let result: { ok: boolean; message: string };
  if (id === "local") {
    try {
      const { stdout } = await hostExec("uname -a && whoami", 15000);
      result = { ok: true, message: stdout.trim() };
    } catch (e: any) {
      result = { ok: false, message: e?.message || String(e) };
    }
  } else {
    result = await testConnection(id);
  }

  await audit(u.id, "servers.tested", id, { ok: result.ok });
  return json(result, { status: result.ok ? 200 : 502 });
});
