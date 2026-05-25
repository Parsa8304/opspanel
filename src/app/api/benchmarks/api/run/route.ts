import { NextRequest } from "next/server";
import { handler, json, getSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  benchmarkEndpoint,
  BENCHMARKS_SETTING_KEY,
  DEFAULT_BENCHMARKS_CONFIG,
  type BenchmarksConfig,
} from "@/lib/codeanalysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = await req.json().catch(() => ({}));
  const n = Math.min(Math.max(Number(body?.n) || 20, 1), 200);
  const cfg = await getSetting<BenchmarksConfig>(
    BENCHMARKS_SETTING_KEY,
    DEFAULT_BENCHMARKS_CONFIG
  );
  const endpoints = Array.isArray(cfg.endpoints) ? cfg.endpoints : [];
  if (endpoints.length === 0) {
    return json(
      { error: "No endpoints configured. Add endpoints in config first." },
      { status: 409 }
    );
  }
  const results: any[] = [];
  for (const ep of endpoints) {
    if (!ep?.url) continue;
    try {
      const r = await benchmarkEndpoint(ep.url, { n, persist: true });
      results.push({
        name: ep.name || ep.url,
        url: ep.url,
        ok: true,
        p50Ms: r.p50Ms,
        p95Ms: r.p95Ms,
        p99Ms: r.p99Ms,
        n: r.n,
      });
    } catch (e) {
      results.push({
        name: ep.name || ep.url,
        url: ep.url,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  await audit(user.id, "benchmarks.api.run", undefined, {
    n,
    endpoints: endpoints.length,
    ok: results.filter((r) => r.ok).length,
  });
  return json({ results }, { status: 201 });
});
