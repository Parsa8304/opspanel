import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret, maskSecret, masterKeyConfigured } from "@/lib/crypto";

export const dynamic = "force-dynamic";

function shape(h: {
  name: string;
  address: string;
  sshUser: string;
  sshPort: number;
  sshKeyEnc: string | null;
  os: string | null;
  isLocal: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}) {
  return {
    name: h.name,
    address: h.address,
    sshUser: h.sshUser,
    sshPort: h.sshPort,
    // NEVER return the key — only whether one is set, masked.
    sshKeySet: !!h.sshKeyEnc,
    sshKeyMasked: h.sshKeyEnc ? maskSecret(h.sshKeyEnc) : "",
    os: h.os,
    isLocal: h.isLocal,
    lastSeenAt: h.lastSeenAt,
    createdAt: h.createdAt,
  };
}

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const hosts = await prisma.host.findMany({ orderBy: { createdAt: "asc" } });
  return json(hosts.map(shape));
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = (await req.json()) as {
    name: string;
    address: string;
    sshUser?: string;
    sshPort?: number;
    sshKey?: string;
    isLocal?: boolean;
  };
  if (!body.name || !body.address)
    throw new Response("name and address are required", { status: 400 });

  let sshKeyEnc: string | null = null;
  if (body.sshKey) {
    if (!masterKeyConfigured())
      throw new Response(
        "PANEL_MASTER_KEY is not configured — cannot store an SSH key securely.",
        { status: 400 }
      );
    sshKeyEnc = encryptSecret(body.sshKey);
  }

  const host = await prisma.host.create({
    data: {
      name: body.name,
      address: body.address,
      sshUser: body.sshUser || "root",
      sshPort: body.sshPort || 22,
      sshKeyEnc,
      isLocal: !!body.isLocal,
    },
  });
  await audit(
    u.id,
    "ports.host.create",
    host.name,
    { address: host.address },
    req.headers.get("x-forwarded-for") ?? undefined
  );
  return json(shape(host));
});
