import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publicFindings } from "@/lib/ports";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const host = req.nextUrl.searchParams.get("host");
  const hosts = host
    ? [host]
    : (await prisma.host.findMany({ select: { name: true } })).map(
        (h) => h.name
      );
  const out: Record<string, unknown>[] = [];
  for (const h of hosts) {
    for (const f of await publicFindings(h)) out.push({ hostName: h, ...f });
  }
  return json(out);
});
