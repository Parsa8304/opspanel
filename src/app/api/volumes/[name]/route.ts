import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { removeVolume } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const DELETE = handler(async (req: NextRequest, ctx: { params: { name: string } }) => {
  const u = await requireRole(req, "ENGINEER");
  const name = decodeURIComponent(ctx.params.name);
  await removeVolume(name);
  await audit(u.id, "volume.remove", name, undefined, req.headers.get("x-forwarded-for") || undefined);
  return json({ ok: true });
});
