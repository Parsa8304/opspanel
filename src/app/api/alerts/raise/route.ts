import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { raiseAlert } from "@/lib/alerts";

export const dynamic = "force-dynamic";

const Body = z.object({
  ruleId: z.string().optional(),
  source: z.string().min(1),
  severity: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]),
  title: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  containerName: z.string().optional(),
});

/** Internal entrypoint other sections/tests use to raise a real alert. */
export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const body = Body.parse(await req.json());
  const r = await raiseAlert(body);
  await audit(u.id, "alerts.raise", r.eventId, {
    source: body.source,
    severity: body.severity,
    suppressed: r.suppressed,
  });
  return json(r);
});
