import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  getDiscoveryConfig,
  setDiscoveryConfig,
  type DiscoveryConfig,
} from "@/lib/discovery";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  return json(await getDiscoveryConfig());
});

export const PUT = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = (await req.json()) as DiscoveryConfig;
  const saved = await setDiscoveryConfig(body);
  await audit(
    u.id,
    "discovery.config.update",
    "discovery",
    saved,
    req.headers.get("x-forwarded-for") ?? undefined
  );
  return json(saved);
});
