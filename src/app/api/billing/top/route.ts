import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { topConsumers } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const limit = parseInt(
    req.nextUrl.searchParams.get("limit") || "10",
    10
  );
  return json(await topConsumers(limit));
});
