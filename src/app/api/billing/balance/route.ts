import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { liveBalance } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const provider = req.nextUrl.searchParams.get("provider");
  if (!provider) throw new Response("provider required", { status: 400 });
  const force = req.nextUrl.searchParams.get("force") === "true";
  const r = await liveBalance(provider, { force });
  return json(r);
});
