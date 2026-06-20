import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

// GET /api/servers — list registered remote servers (never returns key material),
// with a synthetic "local" entry prepended for the machine the panel itself runs on
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  const servers = await prisma.remoteServer.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, host: true, port: true, sshUser: true,
      fingerprint: true, tags: true, lastOkAt: true, lastError: true,
      createdById: true, createdAt: true,
    },
  });

  const local = {
    id: "local",
    name: "This server",
    host: "localhost",
    port: 0,
    sshUser: "",
    fingerprint: null,
    tags: ["local"],
    lastOkAt: new Date(),
    lastError: null,
    createdById: null,
    createdAt: new Date(0),
  };

  return json({ servers: [local, ...servers] });
});

// POST /api/servers — register a new server
export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = await req.json().catch(() => ({}));
  const { name, host, port, sshUser, privateKey, passphrase, tags } = body as {
    name?: string; host?: string; port?: number; sshUser?: string;
    privateKey?: string; passphrase?: string; tags?: string[];
  };

  if (!name || !host || !sshUser || !privateKey) {
    return json({ error: "name, host, sshUser, and privateKey are required" }, { status: 400 });
  }

  const server = await prisma.remoteServer.create({
    data: {
      name,
      host,
      port: Number(port) > 0 ? Number(port) : 22,
      sshUser,
      privateKey: encryptSecret(privateKey),
      passphrase: passphrase ? encryptSecret(passphrase) : null,
      tags: Array.isArray(tags) ? tags : [],
      createdById: u.id,
    },
    select: { id: true, name: true, host: true, port: true, sshUser: true, tags: true, createdAt: true },
  });

  await audit(u.id, "servers.created", server.id, { name, host });
  return json({ server }, { status: 201 });
});
