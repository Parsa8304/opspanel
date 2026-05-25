import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { removeImage } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const DELETE = handler(async (req: NextRequest, ctx: { params: { id: string } }) => {
  const u = await requireRole(req, "ENGINEER");
  const id = decodeURIComponent(ctx.params.id);
  await removeImage(id);
  await audit(u.id, "image.remove", id, undefined, req.headers.get("x-forwarded-for") || undefined);
  return json({ ok: true });
});
