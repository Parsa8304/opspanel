import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret, maskSecret, masterKeyConfigured } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { name: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const name = ctx.params.name;
    const body = (await req.json()) as {
      address?: string;
      sshUser?: string;
      sshPort?: number;
      sshKey?: string; // write-only; encrypted before store
      os?: string;
      isLocal?: boolean;
    };

    const data: Record<string, unknown> = {};
    if (body.address !== undefined) data.address = body.address;
    if (body.sshUser !== undefined) data.sshUser = body.sshUser;
    if (body.sshPort !== undefined) data.sshPort = body.sshPort;
    if (body.os !== undefined) data.os = body.os;
    if (body.isLocal !== undefined) data.isLocal = body.isLocal;
    if (body.sshKey) {
      if (!masterKeyConfigured())
        throw new Response(
          "PANEL_MASTER_KEY is not configured — cannot store an SSH key securely.",
          { status: 400 }
        );
      data.sshKeyEnc = encryptSecret(body.sshKey);
    }

    const host = await prisma.host.update({ where: { name }, data });
    await audit(
      u.id,
      "ports.host.update",
      name,
      { fields: Object.keys(data) },
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json({
      name: host.name,
      address: host.address,
      sshUser: host.sshUser,
      sshPort: host.sshPort,
      sshKeySet: !!host.sshKeyEnc,
      sshKeyMasked: host.sshKeyEnc ? maskSecret(host.sshKeyEnc) : "",
      os: host.os,
      isLocal: host.isLocal,
      lastSeenAt: host.lastSeenAt,
    });
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { name: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const name = ctx.params.name;
    // PortAllocation rows cascade-delete via the schema relation.
    await prisma.host.delete({ where: { name } });
    await audit(
      u.id,
      "ports.host.delete",
      name,
      null,
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json({ ok: true });
  }
);
