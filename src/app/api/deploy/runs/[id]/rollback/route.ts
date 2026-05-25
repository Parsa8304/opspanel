import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { rollback } from "@/lib/deploy";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const result = await rollback(ctx.params.id, u.id);
    await audit(
      u.id,
      "deploy.rollback",
      ctx.params.id,
      result,
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json(result);
  }
);
