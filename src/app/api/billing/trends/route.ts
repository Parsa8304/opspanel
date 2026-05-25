import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { trends } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const days = parseInt(
    req.nextUrl.searchParams.get("days") || "30",
    10
  );
  return json({ days, points: await trends(days) });
});
