import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { getPortsConfig, setPortsConfig, type PortsConfig } from "@/lib/ports";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  return json(await getPortsConfig());
});

export const PUT = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = (await req.json()) as PortsConfig;
  const saved = await setPortsConfig(body);
  await audit(
    u.id,
    "ports.config.update",
    "ports",
    saved,
    req.headers.get("x-forwarded-for") ?? undefined
  );
  return json(saved);
});
