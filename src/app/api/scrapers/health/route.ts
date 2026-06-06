import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { hostFetch } from "@/lib/server";
import { readScrapersConfig } from "@/lib/scrapers";

export const dynamic = "force-dynamic";

interface StepProbe {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

async function probe(method: "GET" | "POST", url: string, body?: unknown): Promise<StepProbe> {
  const r = await hostFetch(method, url, body);
  const error = !r.ok
    ? (r.statusCode ? `HTTP ${r.statusCode}` : r.body.slice(0, 150))
    : undefined;
  return { ok: r.ok, statusCode: r.statusCode || undefined, latencyMs: r.latencyMs, error };
}

async function probeService(key: string, baseUrl: string): Promise<Record<string, StepProbe>> {
  if (key === "crunchbase") {
    const [health, search] = await Promise.all([
      probe("GET", `${baseUrl}/health`),
      probe("GET", `${baseUrl}/search/crunchbase?hashtag=fintech&num_companies=1`),
    ]);
    return { health, search };
  }

  if (key === "tracxn") {
    const [health, search] = await Promise.all([
      probe("GET", `${baseUrl}/health`),
      probe("POST", `${baseUrl}/scrape`, { search_term: "fintech", num_companies: 1, freshness_days: 9999 }),
    ]);
    return { health, search };
  }

  if (key === "twitter") {
    const [health, search] = await Promise.all([
      probe("GET", `${baseUrl}/health`),
      probe("POST", `${baseUrl}/search/tweets`, { keyword: "test", num_posts: 1, query_type: "Top" }),
    ]);
    return { health, search };
  }

  if (key === "news-search") {
    const [health, search] = await Promise.all([
      probe("GET", `${baseUrl}/api/health`),
      probe("POST", `${baseUrl}/api/search`, {
        phrase: "test",
        searchType: "google",
        maxResults: 1,
      }),
    ]);
    return { health, search };
  }

  return { health: await probe("GET", `${baseUrl}/health`) };
}

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await readScrapersConfig();

  const svcEntries = Object.entries(cfg.services);
  const svcResults = await Promise.all(
    svcEntries.map(async ([key, svc]) => {
      const steps = await probeService(key, svc.url);
      const allOk = Object.values(steps).every((s) => s.ok);
      const totalLatency = Object.values(steps).reduce((a, s) => a + s.latencyMs, 0);
      const errors = Object.entries(steps)
        .filter(([, s]) => !s.ok)
        .map(([n, s]) => `${n}: ${s.error ?? "failed"}`)
        .join("; ");
      return [key, {
        url: svc.url,
        ok: allOk,
        latencyMs: totalLatency,
        status: allOk ? "healthy" : "down",
        steps,
        data: null,
        error: errors || undefined,
      }] as const;
    })
  );

  const services: Record<string, unknown> = {};
  for (const [k, v] of svcResults) services[k] = v;

  // Orchestrator
  const [orchHealth, orchWorkers] = await Promise.all([
    hostFetch("GET", `${cfg.orchestratorUrl}/health`),
    hostFetch("GET", `${cfg.orchestratorUrl}/workers`),
  ]);

  const byType: Record<string, { total: number; idle: number; working: number }> = {};
  try {
    const workers = JSON.parse(orchWorkers.body);
    if (Array.isArray(workers?.workers)) {
      for (const w of workers.workers as Array<Record<string, unknown>>) {
        const t = typeof w.api_type === "string" ? w.api_type : "unknown";
        if (!byType[t]) byType[t] = { total: 0, idle: 0, working: 0 };
        byType[t].total += 1;
        if (w.status === "idle") byType[t].idle += 1;
        if (w.status === "working") byType[t].working += 1;
      }
    }
  } catch {}

  let orchStatus = "unreachable";
  try { orchStatus = JSON.parse(orchHealth.body)?.status ?? (orchHealth.ok ? "healthy" : "unreachable"); } catch {}

  return json({
    ok: true,
    services,
    orchestrator: {
      ok: orchHealth.ok,
      latencyMs: orchHealth.latencyMs,
      status: orchStatus,
      error: orchHealth.ok ? undefined : orchHealth.body.slice(0, 150),
      workers: orchWorkers.ok
        ? { ok: true, byType }
        : { ok: false, byType: {}, error: orchWorkers.body.slice(0, 150) },
    },
    checkedAt: new Date().toISOString(),
  });
});
