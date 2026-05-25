import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureHost } from "@/lib/ports";

export const dynamic = "force-dynamic";

/** Manually register a PortAllocation (discoveredVia "manual"). */
export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = (await req.json()) as {
    hostName: string;
    port: number;
    protocol?: string;
    iface?: string;
    serviceName?: string;
    processName?: string;
    isPublic?: boolean;
  };
  if (!body.hostName || !Number.isFinite(body.port))
    throw new Response("hostName and port are required", { status: 400 });

  await ensureHost(body.hostName);
  const protocol = body.protocol || "tcp";
  const iface = body.iface || "0.0.0.0";
  const now = new Date();
  const row = await prisma.portAllocation.upsert({
    where: {
      hostName_port_protocol_iface: {
        hostName: body.hostName,
        port: body.port,
        protocol,
        iface,
      },
    },
    create: {
      hostName: body.hostName,
      port: body.port,
      protocol,
      iface,
      serviceName: body.serviceName ?? null,
      processName: body.processName ?? null,
      discoveredVia: "manual",
      isPublic: body.isPublic ?? (iface === "0.0.0.0" || iface === "::"),
      status: "active",
      firstSeen: now,
      lastSeen: now,
    },
    update: {
      serviceName: body.serviceName ?? null,
      processName: body.processName ?? null,
      discoveredVia: "manual",
      isPublic: body.isPublic ?? (iface === "0.0.0.0" || iface === "::"),
      status: "active",
      lastSeen: now,
    },
  });
  await audit(
    u.id,
    "ports.manual.register",
    `${body.hostName}:${body.port}/${protocol}`,
    null,
    req.headers.get("x-forwarded-for") ?? undefined
  );
  return json(row);
});
