// Section 10 — Access Control helpers.
// HONESTY PRINCIPLE: effective scenario status is computed (reuse qa.isStale),
// never the stored value; the last-ADMIN guard is real, not assumed.

import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { requireRole, audit, type Role, type SessionUser } from "./auth";
import { isStale, type CheckStatus } from "./qa";

/**
 * Like requireRole(req, "ADMIN") but, when a non-admin (or anonymous-with-token)
 * is denied, records a real ROLE_ESCALATION_DENIED audit entry before rethrowing
 * the original 401/403 Response. The 403 still propagates unchanged.
 */
export async function requireAdminAudited(
  req: NextRequest,
  attemptedAction: string
): Promise<SessionUser> {
  try {
    return await requireRole(req, "ADMIN");
  } catch (e) {
    if (e instanceof Response && e.status === 403) {
      // We were authenticated (token valid) but lack ADMIN — a real escalation attempt.
      const sess = await getSessionSafe(req);
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
      await audit(
        sess?.id ?? null,
        "access.ROLE_ESCALATION_DENIED",
        attemptedAction,
        {
          attemptedAction,
          actorRole: sess?.role ?? null,
          actorEmail: sess?.email ?? null,
        },
        ip
      );
    }
    throw e;
  }
}

async function getSessionSafe(req: NextRequest): Promise<SessionUser | null> {
  try {
    const { getSession } = await import("./auth");
    return await getSession(req);
  } catch {
    return null;
  }
}

/**
 * Real guard: refuse to delete a user when doing so would remove the last
 * remaining ADMIN. Returns { allowed:false } honestly (caller turns it into 409).
 */
export async function canDeleteUser(
  userId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { allowed: false, reason: "not_found" };
  if (target.role === "ADMIN") {
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    if (admins <= 1)
      return { allowed: false, reason: "last_admin" };
  }
  return { allowed: true };
}

/** Same last-ADMIN guard, applied to a role *change* away from ADMIN. */
export async function canDemoteUser(
  userId: string,
  newRole: Role
): Promise<{ allowed: boolean; reason?: string }> {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return { allowed: false, reason: "not_found" };
  if (target.role === "ADMIN" && newRole !== "ADMIN") {
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    if (admins <= 1) return { allowed: false, reason: "last_admin" };
  }
  return { allowed: true };
}

export interface ScenarioLike {
  status: CheckStatus | string;
  lastVerifiedAt: Date | string | null;
  staleAfterDays?: number | null;
}

/** Decorate an AccessScenario with computed effectiveStatus/isStale (reuses qa). */
export function withScenarioStatus<T extends ScenarioLike>(
  s: T,
  now: Date = new Date()
) {
  const stale = isStale(s, now);
  const effectiveStatus: CheckStatus = stale
    ? "STALE"
    : s.status === "FAILING"
    ? "FAILING"
    : "PASSING";
  return { ...s, effectiveStatus, isStale: stale };
}
