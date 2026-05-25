import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { flushQueued } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const r = await flushQueued();
  await audit(u.id, "alerts.flush", undefined, r);
  return json(r);
});
