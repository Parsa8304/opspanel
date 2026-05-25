import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { commitMigration, MigrationRefusedError } from "@/lib/migration";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    try {
      await commitMigration(params.id);
      await audit(u.id, "migration.commit", params.id, undefined, undefined);
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
