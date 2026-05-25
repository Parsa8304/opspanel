import { prisma } from "./prisma";

/** Per-integration config stored in Integration.config (Json). */
export interface IntegrationConfig {
  baseUrl?: string;
  healthPath?: string;
  authHeader?: string;
  apiKey?: string;
  monthlyQuota?: number;
  rateLimitPerMin?: number;
}

export class IntegrationNotConfiguredError extends Error {
  code = "NOT_CONFIGURED" as const;
  constructor(msg = "Integration is not configured") {
    super(msg);
    this.name = "IntegrationNotConfiguredError";
  }
}
export class IntegrationDisabledError extends Error {
  code = "DISABLED" as const;
  constructor(msg = "Integration is disabled") {
    super(msg);
    this.name = "IntegrationDisabledError";
  }
}

export interface TestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface StatsWindow {
  windowHours: number;
  count: number;
  successCount: number;
  errorCount: number;
  successRate: number | null; // null when no calls in window
  errorRate: number | null;
  avgLatency: number | null;
  p95Latency: number | null;
  totalCost: number | null; // null when no costUsd recorded at all
  lastSuccessAt: string | null;
  lastCallAt: string | null;
}

export interface QuotaUsage {
  monthlyQuota: number | null;
  callsThisMonth: number;
  quotaUsedPct: number | null; // null when no quota configured
  rateLimitPerMin: number | null;
  callsLastMinute: number;
  rateHeadroom: number | null; // remaining calls in current minute, null when unset
}

async function getIntegration(key: string) {
  const i = await prisma.integration.findUnique({ where: { key } });
  if (!i) throw new IntegrationNotConfiguredError(`Unknown integration: ${key}`);
  return i;
}

export function readConfig(raw: unknown): IntegrationConfig {
  if (!raw || typeof raw !== "object") return {};
  return raw as IntegrationConfig;
}

/** Record a real IntegrationCall row. Never fabricates fields. */
export async function recordCall(
  integrationKey: string,
  data: {
    success: boolean;
    statusCode?: number | null;
    latencyMs?: number | null;
    costUsd?: number | null;
    error?: string | null;
  }
) {
  const i = await getIntegration(integrationKey);
  return prisma.integrationCall.create({
    data: {
      integrationId: i.id,
      success: data.success,
      statusCode: data.statusCode ?? null,
      latencyMs: data.latencyMs ?? null,
      costUsd: data.costUsd ?? null,
      error: data.error ?? null,
    },
  });
}

/**
 * Perform a REAL outbound HTTP request to the configured health endpoint,
 * measure real latency, and record a real IntegrationCall with the outcome.
 * Throws an honest typed error (recording nothing) if disabled/unconfigured.
 */
export async function testConnection(
  integrationKey: string
): Promise<TestResult> {
  const i = await getIntegration(integrationKey);
  if (!i.enabled) throw new IntegrationDisabledError();
  const cfg = readConfig(i.config);
  if (!cfg.baseUrl)
    throw new IntegrationNotConfiguredError("No baseUrl configured");

  const url = cfg.baseUrl.replace(/\/$/, "") + (cfg.healthPath || "");
  const headers: Record<string, string> = {};
  if (cfg.authHeader) headers["Authorization"] = cfg.authHeader;
  else if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  const start = Date.now();
  let result: TestResult;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: ac.signal,
      redirect: "follow",
    });
    const latencyMs = Date.now() - start;
    // Consume body so the socket can be reused/closed cleanly.
    await res.arrayBuffer().catch(() => {});
    result = {
      ok: res.ok,
      statusCode: res.status,
      latencyMs,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const msg =
      e instanceof Error
        ? e.name === "AbortError"
          ? "Request timed out after 8s"
          : e.message
        : "Network error";
    result = { ok: false, statusCode: null, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }

  await recordCall(integrationKey, {
    success: result.ok,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    error: result.error,
  });
  return result;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

/** Compute stats purely from real IntegrationCall rows in the window. */
export async function stats(
  integrationKey: string,
  windowHours: number
): Promise<StatsWindow> {
  const i = await getIntegration(integrationKey);
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows = await prisma.integrationCall.findMany({
    where: { integrationId: i.id, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });

  const count = rows.length;
  const successCount = rows.filter((r) => r.success).length;
  const errorCount = count - successCount;
  const latencies = rows
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  const costRows = rows.filter((r) => typeof r.costUsd === "number");

  const lastCall = rows[0] ?? null;
  const lastSuccess = rows.find((r) => r.success) ?? null;

  return {
    windowHours,
    count,
    successCount,
    errorCount,
    successRate: count ? successCount / count : null,
    errorRate: count ? errorCount / count : null,
    avgLatency: latencies.length
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null,
    p95Latency: percentile(latencies, 95),
    totalCost: costRows.length
      ? costRows.reduce((a, r) => a + (r.costUsd as number), 0)
      : null,
    lastSuccessAt: lastSuccess ? lastSuccess.createdAt.toISOString() : null,
    lastCallAt: lastCall ? lastCall.createdAt.toISOString() : null,
  };
}

/** Quota + rate-limit headroom from real rows vs configured limits. */
export async function quotaUsage(
  integrationKey: string
): Promise<QuotaUsage> {
  const i = await getIntegration(integrationKey);
  const cfg = readConfig(i.config);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const callsThisMonth = await prisma.integrationCall.count({
    where: { integrationId: i.id, createdAt: { gte: monthStart } },
  });
  const minuteAgo = new Date(now.getTime() - 60_000);
  const callsLastMinute = await prisma.integrationCall.count({
    where: { integrationId: i.id, createdAt: { gte: minuteAgo } },
  });

  const monthlyQuota =
    typeof cfg.monthlyQuota === "number" && cfg.monthlyQuota > 0
      ? cfg.monthlyQuota
      : null;
  const rateLimitPerMin =
    typeof cfg.rateLimitPerMin === "number" && cfg.rateLimitPerMin > 0
      ? cfg.rateLimitPerMin
      : null;

  return {
    monthlyQuota,
    callsThisMonth,
    quotaUsedPct:
      monthlyQuota != null ? (callsThisMonth / monthlyQuota) * 100 : null,
    rateLimitPerMin,
    callsLastMinute,
    rateHeadroom:
      rateLimitPerMin != null
        ? Math.max(rateLimitPerMin - callsLastMinute, 0)
        : null,
  };
}

export const STAT_WINDOWS = [
  { key: "24h", hours: 24 },
  { key: "7d", hours: 24 * 7 },
  { key: "30d", hours: 24 * 30 },
] as const;

/** Days until credential expiry, negative if past. null when unset. */
export function expiryInfo(credentialExpiresAt: Date | null | undefined) {
  if (!credentialExpiresAt) return { days: null as number | null, warn: false, expired: false };
  const days = Math.floor(
    (credentialExpiresAt.getTime() - Date.now()) / 86_400_000
  );
  return { days, warn: days <= 14, expired: days < 0 };
}
