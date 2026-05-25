import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { nextFreePort } from "@/lib/ports";

export const dynamic = "force-dynamic";

/** GET /api/ports/next-free?host=&from=&to= */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const sp = req.nextUrl.searchParams;
  const host = sp.get("host");
  const from = parseInt(sp.get("from") || "", 10);
  const to = parseInt(sp.get("to") || "", 10);
  if (!host || !Number.isFinite(from) || !Number.isFinite(to))
    throw new Response("host, from and to are required", { status: 400 });
  const port = await nextFreePort(host, from, to);
  return json({ host, from, to, port });
});
