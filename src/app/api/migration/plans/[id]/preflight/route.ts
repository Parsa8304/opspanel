import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { preflight, PreflightError } from "@/lib/migration";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    try {
      const r = await preflight(params.id);
      await audit(u.id, "migration.preflight", params.id, r, undefined);
      return json(r);
    } catch (e) {
      if (e instanceof PreflightError) {
        return json({ error: e.message, code: "preflight_blocked" }, { status: 422 });
      }
      throw e;
    }
  }
);
