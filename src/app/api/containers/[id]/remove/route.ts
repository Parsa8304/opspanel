import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { removeContainer } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id } = ctx.params;
    await removeContainer(id);
    await audit(u.id, "container.remove", id, undefined, req.headers.get("x-forwarded-for") || undefined);
    return json({ ok: true });
  }
);
