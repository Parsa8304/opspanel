import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { COOKIE } from "./constants";

export { COOKIE };
export type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";

// Fail closed in production: a defaulted/short JWT secret lets anyone forge
// admin sessions on a panel that can run root commands. In production we refuse
// to start without a real secret; in dev/test we fall back to a known dev value
// so local work and the test suite still boot.
function resolveSecret(): string {
  const s = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!s || s.length < 32)
      throw new Error(
        "JWT_SECRET must be set (>=32 chars) in production. Refusing to start with a default secret."
      );
    return s;
  }
  return s || "dev-secret";
}

const SECRET = resolveSecret();
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** Internal JWT payload shape — includes jti for session linking. */
interface JwtPayload extends SessionUser {
  jti: string;
}

// ─── Session creation / revocation ───────────────────────────────────────────

/**
 * Sign a JWT with an embedded jti and persist a Session row.
 * Returns the signed token string.
 */
export async function createSession(
  u: SessionUser,
  req?: Pick<NextRequest, "headers">
): Promise<string> {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const ip = req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req?.headers.get("user-agent") ?? null;

  await prisma.session.create({
    data: {
      tokenId: jti,
      userId: u.id,
      expiresAt,
      ip,
      userAgent,
    },
  });

  const payload: JwtPayload = { ...u, jti };
  return jwt.sign(payload, SECRET, { expiresIn: SESSION_TTL_SECONDS });
}

/** Revoke a specific session by its jti. */
export async function revokeSession(tokenId: string): Promise<void> {
  await prisma.session
    .updateMany({
      where: { tokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {});
}

/** Revoke all sessions for a user (e.g. password reset). */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session
    .updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {});
}

// ─── Token verification ───────────────────────────────────────────────────────

function parseToken(token: string): JwtPayload | null {
  try {
    const d = jwt.verify(token, SECRET) as jwt.JwtPayload & JwtPayload;
    if (!d.jti) return null;
    return { id: d.id, email: d.email, name: d.name, role: d.role, jti: d.jti };
  } catch {
    return null;
  }
}

// Throttle lastSeenAt updates: only write if > 60s since last update
const LAST_SEEN_MIN_INTERVAL = 60 * 1000;

async function validateAndRefreshSession(
  parsed: JwtPayload
): Promise<SessionUser | null> {
  const session = await prisma.session
    .findUnique({ where: { tokenId: parsed.jti } })
    .catch(() => null);

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt < new Date()) return null;

  // Throttled lastSeenAt update
  const msSinceSeen = Date.now() - session.lastSeenAt.getTime();
  if (msSinceSeen > LAST_SEEN_MIN_INTERVAL) {
    prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => {});
  }

  return { id: parsed.id, email: parsed.email, name: parsed.name, role: parsed.role };
}

// ─── Public getSession ────────────────────────────────────────────────────────

/** Read and validate the session from the request (cookie or Bearer header). */
export async function getSession(
  req?: NextRequest
): Promise<SessionUser | null> {
  let token: string | undefined;
  if (req) {
    token =
      req.cookies.get(COOKIE)?.value ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  } else {
    token = (await cookies()).get(COOKIE)?.value;
  }
  if (!token) return null;
  const parsed = parseToken(token);
  if (!parsed) return null;
  return validateAndRefreshSession(parsed);
}

/** Extract the jti from a raw token string without DB validation (for logout). */
export function extractJti(token: string): string | null {
  const parsed = parseToken(token);
  return parsed?.jti ?? null;
}

// ─── Role helpers ─────────────────────────────────────────────────────────────

const RANK: Record<Role, number> = {
  READONLY: 0,
  REVIEWER: 1,
  ENGINEER: 2,
  ADMIN: 3,
};

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** Guard helper for route handlers. Returns user or throws a Response. */
export async function requireRole(
  req: NextRequest,
  min: Role = "READONLY"
): Promise<SessionUser> {
  const u = await getSession(req);
  if (!u) throw new Response("Unauthorized", { status: 401 });
  if (!atLeast(u.role, min)) throw new Response("Forbidden", { status: 403 });
  return u;
}

// ─── Password helpers ─────────────────────────────────────────────────────────

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

// ─── Legacy token helpers (used by tests) ────────────────────────────────────
// These sign/verify the raw JWT without persisting a Session row — only for use
// in unit tests. Production code must use createSession() instead.

export function signToken(u: SessionUser, options?: { expiresIn?: string | number }): string {
  const jti = crypto.randomUUID();
  const payload: JwtPayload = { ...u, jti };
  return jwt.sign(payload, SECRET, { expiresIn: (options?.expiresIn ?? SESSION_TTL_SECONDS) as any });
}

export function verifyToken(token: string): SessionUser | null {
  const parsed = parseToken(token);
  if (!parsed) return null;
  return { id: parsed.id, email: parsed.email, name: parsed.name, role: parsed.role };
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export async function audit(
  userId: string | null,
  action: string,
  target?: string,
  detail?: unknown,
  ip?: string
) {
  await prisma.auditLog
    .create({
      data: {
        userId: userId || undefined,
        action,
        target,
        detail: (detail as object) ?? undefined,
        ip,
      },
    })
    .catch(() => {});
}
