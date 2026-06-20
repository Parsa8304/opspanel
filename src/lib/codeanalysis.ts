import { promises as fs } from "fs";
import { createHash } from "crypto";
import { spawn } from "child_process";
import path from "path";
import { prisma } from "./prisma";
import { currentHead, GitNotConfiguredError } from "./git";

/**
 * Code analysis & benchmarking primitives.
 *
 * HONESTY: every value returned here is computed from a real measurement of a
 * real on-disk directory / a real HTTP request / a real recorded row. When a
 * tool (eslint / tsc) is not available or not configured, the corresponding
 * field is returned as `null` — never fabricated. `cyclomatic` and
 * `duplicationPct` are explicitly documented heuristic approximations.
 */

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  ".git",
  "build",
  "coverage",
  ".turbo",
  "out",
]);

/** When git is not configured / has no commits we record an honest sentinel. */
export const UNKNOWN_SHA = "unknown";

/** Resolve the current commit sha via the Section 6 git lib. */
export async function resolveCommitSha(): Promise<string> {
  try {
    const head = await currentHead();
    return head.sha || UNKNOWN_SHA;
  } catch (e) {
    if (e instanceof GitNotConfiguredError) return UNKNOWN_SHA;
    // repo with no commits / detached / other git error → honest unknown
    return UNKNOWN_SHA;
  }
}

async function walkSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".") {
        if (SKIP_DIRS.has(ent.name)) continue;
      }
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await rec(full);
      } else if (ent.isFile() && SOURCE_EXT.has(path.extname(ent.name))) {
        out.push(full);
      }
    }
  }
  await rec(dir);
  return out;
}

export interface AnalyzeResult {
  loc: number;
  /** Heuristic: avg decision-point count per function-ish unit. APPROXIMATION. */
  cyclomatic: number;
  /** Heuristic: % of source lines inside a duplicated N-line window. APPROXIMATION. */
  duplicationPct: number;
  /** null when no eslint config / eslint unavailable (honest, not 0). */
  lintWarnings: number | null;
  /** null when tsc unavailable / no tsconfig (honest, not 0). */
  typeErrors: number | null;
  files: number;
}

const DECISION_RE = /\b(if|for|while|case|catch)\b|&&|\|\||\?(?!\.)/g;
const FUNCTION_RE =
  /\bfunction\b|=>|\b(?:async\s+)?(?:get|set)\s+\w+\s*\(|\b\w+\s*\([^)]*\)\s*\{/g;

/** Count non-empty lines + heuristic cyclomatic over a single file body. */
function metricsForSource(src: string): {
  loc: number;
  decisions: number;
  units: number;
} {
  let loc = 0;
  for (const line of src.split("\n")) {
    if (line.trim().length > 0) loc++;
  }
  const decisions = (src.match(DECISION_RE) || []).length;
  const units = (src.match(FUNCTION_RE) || []).length;
  return { loc, decisions, units };
}

/**
 * Real duplication estimate: slide an N-line window across all normalized
 * source lines, hash each window, and report the % of lines that fall inside
 * at least one window whose hash repeats. Heuristic but computed from real
 * file content (not invented).
 */
function duplicationPercent(allLines: string[], windowN = 6): number {
  const norm = allLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const total = norm.length;
  if (total < windowN) return 0;
  const seen = new Map<string, number>();
  // First pass: count window hashes.
  for (let i = 0; i + windowN <= norm.length; i++) {
    const h = createHash("sha1")
      .update(norm.slice(i, i + windowN).join("\n"))
      .digest("hex");
    seen.set(h, (seen.get(h) || 0) + 1);
  }
  // Second pass: mark lines covered by any duplicated window.
  const dupLine = new Array<boolean>(norm.length).fill(false);
  for (let i = 0; i + windowN <= norm.length; i++) {
    const h = createHash("sha1")
      .update(norm.slice(i, i + windowN).join("\n"))
      .digest("hex");
    if ((seen.get(h) || 0) > 1) {
      for (let k = i; k < i + windowN; k++) dupLine[k] = true;
    }
  }
  const dup = dupLine.reduce((a, b) => a + (b ? 1 : 0), 0);
  return total === 0 ? 0 : Math.round((dup / total) * 10000) / 100;
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 180000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || "spawn error" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Real lint count via `npx eslint`. null when no eslint config present. */
async function countLintWarnings(dir: string): Promise<number | null> {
  const hasConfig =
    (await fileExists(path.join(dir, ".eslintrc.json"))) ||
    (await fileExists(path.join(dir, ".eslintrc.js"))) ||
    (await fileExists(path.join(dir, ".eslintrc"))) ||
    (await fileExists(path.join(dir, "eslint.config.js"))) ||
    (await fileExists(path.join(dir, "eslint.config.mjs")));
  if (!hasConfig) return null;
  const res = await runCmd(
    "npx",
    ["--no-install", "eslint", ".", "--format", "json", "--no-error-on-unmatched-pattern"],
    dir
  );
  if (res.code === -1) return null;
  try {
    const start = res.stdout.indexOf("[");
    if (start < 0) return null;
    const parsed = JSON.parse(res.stdout.slice(start));
    let warnings = 0;
    for (const f of parsed) {
      warnings += (f.warningCount || 0) + (f.errorCount || 0);
    }
    return warnings;
  } catch {
    return null;
  }
}

/** Real type-error count via `npx tsc --noEmit`. null when no tsconfig. */
async function countTypeErrors(dir: string): Promise<number | null> {
  if (!(await fileExists(path.join(dir, "tsconfig.json")))) return null;
  const res = await runCmd(
    "npx",
    ["--no-install", "tsc", "--noEmit", "--pretty", "false"],
    dir
  );
  if (res.code === -1) return null;
  if (res.code === 0) return 0;
  const out = res.stdout + res.stderr;
  const matches = out.match(/error TS\d+:/g);
  return matches ? matches.length : 0;
}

export interface AnalyzeOpts {
  /** Skip eslint/tsc (fast metrics only). Default false. */
  skipTools?: boolean;
}

/** Run real static metrics over a target directory. */
export async function analyzeRepo(
  dir: string,
  opts: AnalyzeOpts = {}
): Promise<AnalyzeResult> {
  const files = await walkSourceFiles(dir);
  let loc = 0;
  let decisions = 0;
  let units = 0;
  const allLines: string[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    const m = metricsForSource(src);
    loc += m.loc;
    decisions += m.decisions;
    units += m.units;
    for (const line of src.split("\n")) allLines.push(line);
  }
  // Cyclomatic approximation: 1 base + decisions, averaged per function-ish
  // unit. When there are no detectable units, fall back to whole-file basis.
  const cyclomatic =
    units > 0
      ? Math.round(((decisions + units) / units) * 100) / 100
      : decisions > 0
      ? decisions + 1
      : files.length === 0
      ? 0
      : 1;
  const duplicationPct = duplicationPercent(allLines);

  let lintWarnings: number | null = null;
  let typeErrors: number | null = null;
  if (!opts.skipTools && files.length > 0) {
    lintWarnings = await countLintWarnings(dir);
    typeErrors = await countTypeErrors(dir);
  }

  return {
    loc,
    cyclomatic,
    duplicationPct,
    lintWarnings,
    typeErrors,
    files: files.length,
  };
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  async function rec(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await rec(full);
      else if (ent.isFile()) {
        try {
          const st = await fs.stat(full);
          total += st.size;
        } catch {
          /* skip */
        }
      }
    }
  }
  await rec(dir);
  return total;
}

export interface BuildResult {
  buildTimeMs: number;
  bundleBytes: number | null;
  ok: boolean;
  output: string;
}

/**
 * Heavy: runs the project build command and times it (wall clock). Measures
 * resulting `.next` (or `dist`) size in bytes. Opt-in only.
 */
export async function measureBuild(
  dir: string,
  buildCmd = "npm run build"
): Promise<BuildResult> {
  const parts = buildCmd.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  const start = Date.now();
  const res = await runCmd(cmd, args, dir, 600000);
  const buildTimeMs = Date.now() - start;
  let bundleBytes: number | null = null;
  for (const candidate of [".next", "dist", "build", "out"]) {
    const p = path.join(dir, candidate);
    if (await fileExists(p)) {
      bundleBytes = await dirSize(p);
      break;
    }
  }
  return {
    buildTimeMs,
    bundleBytes,
    ok: res.code === 0,
    output: (res.stdout + "\n" + res.stderr).slice(-8000),
  };
}

export interface CodeMetricInput {
  loc?: number | null;
  cyclomatic?: number | null;
  duplicationPct?: number | null;
  lintWarnings?: number | null;
  typeErrors?: number | null;
  buildTimeMs?: number | null;
  bundleBytes?: number | null;
  commitSha?: string;
}

/** Persist a CodeMetric, resolving the real commit sha when not supplied. */
export async function recordCodeMetric(partial: CodeMetricInput) {
  const commitSha = partial.commitSha || (await resolveCommitSha());
  return prisma.codeMetric.create({
    data: {
      commitSha,
      loc: partial.loc ?? null,
      cyclomatic: partial.cyclomatic ?? null,
      duplicationPct: partial.duplicationPct ?? null,
      lintWarnings: partial.lintWarnings ?? null,
      typeErrors: partial.typeErrors ?? null,
      buildTimeMs: partial.buildTimeMs ?? null,
      bundleBytes: partial.bundleBytes ?? null,
    },
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

export interface BenchmarkResult {
  endpoint: string;
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  samples: number[];
}

/**
 * Fire N real sequential HTTP requests against a URL and compute real
 * percentiles. Throws an honest error (no row persisted) when the URL is
 * unreachable or no successful samples were collected.
 */
export async function benchmarkEndpoint(
  url: string,
  opts: { n?: number; persist?: boolean; commitSha?: string } = {}
): Promise<BenchmarkResult> {
  const n = Math.min(Math.max(opts.n ?? 20, 1), 500);
  const samples: number[] = [];
  let lastErr = "";
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      // Drain body so timing reflects a full response.
      await r.arrayBuffer();
      samples.push(performance.now() - start);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (samples.length === 0) {
    throw new Error(
      `Endpoint unreachable — 0/${n} requests to ${url} succeeded${
        lastErr ? `: ${lastErr}` : ""
      }`
    );
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const result: BenchmarkResult = {
    endpoint: url,
    n: samples.length,
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 99) * 100) / 100,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    samples: sorted,
  };
  if (opts.persist) {
    const commitSha = opts.commitSha || (await resolveCommitSha());
    await prisma.apiBenchmark.create({
      data: {
        endpoint: url,
        p50Ms: result.p50Ms,
        p95Ms: result.p95Ms,
        p99Ms: result.p99Ms,
        commitSha: commitSha === UNKNOWN_SHA ? null : commitSha,
      },
    });
  }
  return result;
}

export interface AiCostInput {
  module: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number | null;
  commitSha?: string | null;
}

/** Shared entry point for AI sections to record a real AI call's cost. */
export async function recordAiCost(input: AiCostInput) {
  return prisma.aiCostMetric.create({
    data: {
      module: input.module,
      model: input.model,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      costUsd: input.costUsd ?? 0,
      latencyMs: input.latencyMs ?? null,
      commitSha: input.commitSha ?? null,
    },
  });
}

export interface AiModuleAgg {
  module: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costPerRun: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  models: string[];
}

/**
 * Aggregate real AiCostMetric rows per module over a recent window. Latency
 * stats only consider rows that actually recorded a latency (honest null when
 * none did).
 */
export async function aiCostAgg(windowDays = 30): Promise<AiModuleAgg[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.aiCostMetric.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
  const byModule = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byModule.get(r.module) || [];
    list.push(r);
    byModule.set(r.module, list);
  }
  const out: AiModuleAgg[] = [];
  for (const [module, list] of Array.from(byModule.entries())) {
    const tokensIn = list.reduce((a, r) => a + r.tokensIn, 0);
    const tokensOut = list.reduce((a, r) => a + r.tokensOut, 0);
    const costUsd =
      Math.round(list.reduce((a, r) => a + r.costUsd, 0) * 1e6) / 1e6;
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
    out.push({
      module,
      runs: list.length,
      tokensIn,
      tokensOut,
      costUsd,
      costPerRun:
        list.length > 0
          ? Math.round((costUsd / list.length) * 1e6) / 1e6
          : 0,
      avgLatencyMs,
      p95LatencyMs,
      models: Array.from(new Set(list.map((r) => r.model))).sort(),
    });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd);
}

export interface BenchmarksConfig {
  targetDir: string;
  buildCmd: string;
  endpoints: { name: string; url: string }[];
}

export const BENCHMARKS_SETTING_KEY = "benchmarks";

export const DEFAULT_BENCHMARKS_CONFIG: BenchmarksConfig = {
  targetDir: process.env.CODE_TARGET_DIR || "/opt/app",
  buildCmd: "npm run build",
  endpoints: [
    { name: "Overview API",        url: "http://localhost:3000/api/overview" },
    { name: "Containers API",      url: "http://localhost:3000/api/containers" },
    { name: "Scraper health",      url: "http://localhost:3000/api/scrapers/health" },
    { name: "Async overview",      url: "http://localhost:3000/api/async/overview" },
    { name: "Server stats",        url: "http://localhost:3000/api/server" },
  ],
};
