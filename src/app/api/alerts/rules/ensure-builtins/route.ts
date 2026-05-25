import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { ensureBuiltinRules } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const r = await ensureBuiltinRules();
  await audit(u.id, "alerts.rules.ensure-builtins", undefined, r);
  return json(r);
});
