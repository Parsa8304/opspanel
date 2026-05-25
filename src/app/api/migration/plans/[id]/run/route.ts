import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { runMigration, MigrationRefusedError, PreflightError } from "@/lib/migration";

export const dynamic = "force-dynamic";

interface Body {
  activeWrites?: boolean;
}

export const POST = handler(
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const b = (await req.json().catch(() => ({}))) as Body;
    try {
      await runMigration(params.id, { activeWrites: !!b.activeWrites });
      await audit(u.id, "migration.run", params.id, undefined, undefined);
      return json({ ok: true });
    } catch (e) {
      if (e instanceof MigrationRefusedError) {
        return json(
          { error: e.message, code: "migration_refused", reason: e.reason },
          { status: 422 }
        );
      }
      if (e instanceof PreflightError) {
        return json({ error: e.message, code: "preflight_blocked" }, { status: 422 });
      }
      throw e;
    }
  }
);
