import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { pruneContainers } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const result = await pruneContainers();
  await audit(u.id, "container.prune", undefined, result, req.headers.get("x-forwarded-for") || undefined);
  return json({ ok: true, ...result });
});
