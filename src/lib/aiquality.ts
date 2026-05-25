import { prisma } from "./prisma";
import { audit } from "./auth";
import { getSetting, maskSecrets } from "./api";
import { recordAiCost } from "./codeanalysis";
import type { AiFlag } from "@prisma/client";

/**
 * AI Output Quality Tracking (Section 9) primitives.
 *
 * HONESTY: every value here comes from real recorded human/product data or a
 * real HTTP call to a configured LLM endpoint. We NEVER fabricate model
 * outputs, ratings or costs. `similarity()` / `matchScore` is a deterministic
 * computed metric (documented below), not random. When no provider is
 * configured `callModel`/`runRegression` throw `AiProviderNotConfiguredError`
 * and persist nothing.
 */

/** The 7 product AI modules tracked by this section. */
export const AI_MODULES = [
  "quick_report",
  "decision_engine",
  "gtm_strategy",
  "pitch_deck",
  "pitch_to_vc",
  "find_experts",
  "ai_research_assistant",
] as const;
export type AiModule = (typeof AI_MODULES)[number];

export const AI_PROVIDERS_SETTING_KEY = "ai_providers";

export interface ProviderEntry {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Optional USD price per 1K input/output tokens for honest cost calc. */
  pricePer1kIn?: number;
  pricePer1kOut?: number;
}

export interface AiProvidersConfig {
  /** Which provider key `callModel` uses by default. */
  active?: "openrouter" | "gemini" | "custom";
  providers: {
    openrouter?: ProviderEntry;
    gemini?: ProviderEntry;
    custom?: ProviderEntry;
  };
}

export const DEFAULT_AI_PROVIDERS_CONFIG: AiProvidersConfig = {
  active: "custom",
  providers: {},
};

/** Thrown (and surfaced as an honest error) when no usable provider exists. */
export class AiProviderNotConfiguredError extends Error {
  constructor(msg = "No AI provider configured") {
    super(msg);
    this.name = "AiProviderNotConfiguredError";
  }
}

// ───────────────────────────── Samples ─────────────────────────────

export interface RecordSampleInput {
  module: string;
  model: string;
  modelVersion?: string | null;
  inputText: string;
  outputText: string;
  costUsd?: number | null;
  latencyMs?: number | null;
  flag?: AiFlag;
  notes?: string | null;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Persist a real AiSample (reviewStatus PENDING). When a cost or token count is
 * known we also mirror it into AiCostMetric via the shared Section 8 entry
 * point so it shows in cost benchmarks.
 */
export async function recordSample(input: RecordSampleInput) {
  const sample = await prisma.aiSample.create({
    data: {
      module: input.module,
      model: input.model,
      modelVersion: input.modelVersion ?? null,
      inputText: input.inputText,
      outputText: input.outputText,
      costUsd: input.costUsd ?? null,
      latencyMs: input.latencyMs ?? null,
      flag: input.flag ?? "NONE",
      notes: input.notes ?? null,
      reviewStatus: "PENDING",
    },
  });
  const hasCost =
    (input.costUsd != null && input.costUsd > 0) ||
    (input.tokensIn != null && input.tokensIn > 0) ||
    (input.tokensOut != null && input.tokensOut > 0);
  if (hasCost) {
    await recordAiCost({
      module: input.module,
      model: input.model,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      costUsd: input.costUsd ?? 0,
      latencyMs: input.latencyMs ?? null,
    });
  }
  return sample;
}

/** Apply a real human rating (1-5) + notes, marking the sample REVIEWED. */
export async function rateSample(
  id: string,
  rating: number,
  notes: string | null,
  reviewerUserId: string
) {
  const r = Math.round(rating);
  if (r < 1 || r > 5) throw new Error("rating must be an integer 1..5");
  const updated = await prisma.aiSample.update({
    where: { id },
    data: {
      humanRating: r,
      notes: notes ?? undefined,
      reviewStatus: "REVIEWED",
      reviewedById: reviewerUserId,
    },
  });
  await audit(reviewerUserId, "aiquality.sample.rate", id, {
    rating: r,
    module: updated.module,
  });
  return updated;
}

/**
 * Set / clear a quality flag. A non-NONE flag forces the sample back to the
 * PENDING review queue so a human re-checks it.
 */
export async function flagSample(
  id: string,
  flag: AiFlag,
  reviewerUserId?: string | null
) {
  const updated = await prisma.aiSample.update({
    where: { id },
    data: {
      flag,
      reviewStatus: flag === "NONE" ? undefined : "PENDING",
    },
  });
  await audit(reviewerUserId ?? null, "aiquality.sample.flag", id, {
    flag,
    module: updated.module,
  });
  return updated;
}

// ─────────────────────────── Similarity ───────────────────────────

function tokenize(s: string): string[] {
  // Treat any non-alphanumeric (incl. punctuation/symbols, any script) as a
  // separator. Kept ASCII-class to satisfy the project's TS target.
  return s
    .toLowerCase()
    .replace(/[^0-9a-zÀ-￿]+/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Classic Levenshtein edit distance (iterative, O(n*m) memory O(min)). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Deterministic text similarity in [0,1].
 *
 * Blend of two real, order-independent measures:
 *  - Token Jaccard: |A∩B| / |A∪B| over lowercased alphanumeric tokens.
 *  - Normalized Levenshtein: 1 - editDistance / max(len) over the raw
 *    (trimmed, whitespace-collapsed) strings.
 *
 * Final score = 0.5 * jaccard + 0.5 * normLev, rounded to 4 decimals. Two
 * identical strings score 1; two strings with nothing in common score 0. The
 * same inputs always yield the same number (no randomness).
 */
export function similarity(a: string, b: string): number {
  const na = (a ?? "").trim().replace(/\s+/g, " ");
  const nb = (b ?? "").trim().replace(/\s+/g, " ");
  if (na === nb) return na.length === 0 ? 1 : 1;
  if (na.length === 0 || nb.length === 0) return 0;

  const ta = new Set(tokenize(na));
  const tb = new Set(tokenize(nb));
  let inter = 0;
  for (const tok of Array.from(ta)) if (tb.has(tok)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;

  const dist = levenshtein(na, nb);
  const normLev = 1 - dist / Math.max(na.length, nb.length);

  const score = 0.5 * jaccard + 0.5 * Math.max(0, normLev);
  return Math.round(Math.min(1, Math.max(0, score)) * 1e4) / 1e4;
}

// ───────────────────────────── Model call ─────────────────────────

export interface CallModelArgs {
  /** Provider key; defaults to config.active. */
  provider?: "openrouter" | "gemini" | "custom";
  /** Override model; defaults to the provider entry's model. */
  model?: string;
  prompt: string;
}

export interface CallModelResult {
  output: string;
  latencyMs: number;
  /** Real cost when usage + price-per-token are both known, else null. */
  costUsd: number | null;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  raw: unknown;
}

async function loadProvidersConfig(): Promise<AiProvidersConfig> {
  return getSetting<AiProvidersConfig>(
    AI_PROVIDERS_SETTING_KEY,
    DEFAULT_AI_PROVIDERS_CONFIG
  );
}

/** Read providers config with API keys masked for safe display. */
export async function getProvidersConfigMasked(): Promise<AiProvidersConfig> {
  const cfg = await loadProvidersConfig();
  return maskSecrets(cfg);
}

function resolveProvider(
  cfg: AiProvidersConfig,
  preferred?: "openrouter" | "gemini" | "custom"
): { key: string; entry: ProviderEntry } {
  const order: ("openrouter" | "gemini" | "custom")[] = preferred
    ? [preferred]
    : [
        cfg.active ?? "custom",
        "custom",
        "openrouter",
        "gemini",
      ];
  for (const key of order) {
    const entry = cfg.providers?.[key];
    if (entry && entry.baseUrl && entry.apiKey && entry.model) {
      return { key, entry };
    }
  }
  throw new AiProviderNotConfiguredError(
    "No AI provider configured (need baseUrl, apiKey and model under Setting 'ai_providers')."
  );
}

/**
 * REAL HTTP call to an OpenAI-compatible POST {baseUrl}/chat/completions
 * endpoint. Never fabricates output. Throws AiProviderNotConfiguredError when
 * no usable provider; throws a plain Error (no row) on transport/HTTP failure.
 */
export async function callModel(
  args: CallModelArgs
): Promise<CallModelResult> {
  const cfg = await loadProvidersConfig();
  const { entry } = resolveProvider(cfg, args.provider);
  const model = args.model || entry.model;
  const base = entry.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const started = Date.now();
  let res: Response;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 120000);
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${entry.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: args.prompt }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
  } catch (e) {
    throw new Error(
      `Model call failed (transport): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  const latencyMs = Date.now() - started;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Model call failed: HTTP ${res.status} ${text.slice(0, 500)}`
    );
  }
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Model call failed: non-JSON response from provider");
  }
  const output: string =
    raw?.choices?.[0]?.message?.content ??
    raw?.choices?.[0]?.text ??
    "";
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Model call returned no content");
  }
  const tokensIn: number | null = raw?.usage?.prompt_tokens ?? null;
  const tokensOut: number | null = raw?.usage?.completion_tokens ?? null;
  let costUsd: number | null = null;
  if (
    tokensIn != null &&
    tokensOut != null &&
    (entry.pricePer1kIn != null || entry.pricePer1kOut != null)
  ) {
    costUsd =
      Math.round(
        ((tokensIn / 1000) * (entry.pricePer1kIn ?? 0) +
          (tokensOut / 1000) * (entry.pricePer1kOut ?? 0)) *
          1e6
      ) / 1e6;
  }
  return { output, latencyMs, costUsd, model, tokensIn, tokensOut, raw };
}

// ─────────────────────────── Regression ───────────────────────────

/**
 * Run a regression case against the currently configured model: makes a REAL
 * model call on the case inputText, computes matchScore = similarity(baseline,
 * output) (deterministic), persists an AiRegressionRun, and mirrors the cost
 * into AiCostMetric. Throws (persisting NO run) when no provider is configured
 * or the call fails — never invents an output.
 */
export async function runRegression(
  caseId: string,
  provider?: "openrouter" | "gemini" | "custom"
) {
  const rc = await prisma.aiRegressionCase.findUnique({
    where: { id: caseId },
  });
  if (!rc) throw new Error("Regression case not found");

  const call = await callModel({ provider, prompt: rc.inputText });

  const baseline = rc.baselineOutput ?? "";
  const matchScore = baseline ? similarity(baseline, call.output) : null;

  const run = await prisma.aiRegressionRun.create({
    data: {
      caseId,
      model: call.model,
      output: call.output,
      costUsd: call.costUsd,
      latencyMs: call.latencyMs,
      matchScore,
    },
  });
  if (
    call.costUsd != null ||
    call.tokensIn != null ||
    call.tokensOut != null
  ) {
    await recordAiCost({
      module: rc.module,
      model: call.model,
      tokensIn: call.tokensIn ?? 0,
      tokensOut: call.tokensOut ?? 0,
      costUsd: call.costUsd ?? 0,
      latencyMs: call.latencyMs,
    });
  }
  return run;
}

// ───────────────────────────── Stats ──────────────────────────────

export interface ModuleStats {
  module: string;
  samples: number;
  avgHumanRating: number | null;
  ratedCount: number;
  flagCounts: { NONE: number; HALLUCINATION: number; REFUSAL: number; ERROR: number };
  hallucinationRate: number;
  refusalRate: number;
  errorRate: number;
  avgCostPerOutput: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  modelVersions: { key: string; count: number }[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

/**
 * Aggregate real AiSample rows per module over a recent window. Rates are
 * counts / total samples. Averages only consider rows that actually recorded
 * the value (honest null when none did).
 */
export async function stats(days = 30): Promise<ModuleStats[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.aiSample.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
  const byModule = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byModule.get(r.module) || [];
    list.push(r);
    byModule.set(r.module, list);
  }
  const out: ModuleStats[] = [];
  for (const [module, list] of Array.from(byModule.entries())) {
    const rated = list.filter((r) => r.humanRating != null);
    const avgHumanRating =
      rated.length > 0
        ? Math.round(
            (rated.reduce((a, r) => a + (r.humanRating as number), 0) /
              rated.length) *
              100
          ) / 100
        : null;
    const flagCounts = {
      NONE: list.filter((r) => r.flag === "NONE").length,
      HALLUCINATION: list.filter((r) => r.flag === "HALLUCINATION").length,
      REFUSAL: list.filter((r) => r.flag === "REFUSAL").length,
      ERROR: list.filter((r) => r.flag === "ERROR").length,
    };
    const n = list.length;
    const costs = list
      .map((r) => r.costUsd)
      .filter((v): v is number => v != null);
    const avgCostPerOutput =
      costs.length > 0
        ? Math.round(
            (costs.reduce((a, b) => a + b, 0) / costs.length) * 1e6
          ) / 1e6
        : null;
    const lat = list
      .map((r) => r.latencyMs)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const avgLatencyMs =
      lat.length > 0
        ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 100) / 100
        : null;
    const p95LatencyMs =
      lat.length > 0 ? Math.round(percentile(lat, 95) * 100) / 100 : null;
    const verMap = new Map<string, number>();
    for (const r of list) {
      const key = `${r.model}${r.modelVersion ? ` @ ${r.modelVersion}` : ""}`;
      verMap.set(key, (verMap.get(key) || 0) + 1);
    }
    out.push({
      module,
      samples: n,
      avgHumanRating,
      ratedCount: rated.length,
      flagCounts,
      hallucinationRate:
        n > 0 ? Math.round((flagCounts.HALLUCINATION / n) * 1e4) / 1e4 : 0,
      refusalRate:
        n > 0 ? Math.round((flagCounts.REFUSAL / n) * 1e4) / 1e4 : 0,
      errorRate: n > 0 ? Math.round((flagCounts.ERROR / n) * 1e4) / 1e4 : 0,
      avgCostPerOutput,
      avgLatencyMs,
      p95LatencyMs,
      modelVersions: Array.from(verMap.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
    });
  }
  return out.sort((a, b) => a.module.localeCompare(b.module));
}
