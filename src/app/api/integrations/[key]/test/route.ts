import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  testConnection,
  IntegrationNotConfiguredError,
  IntegrationDisabledError,
} from "@/lib/integrations";

export const dynamic = "force-dynamic";

export const POST = handler(
  async (req: NextRequest, ctx: { params: { key: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { key } = ctx.params;
    try {
      const result = await testConnection(key);
      await audit(
        u.id,
        "integration.test",
        key,
        { ok: result.ok, statusCode: result.statusCode },
        req.headers.get("x-forwarded-for") || undefined
      );
      return json({ tested: true, result });
    } catch (e) {
      if (
        e instanceof IntegrationNotConfiguredError ||
        e instanceof IntegrationDisabledError
      ) {
        await audit(
          u.id,
          "integration.test",
          key,
          { tested: false, reason: e.code },
          req.headers.get("x-forwarded-for") || undefined
        );
        return json(
          { tested: false, reason: e.code, error: e.message },
          { status: 409 }
        );
      }
      throw e;
    }
  }
);
