import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { hostFetch } from "@/lib/server";
import { readScrapersConfig } from "@/lib/scrapers";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface ProbeDef {
  name: string;
  method: "GET" | "POST";
  url: string;
  body?: unknown;
}

function buildProbes(baseUrl: string, key: string): ProbeDef[] {
  const probes: ProbeDef[] = [
    { name: "health", method: "GET", url: `${baseUrl}/health` },
  ];
  if (key === "crunchbase") {
    probes.push({
      name: "search",
      method: "GET",
      url: `${baseUrl}/search/crunchbase?hashtag=fintech&num_companies=1`,
    });
  }
  if (key === "twitter") {
    probes.push({
      name: "search",
      method: "POST",
      url: `${baseUrl}/search/tweets`,
      body: { keyword: "test", num_posts: 1, query_type: "Top" },
    });
  }
  if (key === "news-search") {
    probes.push({
      name: "search",
      method: "POST",
      url: `${baseUrl}/api/search`,
      body: { phrase: "test", searchType: "google", maxResults: 1 },
    });
  }
  return probes;
}

async function timeProbe(
  p: ProbeDef,
  n: number
): Promise<{ p50Ms: number; p95Ms: number; p99Ms: number; ok: number; total: number }> {
  const samples: number[] = [];
  let okCount = 0;
  for (let i = 0; i < n; i++) {
    const r = await hostFetch(p.method, p.url, p.body, 15);
    if (r.ok) {
      samples.push(r.latencyMs);
      okCount++;
    }
  }
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, ok: 0, total: n };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
  };
  return {
    p50Ms: Math.round(pct(50)),
    p95Ms: Math.round(pct(95)),
    p99Ms: Math.round(pct(99)),
    ok: okCount,
    total: n,
  };
}

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = await req.json().catch(() => ({}));
  const n = Math.min(Math.max(Number(body?.n) || 5, 1), 20);

  const cfg = await readScrapersConfig();
  const results: Record<string, unknown> = {};

  for (const [key, svc] of Object.entries(cfg.services)) {
    const probes = buildProbes(svc.url, key);
    const probeResults: Record<string, unknown> = {};
    for (const p of probes) {
      const stats = await timeProbe(p, n);
      probeResults[p.name] = stats;
      if (stats.ok > 0) {
        await prisma.apiBenchmark.create({
          data: {
            endpoint: `${key}/${p.name}`,
            p50Ms: stats.p50Ms,
            p95Ms: stats.p95Ms,
            p99Ms: stats.p99Ms,
            commitSha: "host",
          },
        });
      }
    }
    results[key] = { url: svc.url, probes: probeResults };
  }

  // Also benchmark orchestrator health
  const orchProbe = await timeProbe(
    { name: "health", method: "GET", url: `${cfg.orchestratorUrl}/health` },
    n
  );
  results["orchestrator"] = { url: cfg.orchestratorUrl, probes: { health: orchProbe } };
  if (orchProbe.ok > 0) {
    await prisma.apiBenchmark.create({
      data: {
        endpoint: "orchestrator/health",
        p50Ms: orchProbe.p50Ms,
        p95Ms: orchProbe.p95Ms,
        p99Ms: orchProbe.p99Ms,
        commitSha: "host",
      },
    });
  }

  await audit(user.id, "benchmarks.scrapers.run", undefined, { n, services: Object.keys(results).length });
  return json({ results, n, ranAt: new Date().toISOString() }, { status: 201 });
});

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  // Return recent scraper benchmark rows (scrapers have "service/probe" endpoints)
  const scraperPrefixes = ["crunchbase/", "tracxn/", "twitter/", "news-search/", "orchestrator/"];
  const rows = await prisma.apiBenchmark.findMany({
    where: {
      OR: scraperPrefixes.map((p) => ({ endpoint: { startsWith: p } })),
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.endpoint)) { seen.add(r.endpoint); endpoints.push(r.endpoint); }
  }
  endpoints.sort();
  return json({ rows, endpoints });
});
