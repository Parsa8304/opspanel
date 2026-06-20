import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hostNameForServer } from "@/lib/serverPorts";

export const dynamic = "force-dynamic";

/** Manually register a PortAllocation for this server (discoveredVia "manual"). */
export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      port: number;
      protocol?: string;
      iface?: string;
      serviceName?: string;
      processName?: string;
      isPublic?: boolean;
    };
    if (!Number.isFinite(body.port))
      throw new Response("port is required", { status: 400 });

    const hostName = await hostNameForServer(id);
    const existingHost = await prisma.host.findUnique({ where: { name: hostName } });
    if (!existingHost) {
      await prisma.host.create({
        data: {
          name: hostName,
          address: id === "local" ? "127.0.0.1" : hostName,
          isLocal: id === "local",
          lastSeenAt: new Date(),
        },
      });
    }

    const protocol = body.protocol || "tcp";
    const iface = body.iface || "0.0.0.0";
    const now = new Date();
    const row = await prisma.portAllocation.upsert({
      where: {
        serverId_hostName_port_protocol_iface: {
          serverId: id,
          hostName,
          port: body.port,
          protocol,
          iface,
        },
      },
      create: {
        serverId: id,
        hostName,
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
      `${id}:${body.port}/${protocol}`,
      null,
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json(row);
  }
);
