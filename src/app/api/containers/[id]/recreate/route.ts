import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { recreateContainer } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id } = ctx.params;
    const newId = await recreateContainer(id);
    await audit(u.id, "container.recreate", id, { newId }, req.headers.get("x-forwarded-for") || undefined);
    return json({ ok: true, newId });
  }
);
