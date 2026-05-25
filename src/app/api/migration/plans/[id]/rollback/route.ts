import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { rollbackMigration, MigrationRefusedError } from "@/lib/migration";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    try {
      await rollbackMigration(params.id);
      await audit(u.id, "migration.rollback", params.id, undefined, undefined);
      return json({ ok: true });
    } catch (e) {
      if (e instanceof MigrationRefusedError) {
        return json(
          { error: e.message, code: "migration_refused", reason: e.reason },
          { status: 422 }
        );
      }
      throw e;
    }
  }
);
