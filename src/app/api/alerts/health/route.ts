import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { deliveryHealth, ingestionStatus } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const health = await deliveryHealth();
  return json({ ...health, ingestion: ingestionStatus() });
});
