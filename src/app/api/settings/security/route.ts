import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { masterKeyConfigured } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Read-only security posture for the Settings page. Reports only presence
 * booleans and counts — NEVER the secret values themselves.
 */
export const GET = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "READONLY");

  const jwtSecret = process.env.JWT_SECRET || "";
  const jwtSecretSet = jwtSecret.length >= 32;
  const masterKeySet = masterKeyConfigured();
  const isProd = process.env.NODE_ENV === "production";

  const me = await prisma.user.findUnique({
    where: { id: u.id },
    select: { totpEnabled: true },
  });

  const activeSessions = await prisma.session.count({
    where: { userId: u.id, revokedAt: null, expiresAt: { gt: new Date() } },
  });

  return json({
    jwtSecretSet,
    masterKeySet,
    isProd,
    totpEnabled: !!me?.totpEnabled,
    activeSessions,
    role: u.role,
  });
});
