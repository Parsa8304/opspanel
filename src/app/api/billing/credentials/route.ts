import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret, maskSecret, masterKeyConfigured } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/** List credentials — NEVER returns plaintext; only a masked hint. */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "ADMIN");
  const rows = await prisma.providerCredential.findMany({
    orderBy: [{ provider: "asc" }, { credType: "asc" }],
  });
  return json({
    masterKeyConfigured: masterKeyConfigured(),
    rows: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      credType: r.credType,
      scopeNotes: r.scopeNotes,
      rotationDueAt: r.rotationDueAt,
      createdAt: r.createdAt,
      // Masked hint only — reveal would require re-auth (out of scope).
      keyMasked: maskSecret(r.id),
    })),
  });
});

const Body = z.object({
  provider: z.string().min(1),
  credType: z.enum(["inference", "management"]),
  key: z.string().min(8),
  scopeNotes: z.string().nullish(),
  rotationDueAt: z.union([z.string(), z.date()]).nullish(),
});

/**
 * Store an inference OR management credential, encrypted at rest. The two
 * cred types are SEPARATE rows so rotating one never breaks the other.
 */
export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  if (!masterKeyConfigured())
    throw new Response("PANEL_MASTER_KEY not configured", { status: 400 });
  const b = Body.parse(await req.json());
  const keyEnc = encryptSecret(b.key);
  const row = await prisma.providerCredential.upsert({
    where: {
      provider_credType: { provider: b.provider, credType: b.credType },
    },
    create: {
      provider: b.provider,
      credType: b.credType,
      keyEnc,
      scopeNotes: b.scopeNotes ?? null,
      rotationDueAt: b.rotationDueAt ? new Date(b.rotationDueAt) : null,
    },
    update: {
      keyEnc,
      scopeNotes: b.scopeNotes ?? null,
      rotationDueAt: b.rotationDueAt ? new Date(b.rotationDueAt) : null,
    },
  });
  await audit(u.id, "billing.credential.upsert", row.id, {
    provider: b.provider,
    credType: b.credType,
  });
  // Never echo the key back.
  return json({
    id: row.id,
    provider: row.provider,
    credType: row.credType,
    saved: true,
  });
});

export const DELETE = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const id = req.nextUrl.searchParams.get("id");
  if (!id) throw new Response("id required", { status: 400 });
  await prisma.providerCredential.delete({ where: { id } });
  await audit(u.id, "billing.credential.delete", id);
  return json({ deleted: true });
});
