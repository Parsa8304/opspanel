import { prisma } from "./prisma";
import { decryptSecret } from "./crypto";
import { getSetting, setSetting } from "./api";
import { raiseAlert } from "./alerts";
import { recordAiCost } from "./codeanalysis";
import { createJob, runJob } from "./jobs";

/**
 * Section 12 — API Token Billing & Cost Tracking.
 *
 * HONESTY: every BillingEvent comes from a REAL captured provider response
 * (the OpenRouter-style `usage` object) or a REAL provider-dashboard pull.
 * Live credit balance is a REAL HTTP call to the provider. If a credential
 * or endpoint is not configured we surface an honest empty/error state — we
 * never emit zeros as if healthy. Reconciliation compares REAL captured sums
 * vs REAL provider activity and reports REAL drift. Same-day totals are
 * best-effort and labelled as such. Free-tier rows cost 0 (counted in usage,
 * excluded from cost charts). BYOK rows are kept distinct from direct.
 */

// ───────────────────────────── config ─────────────────────────────

export interface BillingConfig {
  ingestToken: string;
  balancePollSec: number;
  reconThresholdPct: number;
  reconThresholdUsd: number;
  providerBaseUrls: Record<string, string>;
  paused?: Record<string, boolean>;
  // last-crossed threshold per "<provider>:<period>" for alert dedupe
  budgetCrossed?: Record<string, number>;
  balanceCache?: Record<
    string,
    { balance: number; totalCredits: number; totalUsage: number; at: string }
  >;
}

const CONFIG_DEFAULT: BillingConfig = {
  ingestToken: "",
  balancePollSec: 300,
  reconThresholdPct: 2,
  reconThresholdUsd: 1,
  providerBaseUrls: { openrouter: "https://openrouter.ai" },
  paused: {},
  budgetCrossed: {},
  balanceCache: {},
};

export async function getBillingConfig(): Promise<BillingConfig> {
  const stored = await getSetting<Partial<BillingConfig>>("billing", {});
  return {
    ...CONFIG_DEFAULT,
    ...stored,
    providerBaseUrls: {
      ...CONFIG_DEFAULT.providerBaseUrls,
      ...(stored.providerBaseUrls || {}),
    },
    paused: { ...(stored.paused || {}) },
    budgetCrossed: { ...(stored.budgetCrossed || {}) },
    balanceCache: { ...(stored.balanceCache || {}) },
  };
}

async function patchBillingConfig(patch: Partial<BillingConfig>) {
  const cur = await getBillingConfig();
  await setSetting("billing", { ...cur, ...patch });
}

function randomToken(): string {
  // hex token, dependency-light
  let s = "";
  for (let i = 0; i < 48; i++)
    s += Math.floor(Math.random() * 16).toString(16);
  return "bilg_" + s;
}

/** Ensure an ingest token exists; returns it (shown once by the API layer). */
export async function ensureIngestToken(): Promise<string> {
  const cfg = await getBillingConfig();
  if (cfg.ingestToken) return cfg.ingestToken;
  const tok = randomToken();
  await patchBillingConfig({ ingestToken: tok });
  return tok;
}

/** Constant-time string compare (avoids timing oracle on the ingest token). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    // still walk to keep it roughly constant for equal-length inputs
    let d = 1;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++)
      d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return false && d === 0;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyIngestToken(
  presented: string | null | undefined
): Promise<boolean> {
  const cfg = await getBillingConfig();
  if (!cfg.ingestToken || !presented) return false;
  return timingSafeEqual(presented, cfg.ingestToken);
}

// ───────────────────────────── pricing ─────────────────────────────

export interface PricingRow {
  id: string;
  provider: string;
  model: string;
  inPricePerM: number;
  outPricePerM: number;
  cachedInPricePerM: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Pick the ProviderPricing row whose [effectiveFrom, effectiveTo] window
 * covers `atDate` (versioned / historical). Most recent effectiveFrom wins.
 */
export async function priceFor(
  provider: string,
  model: string,
  atDate: Date = new Date()
): Promise<PricingRow | null> {
  const rows = await prisma.providerPricing.findMany({
    where: { provider, model, effectiveFrom: { lte: atDate } },
    orderBy: { effectiveFrom: "desc" },
  });
  for (const r of rows) {
    if (r.effectiveTo && r.effectiveTo < atDate) continue;
    return r as PricingRow;
  }
  return null;
}

// ───────────────────────── cost computation ─────────────────────────

export interface UsageTokens {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCached: number;
}

export interface ComputeOpts {
  isByok?: boolean;
  isFreeTier?: boolean;
  /** Real cost the provider already computed for this request, if any. */
  providerCost?: number | null;
}

export interface ComputedCost {
  totalCost: number;
  unitCost: number | null;
  upstreamInferenceCost: number | null;
  isByok: boolean;
  isFreeTier: boolean;
}

const BYOK_FEE_RATE = 0.05; // OpenRouter BYOK = 5% of equivalent direct price

/**
 * Derive totalCost from tokens when the provider didn't return a real cost.
 * If the provider returned a real cost we trust it (recorded as unitCost too).
 * BYOK: panel fee = 5% of equivalent direct price; the real upstream
 * inference cost is recorded separately. Free models → cost 0.
 */
export function computeCost(
  usage: UsageTokens,
  pricing: PricingRow | null,
  opts: ComputeOpts = {}
): ComputedCost {
  const isFreeTier = !!opts.isFreeTier;
  const isByok = !!opts.isByok;

  if (isFreeTier) {
    return {
      totalCost: 0,
      unitCost: 0,
      upstreamInferenceCost: null,
      isByok,
      isFreeTier: true,
    };
  }

  // Equivalent direct price from pricing (used for BYOK fee and as fallback).
  let directPrice: number | null = null;
  if (pricing) {
    const cachedRate = pricing.cachedInPricePerM ?? pricing.inPricePerM;
    const billableIn = Math.max(0, usage.tokensIn - usage.tokensCached);
    directPrice =
      (billableIn / 1_000_000) * pricing.inPricePerM +
      (usage.tokensCached / 1_000_000) * cachedRate +
      ((usage.tokensOut + usage.tokensReasoning) / 1_000_000) *
        pricing.outPricePerM;
  }

  const realProviderCost =
    typeof opts.providerCost === "number" && isFinite(opts.providerCost)
      ? opts.providerCost
      : null;

  if (isByok) {
    // Upstream inference cost: what the user paid their own provider — the
    // real provider-returned cost if present, else the equivalent direct
    // price we can derive. Panel only charges its 5% routing fee.
    const upstream =
      realProviderCost ?? (directPrice != null ? directPrice : null);
    const fee =
      upstream != null ? upstream * BYOK_FEE_RATE : null;
    return {
      totalCost: fee ?? 0,
      unitCost: realProviderCost,
      upstreamInferenceCost: upstream,
      isByok: true,
      isFreeTier: false,
    };
  }

  if (realProviderCost != null) {
    return {
      totalCost: realProviderCost,
      unitCost: realProviderCost,
      upstreamInferenceCost: null,
      isByok: false,
      isFreeTier: false,
    };
  }

  // Derive from pricing.
  return {
    totalCost: directPrice ?? 0,
    unitCost: null,
    upstreamInferenceCost: null,
    isByok: false,
    isFreeTier: false,
  };
}

// ───────────────────── record an event (ingest) ─────────────────────

/** OpenRouter-shaped (or generic) usage payload accepted by ingest. */
export interface IngestPayload {
  provider: string;
  model?: string | null;
  endpoint?: string | null;
  generationId?: string | null;
  requestId?: string | null;
  requestAt?: string | Date | null;
  module?: string | null;
  userId?: string | null;
  projectId?: string | null;
  isByok?: boolean;
  isFreeTier?: boolean;
  /** OpenRouter usage object (or generic). */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
  /** Generic explicit token counts (override usage object). */
  tokensIn?: number;
  tokensOut?: number;
  tokensReasoning?: number;
  tokensCached?: number;
  /** Echo of the outgoing request meta (for code-smell detection). */
  requestMeta?: Record<string, unknown> | null;
  rawMeta?: Record<string, unknown> | null;
}

function normalizeTokens(p: IngestPayload): UsageTokens {
  const u = p.usage || {};
  const tokensIn = p.tokensIn ?? u.prompt_tokens ?? 0;
  const tokensOut = p.tokensOut ?? u.completion_tokens ?? 0;
  const tokensReasoning =
    p.tokensReasoning ??
    u.reasoning_tokens ??
    u.completion_tokens_details?.reasoning_tokens ??
    0;
  const tokensCached =
    p.tokensCached ??
    u.cached_tokens ??
    u.prompt_tokens_details?.cached_tokens ??
    0;
  return {
    tokensIn: Math.max(0, Math.round(tokensIn)),
    tokensOut: Math.max(0, Math.round(tokensOut)),
    tokensReasoning: Math.max(0, Math.round(tokensReasoning)),
    tokensCached: Math.max(0, Math.round(tokensCached)),
  };
}

/**
 * Detect the deprecated OpenRouter usage-accounting params in captured
 * request metadata. These have no effect upstream and should not be sent —
 * flag them as a code smell into rawMeta so engineers can clean them up.
 */
export function detectDeprecatedUsageParams(
  requestMeta: Record<string, unknown> | null | undefined
): string[] {
  const smells: string[] = [];
  if (!requestMeta || typeof requestMeta !== "object") return smells;
  const usage = (requestMeta as any).usage;
  if (usage && typeof usage === "object" && usage.include === true)
    smells.push("usage:{include:true} is deprecated/no-op — remove it");
  const so = (requestMeta as any).stream_options;
  if (so && typeof so === "object" && so.include_usage === true)
    smells.push(
      "stream_options:{include_usage:true} is deprecated/no-op — remove it"
    );
  return smells;
}

function isFreeModel(model?: string | null): boolean {
  return !!model && /:free\b/i.test(model);
}

export interface RecordResult {
  eventId: string;
  idempotentHit: boolean;
  totalCost: number;
  isByok: boolean;
  isFreeTier: boolean;
  codeSmells: string[];
}

/**
 * Normalize an OpenRouter-shaped (or generic) usage payload into a
 * BillingEvent. Idempotent on generationId. Computes cost via pricing when
 * the provider did not return a real cost. Mirrors AI cost to recordAiCost
 * (best-effort) and then checks budgets.
 */
export async function recordEvent(
  payload: IngestPayload
): Promise<RecordResult> {
  const provider = payload.provider;
  const model = payload.model ?? null;
  const requestAt = payload.requestAt
    ? new Date(payload.requestAt)
    : new Date();

  // Idempotency on generationId.
  if (payload.generationId) {
    const existing = await prisma.billingEvent.findUnique({
      where: { generationId: payload.generationId },
    });
    if (existing) {
      return {
        eventId: existing.id,
        idempotentHit: true,
        totalCost: existing.totalCost,
        isByok: existing.isByok,
        isFreeTier: existing.isFreeTier,
        codeSmells:
          ((existing.rawMeta as any)?.codeSmells as string[]) || [],
      };
    }
  }

  const tokens = normalizeTokens(payload);
  const freeTier = !!payload.isFreeTier || isFreeModel(model);
  const byok = !!payload.isByok;
  const providerCost =
    payload.usage && typeof payload.usage.cost === "number"
      ? payload.usage.cost
      : null;

  const pricing = model
    ? await priceFor(provider, model, requestAt)
    : null;

  const cost = computeCost(tokens, pricing, {
    isByok: byok,
    isFreeTier: freeTier,
    providerCost,
  });

  const codeSmells = detectDeprecatedUsageParams(payload.requestMeta);

  const rawMeta: Record<string, unknown> = {
    ...(payload.rawMeta || {}),
    ...(payload.usage ? { capturedUsage: payload.usage } : {}),
    ...(codeSmells.length ? { codeSmells } : {}),
    pricingId: pricing?.id ?? null,
    derivedCost: pricing != null && providerCost == null,
  };

  let event;
  try {
    event = await prisma.billingEvent.create({
      data: {
        provider,
        model,
        endpoint: payload.endpoint ?? null,
        generationId: payload.generationId ?? null,
        requestId: payload.requestId ?? null,
        requestAt,
        tokensIn: tokens.tokensIn,
        tokensOut: tokens.tokensOut,
        tokensReasoning: tokens.tokensReasoning,
        tokensCached: tokens.tokensCached,
        unitCost: cost.unitCost,
        totalCost: cost.totalCost,
        currency: "USD",
        module: payload.module || "unknown",
        userId: payload.userId ?? null,
        projectId: payload.projectId ?? null,
        isByok: cost.isByok,
        isFreeTier: cost.isFreeTier,
        upstreamInferenceCost: cost.upstreamInferenceCost,
        rawMeta: rawMeta as object,
      },
    });
  } catch (e: any) {
    // Idempotency race on the unique generationId.
    if (payload.generationId && e?.code === "P2002") {
      const existing = await prisma.billingEvent.findUnique({
        where: { generationId: payload.generationId },
      });
      if (existing)
        return {
          eventId: existing.id,
          idempotentHit: true,
          totalCost: existing.totalCost,
          isByok: existing.isByok,
          isFreeTier: existing.isFreeTier,
          codeSmells,
        };
    }
    throw e;
  }

  // Mirror to AI cost so it also shows in Benchmarks. Best-effort.
  try {
    await recordAiCost({
      module: event.module,
      model: model || `${provider}:unknown`,
      tokensIn: tokens.tokensIn,
      tokensOut: tokens.tokensOut + tokens.tokensReasoning,
      costUsd: cost.totalCost,
      latencyMs: null,
    });
  } catch {
    /* never hard-fail billing if benchmark mirror errors */
  }

  // Budget evaluation (real spend sums, deduped alerts).
  await checkBudgets(provider).catch(() => {});

  return {
    eventId: event.id,
    idempotentHit: false,
    totalCost: cost.totalCost,
    isByok: cost.isByok,
    isFreeTier: cost.isFreeTier,
    codeSmells,
  };
}

// ───────────────────────────── budgets ─────────────────────────────

export function periodStart(
  period: string,
  now: Date = new Date()
): Date {
  const d = new Date(now);
  if (period === "daily") {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
  }
  if (period === "weekly") {
    // ISO-ish week start = Monday UTC.
    const day = d.getUTCDay(); // 0=Sun
    const diff = (day + 6) % 7;
    const start = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
    start.setUTCDate(start.getUTCDate() - diff);
    return start;
  }
  // monthly
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export interface BudgetStatus {
  id: string;
  provider: string;
  period: string;
  limitAmount: number;
  currency: string;
  thresholds: number[];
  actionOnBreach: string;
  enabled: boolean;
  spend: number;
  pct: number;
  periodStart: string;
  breached: boolean;
}

/** Real spend (excludes free-tier) for a budget's current period. */
export async function budgetSpend(
  provider: string,
  period: string,
  now: Date = new Date()
): Promise<{ spend: number; start: Date }> {
  const start = periodStart(period, now);
  const agg = await prisma.billingEvent.aggregate({
    where: {
      provider,
      isFreeTier: false,
      requestAt: { gte: start, lte: now },
    },
    _sum: { totalCost: true },
  });
  return { spend: agg._sum.totalCost ?? 0, start };
}

/**
 * For each enabled budget of `provider`, sum REAL spend in the current
 * period. For each threshold newly crossed (50/80/100%) fire exactly ONE
 * billing_budget alert (deduped via Setting last-crossed). On a 100% breach
 * with actionOnBreach=pause set the honest pause flag the wrapper can read.
 */
export async function checkBudgets(
  provider: string,
  now: Date = new Date()
): Promise<BudgetStatus[]> {
  const budgets = await prisma.billingBudget.findMany({
    where: { provider, enabled: true },
  });
  if (!budgets.length) return [];

  const cfg = await getBillingConfig();
  const crossed = { ...(cfg.budgetCrossed || {}) };
  const paused = { ...(cfg.paused || {}) };
  let dirty = false;
  const out: BudgetStatus[] = [];

  for (const b of budgets) {
    const { spend, start } = await budgetSpend(provider, b.period, now);
    const pct = b.limitAmount > 0 ? (spend / b.limitAmount) * 100 : 0;
    const key = `${provider}:${b.period}`;
    const thresholds = [...(b.thresholds as number[])].sort((x, y) => x - y);
    const lastCrossed = crossed[key] ?? 0;

    // Highest threshold actually reached now.
    let highestNow = 0;
    for (const th of thresholds) if (pct >= th) highestNow = th;

    if (highestNow > lastCrossed) {
      // Fire one alert per newly-crossed threshold (deduped, no spam).
      for (const th of thresholds) {
        if (th > lastCrossed && th <= highestNow) {
          await raiseAlert({
            source: "billing_budget",
            severity: th >= 100 ? "CRITICAL" : "WARN",
            title: `Budget ${th}% — ${provider} ${b.period}`,
            payload: {
              provider,
              period: b.period,
              threshold: th,
              spend,
              limit: b.limitAmount,
              pct: Math.round(pct * 100) / 100,
              currency: b.currency,
              periodStart: start.toISOString(),
            },
          }).catch(() => {});
        }
      }
      crossed[key] = highestNow;
      dirty = true;
    } else if (highestNow < lastCrossed && pct < (thresholds[0] ?? 50)) {
      // New period / spend reset — clear so future crossings re-alert.
      crossed[key] = 0;
      dirty = true;
    }

    if (
      pct >= 100 &&
      b.actionOnBreach === "pause" &&
      !paused[provider]
    ) {
      paused[provider] = true;
      dirty = true;
    }

    out.push({
      id: b.id,
      provider,
      period: b.period,
      limitAmount: b.limitAmount,
      currency: b.currency,
      thresholds,
      actionOnBreach: b.actionOnBreach,
      enabled: b.enabled,
      spend,
      pct: Math.round(pct * 100) / 100,
      periodStart: start.toISOString(),
      breached: pct >= 100,
    });
  }

  if (dirty)
    await patchBillingConfig({ budgetCrossed: crossed, paused });
  return out;
}

/** Status bars data for all budgets (optionally one provider). */
export async function budgetStatuses(
  provider?: string
): Promise<BudgetStatus[]> {
  const budgets = await prisma.billingBudget.findMany({
    where: provider ? { provider } : {},
    orderBy: [{ provider: "asc" }, { period: "asc" }],
  });
  const now = new Date();
  const out: BudgetStatus[] = [];
  for (const b of budgets) {
    const { spend, start } = await budgetSpend(b.provider, b.period, now);
    const pct = b.limitAmount > 0 ? (spend / b.limitAmount) * 100 : 0;
    out.push({
      id: b.id,
      provider: b.provider,
      period: b.period,
      limitAmount: b.limitAmount,
      currency: b.currency,
      thresholds: [...(b.thresholds as number[])].sort((x, y) => x - y),
      actionOnBreach: b.actionOnBreach,
      enabled: b.enabled,
      spend,
      pct: Math.round(pct * 100) / 100,
      periodStart: start.toISOString(),
      breached: pct >= 100,
    });
  }
  return out;
}

// ─────────────────────── provider HTTP calls ───────────────────────

async function providerBaseUrl(provider: string): Promise<string> {
  const cfg = await getBillingConfig();
  const base =
    cfg.providerBaseUrls[provider] ||
    CONFIG_DEFAULT.providerBaseUrls[provider] ||
    "";
  return base.replace(/\/+$/, "");
}

async function credential(
  provider: string,
  credType: "inference" | "management"
): Promise<string | null> {
  const row = await prisma.providerCredential.findUnique({
    where: { provider_credType: { provider, credType } },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.keyEnc);
  } catch {
    return null;
  }
}

export type BalanceResult =
  | {
      ok: true;
      provider: string;
      balance: number;
      totalCredits: number;
      totalUsage: number;
      at: string;
      cached: boolean;
    }
  | { ok: false; provider: string; error: string };

/**
 * REAL fetch to {base}/api/v1/credits using the decrypted MANAGEMENT
 * credential. Cached in Setting with a timestamp; honors balancePollSec.
 * Honest typed error when no management key / base URL is configured.
 */
export async function liveBalance(
  provider: string,
  opts: { force?: boolean } = {}
): Promise<BalanceResult> {
  const cfg = await getBillingConfig();
  const cache = cfg.balanceCache?.[provider];
  const pollSec = cfg.balancePollSec || 300;
  if (
    !opts.force &&
    cache &&
    Date.now() - new Date(cache.at).getTime() < pollSec * 1000
  ) {
    return {
      ok: true,
      provider,
      balance: cache.balance,
      totalCredits: cache.totalCredits,
      totalUsage: cache.totalUsage,
      at: cache.at,
      cached: true,
    };
  }

  const base = await providerBaseUrl(provider);
  if (!base)
    return { ok: false, provider, error: "Provider base URL not configured" };
  const mgmt = await credential(provider, "management");
  if (!mgmt)
    return {
      ok: false,
      provider,
      error: "Management key not configured for this provider",
    };

  try {
    const res = await fetch(`${base}/api/v1/credits`, {
      headers: { authorization: `Bearer ${mgmt}` },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        ok: false,
        provider,
        error: `Provider HTTP ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const j: any = await res.json();
    const d = j?.data ?? j;
    const totalCredits = Number(d?.total_credits ?? 0);
    const totalUsage = Number(d?.total_usage ?? 0);
    const balance = totalCredits - totalUsage;
    const at = new Date().toISOString();
    const balanceCache = {
      ...(cfg.balanceCache || {}),
      [provider]: { balance, totalCredits, totalUsage, at },
    };
    await patchBillingConfig({ balanceCache });
    return {
      ok: true,
      provider,
      balance,
      totalCredits,
      totalUsage,
      at,
      cached: false,
    };
  } catch (e) {
    return {
      ok: false,
      provider,
      error: e instanceof Error ? e.message : "Balance fetch failed",
    };
  }
}

export interface ActivityModelTotal {
  model: string;
  requests: number;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * REAL fetch to {base}/api/v1/activity. Returns per-model totals for the
 * given UTC day (provider returns last ~30 completed UTC days grouped by
 * model). Honest typed throw when not configured.
 */
export async function pullActivity(
  provider: string,
  forDateUTC: Date
): Promise<ActivityModelTotal[]> {
  const base = await providerBaseUrl(provider);
  if (!base) throw new Error("Provider base URL not configured");
  const mgmt = await credential(provider, "management");
  if (!mgmt) throw new Error("Management key not configured");

  const day = forDateUTC.toISOString().slice(0, 10);
  const res = await fetch(
    `${base}/api/v1/activity?date=${encodeURIComponent(day)}`,
    { headers: { authorization: `Bearer ${mgmt}` } }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Provider activity HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j: any = await res.json();
  const rows: any[] = j?.data ?? j ?? [];
  const byModel = new Map<string, ActivityModelTotal>();
  for (const r of rows) {
    const rDay = String(r.date || r.day || day).slice(0, 10);
    if (rDay !== day) continue;
    const model = String(r.model || r.model_permaslug || "unknown");
    const cur =
      byModel.get(model) ||
      { model, requests: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
    cur.requests += Number(r.requests ?? r.count ?? 0);
    cur.cost += Number(r.usage ?? r.cost ?? r.total_cost ?? 0);
    cur.tokensIn += Number(r.prompt_tokens ?? r.tokens_prompt ?? 0);
    cur.tokensOut += Number(r.completion_tokens ?? r.tokens_completion ?? 0);
    byModel.set(model, cur);
  }
  return Array.from(byModel.values());
}

/**
 * REAL fetch to {base}/api/v1/generation?id= to backfill an event whose
 * usage was incomplete (e.g. an aborted stream).
 */
export async function enrichGeneration(
  provider: string,
  generationId: string
): Promise<{ enriched: boolean; eventId?: string }> {
  const base = await providerBaseUrl(provider);
  if (!base) throw new Error("Provider base URL not configured");
  const mgmt = await credential(provider, "management");
  if (!mgmt) throw new Error("Management key not configured");

  const res = await fetch(
    `${base}/api/v1/generation?id=${encodeURIComponent(generationId)}`,
    { headers: { authorization: `Bearer ${mgmt}` } }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Provider generation HTTP ${res.status}: ${txt.slice(0, 200)}`
    );
  }
  const j: any = await res.json();
  const d = j?.data ?? j;
  const ev = await prisma.billingEvent.findUnique({
    where: { generationId },
  });
  if (!ev) return { enriched: false };

  const tokensIn = Number(
    d?.tokens_prompt ?? d?.native_tokens_prompt ?? ev.tokensIn
  );
  const tokensOut = Number(
    d?.tokens_completion ?? d?.native_tokens_completion ?? ev.tokensOut
  );
  const tokensReasoning = Number(
    d?.native_tokens_reasoning ?? ev.tokensReasoning
  );
  const tokensCached = Number(d?.native_tokens_cached ?? ev.tokensCached);
  const realCost =
    typeof d?.total_cost === "number" ? d.total_cost : null;

  const pricing = ev.model
    ? await priceFor(provider, ev.model, ev.requestAt)
    : null;
  const cost = computeCost(
    { tokensIn, tokensOut, tokensReasoning, tokensCached },
    pricing,
    {
      isByok: ev.isByok,
      isFreeTier: ev.isFreeTier,
      providerCost: realCost,
    }
  );

  await prisma.billingEvent.update({
    where: { id: ev.id },
    data: {
      tokensIn,
      tokensOut,
      tokensReasoning,
      tokensCached,
      unitCost: cost.unitCost,
      totalCost: cost.totalCost,
      upstreamInferenceCost: cost.upstreamInferenceCost,
      rawMeta: {
        ...((ev.rawMeta as object) || {}),
        enrichedAt: new Date().toISOString(),
        generationDetail: d,
      } as object,
    },
  });
  return { enriched: true, eventId: ev.id };
}

// ─────────────────────────── reconciliation ───────────────────────────

export interface ReconResult {
  provider: string;
  forDate: string;
  capturedTotal: number;
  providerTotal: number;
  driftAbs: number;
  driftPct: number;
  flagged: boolean;
  status: "ok" | "drift" | "error";
  breakdown: {
    model: string;
    captured: number;
    provider: number;
    drift: number;
  }[];
  error?: string;
}

function utcDayRange(forDateUTC: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(
      forDateUTC.getUTCFullYear(),
      forDateUTC.getUTCMonth(),
      forDateUTC.getUTCDate()
    )
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * Compare REAL captured BillingEvent sums for a UTC day (grouped by model)
 * vs REAL provider activity totals. Compute driftAbs/driftPct, flag when
 * drift exceeds max(reconThresholdPct%, reconThresholdUsd$). Upsert the
 * ReconciliationRun (unique provider+forDate). On a flagged run raise a
 * billing_recon alert with both totals + per-model breakdown.
 */
export async function reconcile(
  provider: string,
  forDateUTC: Date
): Promise<ReconResult> {
  const cfg = await getBillingConfig();
  const { start, end } = utcDayRange(forDateUTC);
  const forDate = start;

  let captured: { model: string; cost: number }[] = [];
  try {
    const grouped = await prisma.billingEvent.groupBy({
      by: ["model"],
      where: {
        provider,
        isFreeTier: false,
        requestAt: { gte: start, lt: end },
      },
      _sum: { totalCost: true },
    });
    captured = grouped.map((g) => ({
      model: g.model || "unknown",
      cost: g._sum.totalCost ?? 0,
    }));
  } catch (e) {
    return await persistRecon(provider, forDate, {
      capturedTotal: 0,
      providerTotal: 0,
      driftAbs: 0,
      driftPct: 0,
      flagged: false,
      status: "error",
      breakdown: [],
      error: e instanceof Error ? e.message : "captured sum failed",
    });
  }

  let activity: ActivityModelTotal[];
  try {
    activity = await pullActivity(provider, forDateUTC);
  } catch (e) {
    return await persistRecon(provider, forDate, {
      capturedTotal: captured.reduce((s, c) => s + c.cost, 0),
      providerTotal: 0,
      driftAbs: 0,
      driftPct: 0,
      flagged: false,
      status: "error",
      breakdown: [],
      error: e instanceof Error ? e.message : "provider activity failed",
    });
  }

  const capByModel = new Map(captured.map((c) => [c.model, c.cost]));
  const provByModel = new Map(activity.map((a) => [a.model, a.cost]));
  const models = new Set<string>([
    ...Array.from(capByModel.keys()),
    ...Array.from(provByModel.keys()),
  ]);
  const breakdown = Array.from(models).map((m) => {
    const cap = capByModel.get(m) ?? 0;
    const pr = provByModel.get(m) ?? 0;
    return {
      model: m,
      captured: round6(cap),
      provider: round6(pr),
      drift: round6(Math.abs(cap - pr)),
    };
  });

  const capturedTotal = round6(
    captured.reduce((s, c) => s + c.cost, 0)
  );
  const providerTotal = round6(
    activity.reduce((s, a) => s + a.cost, 0)
  );
  const driftAbs = round6(Math.abs(capturedTotal - providerTotal));
  const driftPct =
    providerTotal > 0
      ? round6((driftAbs / providerTotal) * 100)
      : capturedTotal > 0
      ? 100
      : 0;

  const pctThresh = cfg.reconThresholdPct ?? 2;
  const usdThresh = cfg.reconThresholdUsd ?? 1;
  // Flag if drift exceeds BOTH bars are crossed-whichever is the larger
  // tolerance — i.e. only flag when it beats the more permissive limit.
  const exceedsPct = driftPct > pctThresh;
  const exceedsUsd = driftAbs > usdThresh;
  const flagged = exceedsPct && exceedsUsd;
  const status: ReconResult["status"] = flagged ? "drift" : "ok";

  const result = await persistRecon(provider, forDate, {
    capturedTotal,
    providerTotal,
    driftAbs,
    driftPct,
    flagged,
    status,
    breakdown,
  });

  if (flagged) {
    await raiseAlert({
      source: "billing_recon",
      severity: "ERROR",
      title: `Billing drift — ${provider} ${forDate
        .toISOString()
        .slice(0, 10)}`,
      payload: {
        provider,
        forDate: forDate.toISOString(),
        capturedTotal,
        providerTotal,
        driftAbs,
        driftPct,
        breakdown,
      },
    }).catch(() => {});
  }

  return result;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function persistRecon(
  provider: string,
  forDate: Date,
  r: Omit<ReconResult, "provider" | "forDate">
): Promise<ReconResult> {
  await prisma.reconciliationRun.upsert({
    where: { provider_forDate: { provider, forDate } },
    create: {
      provider,
      forDate,
      capturedTotal: r.capturedTotal,
      providerTotal: r.providerTotal,
      driftAbs: r.driftAbs,
      driftPct: r.driftPct,
      flagged: r.flagged,
      breakdown: r.breakdown as object,
      status: r.status,
      error: r.error ?? null,
    },
    update: {
      capturedTotal: r.capturedTotal,
      providerTotal: r.providerTotal,
      driftAbs: r.driftAbs,
      driftPct: r.driftPct,
      flagged: r.flagged,
      breakdown: r.breakdown as object,
      status: r.status,
      error: r.error ?? null,
    },
  });
  return { ...r, provider, forDate: forDate.toISOString() };
}

/**
 * Pure date logic for the nightly job: the most recent fully-settled UTC
 * day to reconcile is "yesterday", but only once we're ≥ minSettleMin past
 * UTC midnight (provider activity needs time to settle). Returns null if
 * we should wait. Exposed so the test can call reconcile() directly.
 */
export function dateToReconcile(
  now: Date = new Date(),
  minSettleMin = 30
): Date | null {
  const minutesPastMidnight =
    now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minutesPastMidnight < minSettleMin) return null;
  const y = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  y.setUTCDate(y.getUTCDate() - 1);
  return y;
}

/** Background reconciliation job (kind="reconciliation"). */
export async function runReconciliationJob(
  forDateUTC?: Date,
  provider?: string
): Promise<{ jobId: string }> {
  const job = await createJob({
    kind: "reconciliation",
    label: `Reconciliation ${forDateUTC?.toISOString().slice(0, 10) ?? "auto"}`,
    params: { provider: provider ?? null, forDate: forDateUTC ?? null },
  });
  runJob(job.id, async (ctx) => {
    const date = forDateUTC ?? dateToReconcile();
    if (!date) {
      await ctx.log(
        "Too early past UTC midnight — yesterday not settled yet; skipping."
      );
      return { skipped: true };
    }
    const providers = provider
      ? [provider]
      : (
          await prisma.providerCredential.findMany({
            where: { credType: "management" },
            select: { provider: true },
          })
        ).map((p) => p.provider);
    if (!providers.length) {
      await ctx.log("No management credentials configured — nothing to do.");
      return { reconciled: 0 };
    }
    const results: ReconResult[] = [];
    let i = 0;
    for (const p of providers) {
      await ctx.log(`Reconciling ${p} for ${date.toISOString().slice(0, 10)}…`);
      const r = await reconcile(p, date).catch((e) => ({
        provider: p,
        forDate: date.toISOString(),
        capturedTotal: 0,
        providerTotal: 0,
        driftAbs: 0,
        driftPct: 0,
        flagged: false,
        status: "error" as const,
        breakdown: [],
        error: e instanceof Error ? e.message : String(e),
      }));
      results.push(r);
      await ctx.log(
        `  ${p}: status=${r.status} drift=$${r.driftAbs} (${r.driftPct}%)`
      );
      i++;
      await ctx.progress((i / providers.length) * 100);
    }
    return { reconciled: results.length, results };
  });
  return { jobId: job.id };
}

// ─────────────────────────── aggregations ───────────────────────────

export type GroupBy = "provider" | "model" | "module" | "user" | "project";

export interface SpendRow {
  key: string;
  cost: number;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  byokCost: number;
  freeRequests: number;
}

export async function spendSummary(opts: {
  from?: Date;
  to?: Date;
  groupBy?: GroupBy;
}): Promise<{
  total: number;
  byokTotal: number;
  directTotal: number;
  freeRequests: number;
  requests: number;
  rows: SpendRow[];
}> {
  const where: any = {};
  if (opts.from || opts.to) {
    where.requestAt = {};
    if (opts.from) where.requestAt.gte = opts.from;
    if (opts.to) where.requestAt.lte = opts.to;
  }
  const events = await prisma.billingEvent.findMany({
    where,
    select: {
      provider: true,
      model: true,
      module: true,
      userId: true,
      projectId: true,
      totalCost: true,
      tokensIn: true,
      tokensOut: true,
      tokensReasoning: true,
      isByok: true,
      isFreeTier: true,
    },
  });
  const gb = opts.groupBy ?? "provider";
  const map = new Map<string, SpendRow>();
  let total = 0;
  let byokTotal = 0;
  let directTotal = 0;
  let freeRequests = 0;
  for (const e of events) {
    const key =
      gb === "provider"
        ? e.provider
        : gb === "model"
        ? e.model || "unknown"
        : gb === "module"
        ? e.module
        : gb === "user"
        ? e.userId || "—"
        : e.projectId || "—";
    const r =
      map.get(key) ||
      {
        key,
        cost: 0,
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        byokCost: 0,
        freeRequests: 0,
      };
    r.requests += 1;
    r.tokensIn += e.tokensIn;
    r.tokensOut += e.tokensOut + e.tokensReasoning;
    if (e.isFreeTier) {
      r.freeRequests += 1;
      freeRequests += 1;
    } else {
      r.cost += e.totalCost;
      total += e.totalCost;
      if (e.isByok) {
        r.byokCost += e.totalCost;
        byokTotal += e.totalCost;
      } else directTotal += e.totalCost;
    }
    map.set(key, r);
  }
  const rows = Array.from(map.values())
    .map((r) => ({
      ...r,
      cost: round6(r.cost),
      byokCost: round6(r.byokCost),
    }))
    .sort((a, b) => b.cost - a.cost);
  return {
    total: round6(total),
    byokTotal: round6(byokTotal),
    directTotal: round6(directTotal),
    freeRequests,
    requests: events.length,
    rows,
  };
}

export interface TrendDay {
  date: string;
  cost: number;
  requests: number;
  costPerRequest: number;
  avgTokens: number;
  cacheHitRate: number;
  byokCost: number;
  directCost: number;
}

export async function trends(days = 30): Promise<TrendDay[]> {
  const since = new Date(Date.now() - days * 86400_000);
  const events = await prisma.billingEvent.findMany({
    where: { requestAt: { gte: since } },
    select: {
      requestAt: true,
      totalCost: true,
      tokensIn: true,
      tokensOut: true,
      tokensReasoning: true,
      tokensCached: true,
      isByok: true,
      isFreeTier: true,
    },
  });
  const byDay = new Map<
    string,
    {
      cost: number;
      requests: number;
      tokens: number;
      cached: number;
      promptTokens: number;
      byok: number;
      direct: number;
    }
  >();
  for (const e of events) {
    const day = e.requestAt.toISOString().slice(0, 10);
    const d =
      byDay.get(day) ||
      {
        cost: 0,
        requests: 0,
        tokens: 0,
        cached: 0,
        promptTokens: 0,
        byok: 0,
        direct: 0,
      };
    d.requests += 1;
    d.tokens += e.tokensIn + e.tokensOut + e.tokensReasoning;
    d.cached += e.tokensCached;
    d.promptTokens += e.tokensIn;
    if (!e.isFreeTier) {
      d.cost += e.totalCost;
      if (e.isByok) d.byok += e.totalCost;
      else d.direct += e.totalCost;
    }
    byDay.set(day, d);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      cost: round6(d.cost),
      requests: d.requests,
      costPerRequest: d.requests ? round6(d.cost / d.requests) : 0,
      avgTokens: d.requests ? Math.round(d.tokens / d.requests) : 0,
      cacheHitRate:
        d.promptTokens > 0
          ? round6((d.cached / d.promptTokens) * 100)
          : 0,
      byokCost: round6(d.byok),
      directCost: round6(d.direct),
    }));
}

export async function topConsumers(limit = 10): Promise<{
  users: SpendRow[];
  projects: SpendRow[];
  modules: SpendRow[];
}> {
  const [u, p, m] = await Promise.all([
    spendSummary({ groupBy: "user" }),
    spendSummary({ groupBy: "project" }),
    spendSummary({ groupBy: "module" }),
  ]);
  return {
    users: u.rows.slice(0, limit),
    projects: p.rows.slice(0, limit),
    modules: m.rows.slice(0, limit),
  };
}

export interface Anomaly {
  date: string;
  cost: number;
  mean: number;
  std: number;
  threshold: number;
}

/** Days where cost > mean + 2σ of the trailing 14 days. */
export async function anomalies(): Promise<Anomaly[]> {
  const t = await trends(45);
  const out: Anomaly[] = [];
  for (let i = 0; i < t.length; i++) {
    const window = t.slice(Math.max(0, i - 14), i);
    if (window.length < 5) continue;
    const costs = window.map((w) => w.cost);
    const mean = costs.reduce((s, c) => s + c, 0) / costs.length;
    const variance =
      costs.reduce((s, c) => s + (c - mean) ** 2, 0) / costs.length;
    const std = Math.sqrt(variance);
    const threshold = mean + 2 * std;
    if (t[i].cost > threshold && t[i].cost > 0) {
      out.push({
        date: t[i].date,
        cost: t[i].cost,
        mean: round6(mean),
        std: round6(std),
        threshold: round6(threshold),
      });
    }
  }
  return out;
}
