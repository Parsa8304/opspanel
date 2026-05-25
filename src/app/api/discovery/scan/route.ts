import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { runDiscoveryJob } from "@/lib/discovery";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const jobId = await runDiscoveryJob(u.id);
  await audit(u.id, "discovery.scan", jobId, null, req.headers.get("x-forwarded-for") ?? undefined);
  return json({ jobId });
});
