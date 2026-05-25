/**
 * OpenRouter → Panel billing wrapper (Node / TypeScript).
 *
 * HONESTY: forwards only the REAL `usage` object OpenRouter put inside the
 * chat-completion response. Does NOT compute price (the panel does, from
 * versioned ProviderPricing). Fire-and-forget; NEVER throws into the caller.
 *
 * Dependency-light: uses global `fetch` (Node 18+). No SDK required.
 *
 * Configure via env:
 *   PANEL_BILLING_URL   = "http://panel.internal/api/billing/events"
 *   PANEL_INGEST_TOKEN  = "bilg_..."   (Panel → Billing → Config)
 *
 * Non-streaming:
 *   const resp = await openrouter.chat.completions.create(...);
 *   reportOpenRouterUsage(resp, { model, module: "lead_enrichment",
 *                                 userId, projectId });
 *
 * Streaming: consume the FULL stream first — OpenRouter only emits `usage`
 * in the LAST chunk:
 *   const usage = accumulateStreamUsage(chunks);
 *   reportOpenRouterUsage({ usage, id: genId }, { model });
 */

export interface ReportOpts {
  model?: string | null;
  module?: string;
  userId?: string | null;
  projectId?: string | null;
  isByok?: boolean;
  isFreeTier?: boolean;
  endpoint?: string;
  requestMeta?: Record<string, unknown> | null;
  /** Override the panel URL/token (else read from env). */
  panelUrl?: string;
  ingestToken?: string;
}

function asObj(x: any): Record<string, any> {
  if (!x) return {};
  if (typeof x === "string") {
    try {
      return JSON.parse(x);
    } catch {
      return {};
    }
  }
  return x as Record<string, any>;
}

/**
 * Fire-and-forget: POST the real captured usage to the panel. Never throws,
 * never blocks the caller (the network call is not awaited).
 */
export function reportOpenRouterUsage(
  response: any,
  opts: ReportOpts = {}
): void {
  try {
    const url = opts.panelUrl || process.env.PANEL_BILLING_URL || "";
    const token = opts.ingestToken || process.env.PANEL_INGEST_TOKEN || "";
    if (!url || !token) return;

    const body = asObj(response);
    const usage = body.usage || {};
    const genId = body.id || body.generation_id || null;
    const payload: Record<string, unknown> = {
      provider: "openrouter",
      model: opts.model ?? body.model ?? null,
      endpoint: opts.endpoint ?? "/chat/completions",
      generationId: genId,
      module: opts.module ?? "unknown",
      userId: opts.userId ?? null,
      projectId: opts.projectId ?? null,
      isByok: !!opts.isByok,
      usage,
      requestMeta: opts.requestMeta ?? null,
    };
    if (opts.isFreeTier != null) payload.isFreeTier = !!opts.isFreeTier;

    // Intentionally NOT awaited — never block the request path.
    void fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-billing-ingest-token": token,
      },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* billing telemetry must never break the product */
    });
  } catch {
    /* swallow — never throw into the caller */
  }
}

/**
 * Consume the FULL stream and return the usage object from the last chunk
 * that carries one. Incomplete/aborted streams → {} (enrich later via the
 * panel's /generation backfill).
 */
export function accumulateStreamUsage(
  chunks: Iterable<any> | any[]
): Record<string, any> {
  let last: Record<string, any> = {};
  for (const c of chunks) {
    const d = asObj(c);
    if (d.usage) last = d.usage;
  }
  return last;
}

/** Async-iterable variant (SDK streams are usually async iterables). */
export async function accumulateStreamUsageAsync(
  stream: AsyncIterable<any>
): Promise<Record<string, any>> {
  let last: Record<string, any> = {};
  for await (const c of stream) {
    const d = asObj(c);
    if (d.usage) last = d.usage;
  }
  return last;
}
