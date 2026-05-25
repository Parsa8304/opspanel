import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { runPortScanJob } from "@/lib/ports";

export const dynamic = "force-dynamic";

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  let hosts: string[] = [];
  try {
    const body = (await req.json()) as { hosts?: string[] };
    if (Array.isArray(body?.hosts)) hosts = body.hosts.filter(Boolean);
  } catch {
    /* empty body → scan all */
  }
  const jobId = await runPortScanJob(hosts, u.id);
  await audit(
    u.id,
    "ports.scan",
    jobId,
    { hosts },
    req.headers.get("x-forwarded-for") ?? undefined
  );
  return json({ jobId });
});
