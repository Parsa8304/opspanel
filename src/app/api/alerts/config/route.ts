import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json, setSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  getAlertsConfig,
  startIngestion,
  stopIngestion,
} from "@/lib/alerts";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  return json({ config: await getAlertsConfig() });
});

const Body = z.object({
  ingestLogs: z.boolean(),
  defaultChatRouting: z.string().nullable().optional(),
  panelBaseUrl: z.string().optional(),
});

export const PUT = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = Body.parse(await req.json());
  await setSetting("alerts", body);
  await audit(u.id, "alerts.config.update", undefined, {
    ingestLogs: body.ingestLogs,
  });
  // Apply ingestion toggle immediately (honest best-effort).
  if (body.ingestLogs) await startIngestion().catch(() => {});
  else stopIngestion();
  return json({ ok: true, config: body });
});
