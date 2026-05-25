// Shared Q/A helpers — HONESTY PRINCIPLE: staleness is computed, never assumed.

export type CheckStatus = "PASSING" | "FAILING" | "STALE";

export interface StaleInput {
  status: CheckStatus | string;
  lastVerifiedAt: Date | string | null;
  staleAfterDays?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the *effective* status of a regression-style item.
 *
 * If it was never verified, or was last verified longer ago than
 * `staleAfterDays` (default 30), it is STALE regardless of stored status.
 * Otherwise the stored PASSING / FAILING value is used. A stored STALE is
 * always STALE.
 */
export function effectiveStatus(
  item: StaleInput,
  now: Date = new Date()
): CheckStatus {
  if (isStale(item, now)) return "STALE";
  return item.status === "FAILING" ? "FAILING" : "PASSING";
}

export function isStale(item: StaleInput, now: Date = new Date()): boolean {
  if (!item.lastVerifiedAt) return true;
  if (item.status === "STALE") return true;
  const last =
    typeof item.lastVerifiedAt === "string"
      ? new Date(item.lastVerifiedAt)
      : item.lastVerifiedAt;
  if (isNaN(last.getTime())) return true;
  const days = item.staleAfterDays && item.staleAfterDays > 0 ? item.staleAfterDays : 30;
  return now.getTime() - last.getTime() > days * DAY_MS;
}

/** Days since last verification, or null if never verified. */
export function daysSinceVerified(
  lastVerifiedAt: Date | string | null,
  now: Date = new Date()
): number | null {
  if (!lastVerifiedAt) return null;
  const last =
    typeof lastVerifiedAt === "string" ? new Date(lastVerifiedAt) : lastVerifiedAt;
  if (isNaN(last.getTime())) return null;
  return Math.floor((now.getTime() - last.getTime()) / DAY_MS);
}

/** Decorate a regression item with computed effectiveStatus + isStale. */
export function withEffective<T extends StaleInput>(item: T, now: Date = new Date()) {
  return {
    ...item,
    effectiveStatus: effectiveStatus(item, now),
    isStale: isStale(item, now),
  };
}

export function humanizeModule(m: string): string {
  return m
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
