// Section 11 — Report Generator.
//
// HONESTY PRINCIPLE: this lib aggregates REAL current data from the existing
// section libs. Each data source is collected in its own try/catch so a single
// unreachable source (Docker daemon down, Redis down, git unconfigured) yields
// an honest `{ unavailable: true, reason }` block — NEVER a fabricated number.
//
// Two render modes share the SAME numbers:
//  - INTERNAL: brutally honest. Stale Q/A is shown stale, NOT_STARTED coverage
//    is shown "NOT DONE", missing integrations "not configured".
//  - REVIEWER: identical metrics + facts, with roadmap framing added around
//    pending/incomplete items (using the CoverageItem owner/deadline, or
//    "roadmap date TBD" when absent). It changes NO metric and hides NO gap.

import { prisma } from "./prisma";
import { effectiveStatus, isStale, daysSinceVerified, humanizeModule } from "./qa";
import { groupByCompose } from "./docker";
import * as integrationsLib from "./integrations";
import { queueDepths, jobStats, TASK_TYPES } from "./celery";
import { currentHead, log as gitLog } from "./git";
import { computeFlaky } from "./junit";
import { aiCostAgg } from "./codeanalysis";
import { stats as aiQualityStats } from "./aiquality";

export type ReportMode = "INTERNAL" | "REVIEWER";
export type ReportLang = "EN" | "FA";

/** Which of the 9 data areas to include. */
export interface SectionsConfig {
  qa: boolean;
  containers: boolean;
  integrations: boolean;
  async: boolean;
  deployments: boolean;
  tests: boolean;
  benchmarks: boolean;
  aiQuality: boolean;
  access: boolean;
}

export const ALL_SECTIONS: SectionsConfig = {
  qa: true,
  containers: true,
  integrations: true,
  async: true,
  deployments: true,
  tests: true,
  benchmarks: true,
  aiQuality: true,
  access: true,
};

/** An honest "this source could not be reached" marker. */
export interface Unavailable {
  unavailable: true;
  reason: string;
}

export function isUnavailable(v: unknown): v is Unavailable {
  return !!v && typeof v === "object" && (v as any).unavailable === true;
}

/** Wrap a collector so any throw becomes an honest unavailable block. */
async function safe<T>(fn: () => Promise<T>): Promise<T | Unavailable> {
  try {
    return await fn();
  } catch (e) {
    return {
      unavailable: true,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

// ───────────────────────────── Snapshot shape ─────────────────────────────

export interface QaBlock {
  total: number;
  passing: number;
  failing: number;
  stale: number;
  items: {
    module: string;
    title: string;
    effectiveStatus: "PASSING" | "FAILING" | "STALE";
    isStale: boolean;
    daysSinceVerified: number | null;
  }[];
  coverage: {
    total: number;
    notStarted: number;
    inProgress: number;
    blocked: number;
    done: number;
    items: {
      title: string;
      area: string;
      status: string;
      owner: string | null;
      deadline: string | null;
      blockers: string | null;
    }[];
  };
}

export interface ReportSnapshot {
  collectedAt: string;
  sections: SectionsConfig;
  qa?: QaBlock | Unavailable;
  containers?: any | Unavailable;
  integrations?: any | Unavailable;
  async?: any | Unavailable;
  deployments?: any | Unavailable;
  tests?: any | Unavailable;
  benchmarks?: any | Unavailable;
  aiQuality?: any | Unavailable;
  access?: any | Unavailable;
}

export interface ReportLike {
  title: string;
  mode: ReportMode;
  language: ReportLang;
  version: number;
  createdAt: Date | string;
  createdBy?: { name: string } | null;
  snapshot: ReportSnapshot;
}

// ───────────────────────────── Collectors ─────────────────────────────

async function collectQa(): Promise<QaBlock> {
  const now = new Date();
  const items = await prisma.regressionItem.findMany({
    orderBy: { module: "asc" },
  });
  let passing = 0;
  let failing = 0;
  let stale = 0;
  const mapped = items.map((it) => {
    const eff = effectiveStatus(it, now);
    if (eff === "PASSING") passing++;
    else if (eff === "FAILING") failing++;
    else stale++;
    return {
      module: it.module as string,
      title: it.title,
      effectiveStatus: eff,
      isStale: isStale(it, now),
      daysSinceVerified: daysSinceVerified(it.lastVerifiedAt, now),
    };
  });
  const cov = await prisma.coverageItem.findMany({ orderBy: { area: "asc" } });
  const covItems = cov.map((c) => ({
    title: c.title,
    area: c.area,
    status: c.status as string,
    owner: c.owner,
    deadline: c.deadline ? c.deadline.toISOString() : null,
    blockers: c.blockers,
  }));
  return {
    total: items.length,
    passing,
    failing,
    stale,
    items: mapped,
    coverage: {
      total: cov.length,
      notStarted: cov.filter((c) => c.status === "NOT_STARTED").length,
      inProgress: cov.filter((c) => c.status === "IN_PROGRESS").length,
      blocked: cov.filter((c) => c.status === "BLOCKED").length,
      done: cov.filter((c) => c.status === "DONE").length,
      items: covItems,
    },
  };
}

async function collectContainers() {
  const { projects, ungrouped } = await groupByCompose();
  const all = [
    ...projects.flatMap((p) => p.services.flatMap((s) => s.containers)),
    ...ungrouped,
  ];
  const running = all.filter((c) => c.state === "running").length;
  const unhealthy = all.filter((c) => c.health === "unhealthy").length;
  const notRunning = all.filter((c) => c.state !== "running");
  return {
    total: all.length,
    running,
    notRunning: notRunning.length,
    unhealthy,
    projects: projects.map((p) => p.project),
    failing: notRunning.map((c) => ({
      name: c.name,
      state: c.state,
      status: c.status,
    })),
  };
}

async function collectIntegrations() {
  const list = await prisma.integration.findMany({ orderBy: { key: "asc" } });
  const out: any[] = [];
  for (const i of list) {
    let s: integrationsLib.StatsWindow | null = null;
    try {
      s = await integrationsLib.stats(i.key, 24 * 30);
    } catch {
      s = null;
    }
    out.push({
      key: i.key,
      name: i.name,
      category: i.category,
      enabled: i.enabled,
      configured:
        !!i.config && Object.keys(i.config as object).length > 0,
      calls30d: s ? s.count : 0,
      successRate: s ? s.successRate : null,
      lastSuccessAt: s ? s.lastSuccessAt : null,
    });
  }
  return {
    total: list.length,
    enabled: list.filter((i) => i.enabled).length,
    notConfigured: out.filter((o) => !o.configured).length,
    integrations: out,
  };
}

async function collectAsync() {
  const windowH = 24 * 7;
  // jobStats reads Postgres (always available); queueDepths needs Redis.
  const jobs = await jobStats(windowH);
  let queues: { queue: string; depth: number }[] | { error: string };
  try {
    queues = await queueDepths();
  } catch (e) {
    queues = { error: e instanceof Error ? e.message : String(e) };
  }
  const totals = jobs.reduce(
    (a, j) => ({
      total: a.total + j.total,
      success: a.success + j.success,
      failure: a.failure + j.failure,
      dead: a.dead + j.dead,
    }),
    { total: 0, success: 0, failure: 0, dead: 0 }
  );
  return {
    windowHours: windowH,
    taskTypes: TASK_TYPES,
    totals,
    perType: jobs.map((j) => ({
      taskType: j.taskType,
      total: j.total,
      success: j.success,
      failure: j.failure,
      dead: j.dead,
      successRate: j.successRate,
    })),
    queues: Array.isArray(queues)
      ? queues
      : { unavailable: true, reason: queues.error },
  };
}

async function collectDeployments() {
  const [deployments, releases] = await Promise.all([
    prisma.deployment.findMany({
      orderBy: { deployedAt: "desc" },
      take: 10,
      include: { deployedBy: { select: { name: true } } },
    }),
    prisma.release.findMany({ orderBy: { date: "desc" }, take: 5 }),
  ]);
  let head: { sha: string; shortSha: string; branch: string } | null = null;
  let gitNote: string | null = null;
  try {
    head = await currentHead();
  } catch (e) {
    gitNote = e instanceof Error ? e.message : String(e);
  }
  let recentCommits: { shortSha: string; message: string; date: string }[] = [];
  if (head) {
    try {
      const commits = await gitLog({ maxCount: 5 });
      recentCommits = commits.map((c) => ({
        shortSha: c.shortSha,
        message: c.message,
        date: c.date,
      }));
    } catch {
      recentCommits = [];
    }
  }
  return {
    head,
    gitNote, // honest note when git is not configured (not fabricated)
    recentCommits,
    deployments: deployments.map((d) => ({
      environment: d.environment as string,
      version: d.version,
      commitSha: d.commitSha.slice(0, 8),
      status: d.status,
      deployedBy: d.deployedBy?.name ?? null,
      deployedAt: d.deployedAt.toISOString(),
    })),
    releases: releases.map((r) => ({
      version: r.version,
      commitSha: r.commitSha.slice(0, 8),
      date: r.date.toISOString(),
    })),
  };
}

async function collectTests() {
  const runs = await prisma.testRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  const latest = runs[0] ?? null;
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const recentCases = await prisma.testCase.findMany({
    where: { testRun: { startedAt: { gte: since } } },
    select: { name: true, status: true, testRun: { select: { startedAt: true } } },
  });
  const flaky = computeFlaky(
    recentCases.map((c) => ({
      name: c.name,
      status: c.status as any,
      testRun: { startedAt: c.testRun.startedAt },
    }))
  );
  const coverage = await prisma.coverageMetric.findMany({
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  return {
    totalRuns: runs.length,
    latest: latest
      ? {
          total: latest.total,
          passed: latest.passed,
          failed: latest.failed,
          skipped: latest.skipped,
          startedAt: latest.startedAt.toISOString(),
        }
      : null,
    flakyCount: flaky.length,
    flaky: flaky.slice(0, 10).map((f) => ({
      name: f.name,
      flakiness: Math.round(f.flakiness * 1000) / 1000,
      passCount: f.passCount,
      failCount: f.failCount,
    })),
    latestCoveragePct: coverage[0]?.linesPct ?? null,
  };
}

async function collectBenchmarks() {
  const [code, api, aiAgg] = await Promise.all([
    prisma.codeMetric.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.apiBenchmark.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    aiCostAgg(30),
  ]);
  // Latest benchmark per endpoint.
  const byEndpoint = new Map<string, (typeof api)[number]>();
  for (const b of api) if (!byEndpoint.has(b.endpoint)) byEndpoint.set(b.endpoint, b);
  return {
    code: code
      ? {
          loc: code.loc,
          cyclomatic: code.cyclomatic,
          duplicationPct: code.duplicationPct,
          lintWarnings: code.lintWarnings,
          typeErrors: code.typeErrors,
          buildTimeMs: code.buildTimeMs,
          bundleBytes: code.bundleBytes,
          commitSha: code.commitSha,
        }
      : null,
    api: Array.from(byEndpoint.values()).map((b) => ({
      endpoint: b.endpoint,
      p50Ms: b.p50Ms,
      p95Ms: b.p95Ms,
      p99Ms: b.p99Ms,
    })),
    aiCost: aiAgg.map((m) => ({
      module: m.module,
      runs: m.runs,
      costUsd: m.costUsd,
      costPerRun: m.costPerRun,
    })),
    totalAiCost:
      Math.round(aiAgg.reduce((a, m) => a + m.costUsd, 0) * 1e6) / 1e6,
  };
}

async function collectAiQuality() {
  const mods = await aiQualityStats(30);
  const totalSamples = mods.reduce((a, m) => a + m.samples, 0);
  const totalRated = mods.reduce((a, m) => a + m.ratedCount, 0);
  return {
    windowDays: 30,
    totalSamples,
    totalRated,
    modules: mods.map((m) => ({
      module: m.module,
      samples: m.samples,
      ratedCount: m.ratedCount,
      avgHumanRating: m.avgHumanRating,
      hallucinationRate: m.hallucinationRate,
      refusalRate: m.refusalRate,
      errorRate: m.errorRate,
    })),
  };
}

async function collectAccess() {
  const now = new Date();
  const [users, scenarios, recentAudit] = await Promise.all([
    prisma.user.findMany({
      select: { role: true, lastLoginAt: true },
    }),
    prisma.accessScenario.findMany(),
    prisma.auditLog.count({
      where: { createdAt: { gte: new Date(now.getTime() - 30 * 24 * 3600_000) } },
    }),
  ]);
  const byRole: Record<string, number> = {};
  for (const u of users) byRole[u.role] = (byRole[u.role] || 0) + 1;
  let scStale = 0;
  let scPassing = 0;
  let scFailing = 0;
  for (const s of scenarios) {
    const eff = effectiveStatus(s, now);
    if (eff === "PASSING") scPassing++;
    else if (eff === "FAILING") scFailing++;
    else scStale++;
  }
  return {
    userCount: users.length,
    usersByRole: byRole,
    scenarios: {
      total: scenarios.length,
      passing: scPassing,
      failing: scFailing,
      stale: scStale,
      items: scenarios.map((s) => ({
        name: s.name,
        effectiveStatus: effectiveStatus(s, now),
        isStale: isStale(s, now),
      })),
    },
    auditEntries30d: recentAudit,
  };
}

// ───────────────────────────── collectSnapshot ─────────────────────────────

/**
 * Pull REAL current data for the requested sections. Every source is wrapped
 * so one failing source yields `{ unavailable: true, reason }`, never numbers.
 */
export async function collectSnapshot(
  sections: SectionsConfig
): Promise<ReportSnapshot> {
  const snap: ReportSnapshot = {
    collectedAt: new Date().toISOString(),
    sections,
  };
  if (sections.qa) snap.qa = await safe(collectQa);
  if (sections.containers) snap.containers = await safe(collectContainers);
  if (sections.integrations)
    snap.integrations = await safe(collectIntegrations);
  if (sections.async) snap.async = await safe(collectAsync);
  if (sections.deployments)
    snap.deployments = await safe(collectDeployments);
  if (sections.tests) snap.tests = await safe(collectTests);
  if (sections.benchmarks) snap.benchmarks = await safe(collectBenchmarks);
  if (sections.aiQuality) snap.aiQuality = await safe(collectAiQuality);
  if (sections.access) snap.access = await safe(collectAccess);
  return snap;
}

// ───────────────────── Headline metrics (for version diff) ─────────────────────

export interface Headline {
  key: string;
  label: string;
  value: number | null;
}

/** Extract comparable headline numbers from a snapshot (null when source down). */
export function headlineMetrics(snap: ReportSnapshot): Headline[] {
  const out: Headline[] = [];
  const qa = snap.qa;
  if (qa && !isUnavailable(qa)) {
    out.push({ key: "qa_total", label: "Q/A items", value: qa.total });
    out.push({ key: "qa_passing", label: "Q/A passing", value: qa.passing });
    out.push({ key: "qa_failing", label: "Q/A failing", value: qa.failing });
    out.push({ key: "qa_stale", label: "Q/A stale", value: qa.stale });
    out.push({
      key: "cov_done",
      label: "Coverage done",
      value: qa.coverage.done,
    });
    out.push({
      key: "cov_not_started",
      label: "Coverage not started",
      value: qa.coverage.notStarted,
    });
  }
  const c = snap.containers;
  if (c && !isUnavailable(c)) {
    out.push({ key: "ctr_running", label: "Containers running", value: c.running });
    out.push({ key: "ctr_down", label: "Containers not running", value: c.notRunning });
  }
  const ig = snap.integrations;
  if (ig && !isUnavailable(ig)) {
    out.push({ key: "int_enabled", label: "Integrations enabled", value: ig.enabled });
    out.push({
      key: "int_notcfg",
      label: "Integrations not configured",
      value: ig.notConfigured,
    });
  }
  const a = snap.async;
  if (a && !isUnavailable(a)) {
    out.push({ key: "job_total", label: "Async jobs (7d)", value: a.totals.total });
    out.push({ key: "job_dead", label: "Async dead jobs (7d)", value: a.totals.dead });
  }
  const tt = snap.tests;
  if (tt && !isUnavailable(tt)) {
    out.push({ key: "test_runs", label: "Test runs", value: tt.totalRuns });
    out.push({ key: "test_flaky", label: "Flaky tests", value: tt.flakyCount });
  }
  const aq = snap.aiQuality;
  if (aq && !isUnavailable(aq)) {
    out.push({ key: "ai_samples", label: "AI samples (30d)", value: aq.totalSamples });
    out.push({ key: "ai_rated", label: "AI samples rated", value: aq.totalRated });
  }
  const ac = snap.access;
  if (ac && !isUnavailable(ac)) {
    out.push({ key: "acc_users", label: "Users", value: ac.userCount });
    out.push({
      key: "acc_sc_stale",
      label: "Access scenarios stale",
      value: ac.scenarios.stale,
    });
  }
  return out;
}

/** Diff headline metrics between two snapshots (older → newer). */
export function diffHeadlines(
  older: ReportSnapshot,
  newer: ReportSnapshot
): { key: string; label: string; from: number | null; to: number | null; delta: number | null }[] {
  const a = new Map(headlineMetrics(older).map((h) => [h.key, h]));
  const b = new Map(headlineMetrics(newer).map((h) => [h.key, h]));
  const keys = Array.from(
    new Set([...Array.from(a.keys()), ...Array.from(b.keys())])
  );
  return keys.map((k) => {
    const from = a.get(k)?.value ?? null;
    const to = b.get(k)?.value ?? null;
    const label = a.get(k)?.label ?? b.get(k)?.label ?? k;
    const delta =
      from != null && to != null ? to - from : null;
    return { key: k, label, from, to, delta };
  });
}

// ───────────────────────────── i18n (report-local) ─────────────────────────────

const FA: Record<string, string> = {
  "Internal Stakeholder Review": "بازبینی داخلی ذی‌نفعان",
  "Reviewer Report": "گزارش بازبین",
  "Generated": "تولید‌شده",
  "Version": "نسخه",
  "Mode": "حالت",
  "Q/A Regression & Coverage": "رگرسیون و پوشش کیفیت",
  "Containers": "کانتینرها",
  "External Integrations": "یکپارچه‌سازی‌های بیرونی",
  "Async Pipeline": "صف پردازش ناهمگام",
  "Versions & Deployments": "نسخه‌ها و استقرارها",
  "Test Logs": "گزارش تست‌ها",
  "Code Benchmarks": "سنجه‌های کد",
  "AI Output Quality": "کیفیت خروجی هوش مصنوعی",
  "Access & Audit": "دسترسی و ممیزی",
  "Total": "مجموع",
  "Passing": "موفق",
  "Failing": "ناموفق",
  "Stale": "کهنه",
  "STALE — not re-verified within its window": "کهنه — در بازه‌اش دوباره تأیید نشده",
  "NOT DONE": "انجام‌نشده",
  "not configured": "پیکربندی‌نشده",
  "Source unavailable": "منبع در دسترس نیست",
  "This source could not be reached when the snapshot was captured":
    "هنگام گرفتن عکس فوری، این منبع در دسترس نبود",
  "Pending coverage": "پوشش در انتظار",
  "Current state": "وضعیت فعلی",
  "Planned roadmap": "نقشه راه برنامه‌ریزی‌شده",
  "roadmap date TBD": "تاریخ نقشه راه نامشخص",
  "owner": "مسئول",
  "deadline": "مهلت",
  "running": "در حال اجرا",
  "not running": "متوقف",
  "enabled": "فعال",
  "Honest internal view — gaps are shown as gaps, nothing is reframed.":
    "نمای داخلی صادقانه — شکاف‌ها همان‌گونه که هستند نشان داده می‌شوند، چیزی بازقاب‌بندی نمی‌شود.",
  "Same honest numbers as internal — pending items are framed as roadmap, no metric changed.":
    "همان اعداد صادقانه نمای داخلی — موارد در انتظار به‌صورت نقشه راه ارائه می‌شوند، هیچ سنجه‌ای تغییر نکرده.",
  "No data recorded yet": "هنوز داده‌ای ثبت نشده",
  "scenarios": "سناریوها",
  "users": "کاربران",
  "jobs (7d)": "کار (۷ روز)",
  "dead": "مرده",
  "samples (30d)": "نمونه (۳۰ روز)",
  "rated": "امتیازدار",
  "flaky tests": "تست‌های ناپایدار",
  "test runs": "اجراهای تست",
  "git not configured": "گیت پیکربندی نشده",
};

function tr(s: string, lang: ReportLang): string {
  return lang === "FA" ? FA[s] ?? s : s;
}

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
function faDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}
/** Number, localized for FA (Persian digits). */
function num(n: number | null | undefined, lang: ReportLang): string {
  if (n == null) return "—";
  const s = String(n);
  return lang === "FA" ? faDigits(s) : s;
}
function fmtDate(d: string | Date | null | undefined, lang: ReportLang): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "FA" ? "fa-IR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ───────────────────────── Section block model ─────────────────────────
// Renderers build a neutral block list, then emit Markdown or HTML. This keeps
// the EXACT same facts/numbers across modes; only roadmap framing lines differ.

type Row = { cells: string[]; gap?: boolean };
interface Block {
  title: string;
  // Plain narrative lines (mode-specific framing allowed here, never numbers).
  notes: string[];
  // Headline "k: v" facts (identical in both modes).
  facts: { k: string; v: string }[];
  table?: { headers: string[]; rows: Row[] };
  unavailable?: string;
}

function qaBlock(
  qa: QaBlock | Unavailable,
  mode: ReportMode,
  lang: ReportLang
): Block {
  const title = tr("Q/A Regression & Coverage", lang);
  if (isUnavailable(qa))
    return { title, notes: [], facts: [], unavailable: qa.reason };
  const facts = [
    { k: tr("Total", lang), v: num(qa.total, lang) },
    { k: tr("Passing", lang), v: num(qa.passing, lang) },
    { k: tr("Failing", lang), v: num(qa.failing, lang) },
    { k: tr("Stale", lang), v: num(qa.stale, lang) },
  ];
  const rows: Row[] = qa.items.map((it) => {
    const stale = it.effectiveStatus === "STALE";
    return {
      gap: stale || it.effectiveStatus === "FAILING",
      cells: [
        humanizeModule(it.module),
        esc(it.title),
        stale
          ? tr("STALE — not re-verified within its window", lang)
          : tr(it.effectiveStatus === "PASSING" ? "Passing" : "Failing", lang),
        it.daysSinceVerified == null
          ? "—"
          : num(it.daysSinceVerified, lang),
      ],
    };
  });
  const notes: string[] = [];
  const cov = qa.coverage;
  if (mode === "INTERNAL") {
    notes.push(
      `${tr("Pending coverage", lang)}: ${num(cov.notStarted, lang)} ${tr(
        "NOT DONE",
        lang
      )} · ${num(cov.inProgress, lang)} ${tr("In progress", "EN") === "In progress" && lang === "FA" ? "در حال انجام" : "in progress"} · ${num(cov.done, lang)} ${tr("done", "EN") && lang === "FA" ? "انجام‌شده" : "done"}.`
    );
    for (const c of cov.items) {
      if (c.status !== "DONE") {
        notes.push(
          `• ${esc(c.title)} (${esc(c.area)}) — ${
            c.status === "NOT_STARTED" ? tr("NOT DONE", lang) : esc(c.status)
          }${c.blockers ? ` — blockers: ${esc(c.blockers)}` : ""}`
        );
      }
    }
  } else {
    // REVIEWER: SAME numbers, roadmap framing around pending items.
    notes.push(
      `${tr("Current state", lang)}: ${num(cov.done, lang)}/${num(
        cov.total,
        lang
      )} ${lang === "FA" ? "انجام‌شده" : "done"}. ${tr(
        "Planned roadmap",
        lang
      )}:`
    );
    for (const c of cov.items) {
      if (c.status !== "DONE") {
        const owner = c.owner
          ? `${tr("owner", lang)}: ${esc(c.owner)}`
          : null;
        const dl = c.deadline
          ? `${tr("deadline", lang)}: ${fmtDate(c.deadline, lang)}`
          : tr("roadmap date TBD", lang);
        const meta = [owner, dl].filter(Boolean).join(" · ");
        notes.push(`• ${esc(c.title)} (${esc(c.area)}) → ${meta}`);
      }
    }
  }
  return {
    title,
    notes,
    facts,
    table: {
      headers: [
        tr("Q/A Regression & Coverage", lang),
        "Title",
        tr("Mode", "EN") === "Mode" && lang === "FA" ? "وضعیت" : "Status",
        lang === "FA" ? "روز از تأیید" : "Days since verified",
      ],
      rows,
    },
  };
}

function genericBlock(
  titleKey: string,
  data: any | Unavailable,
  lang: ReportLang,
  build: (d: any) => { notes: string[]; facts: { k: string; v: string }[]; table?: Block["table"] }
): Block {
  const title = tr(titleKey, lang);
  if (data === undefined)
    return { title, notes: [], facts: [] };
  if (isUnavailable(data))
    return { title, notes: [], facts: [], unavailable: data.reason };
  const built = build(data);
  return { title, notes: built.notes, facts: built.facts, table: built.table };
}

function buildBlocks(report: ReportLike): Block[] {
  const { snapshot: s, mode, language: lang } = report;
  const blocks: Block[] = [];
  if (s.sections.qa) blocks.push(qaBlock(s.qa as any, mode, lang));
  if (s.sections.containers)
    blocks.push(
      genericBlock("Containers", s.containers, lang, (d) => ({
        facts: [
          { k: tr("Total", lang), v: num(d.total, lang) },
          { k: tr("running", lang), v: num(d.running, lang) },
          { k: tr("not running", lang), v: num(d.notRunning, lang) },
          { k: "unhealthy", v: num(d.unhealthy, lang) },
        ],
        notes:
          d.failing.length === 0
            ? []
            : d.failing.map(
                (f: any) =>
                  `• ${esc(f.name)} — ${esc(f.state)} (${esc(f.status)})`
              ),
      }))
    );
  if (s.sections.integrations)
    blocks.push(
      genericBlock("External Integrations", s.integrations, lang, (d) => ({
        facts: [
          { k: tr("Total", lang), v: num(d.total, lang) },
          { k: tr("enabled", lang), v: num(d.enabled, lang) },
          { k: tr("not configured", lang), v: num(d.notConfigured, lang) },
        ],
        notes: [],
        table: {
          headers: ["Integration", tr("enabled", lang), "30d calls", "success"],
          rows: d.integrations.map((i: any) => ({
            gap: !i.configured || !i.enabled,
            cells: [
              `${esc(i.name)} (${esc(i.key)})`,
              i.configured
                ? i.enabled
                  ? tr("enabled", lang)
                  : "disabled"
                : tr("not configured", lang),
              num(i.calls30d, lang),
              i.successRate == null
                ? "—"
                : num(Math.round(i.successRate * 100), lang) + "%",
            ],
          })),
        },
      }))
    );
  if (s.sections.async)
    blocks.push(
      genericBlock("Async Pipeline", s.async, lang, (d) => {
        const notes: string[] = [];
        if (d.queues && (d.queues as any).unavailable) {
          notes.push(
            `${tr("Source unavailable", lang)}: ${esc(
              (d.queues as any).reason
            )}`
          );
        }
        return {
          facts: [
            { k: tr("jobs (7d)", lang), v: num(d.totals.total, lang) },
            { k: tr("Passing", lang), v: num(d.totals.success, lang) },
            { k: tr("Failing", lang), v: num(d.totals.failure, lang) },
            { k: tr("dead", lang), v: num(d.totals.dead, lang) },
          ],
          notes,
          table: {
            headers: ["Task type", "total", "success", "fail", "dead"],
            rows: d.perType.map((p: any) => ({
              gap: p.dead > 0 || p.failure > 0,
              cells: [
                esc(p.taskType),
                num(p.total, lang),
                num(p.success, lang),
                num(p.failure, lang),
                num(p.dead, lang),
              ],
            })),
          },
        };
      })
    );
  if (s.sections.deployments)
    blocks.push(
      genericBlock("Versions & Deployments", s.deployments, lang, (d) => {
        const notes: string[] = [];
        if (d.gitNote)
          notes.push(`${tr("git not configured", lang)}: ${esc(d.gitNote)}`);
        if (d.head)
          notes.push(
            `HEAD ${esc(d.head.shortSha)} (${esc(d.head.branch || "—")})`
          );
        return {
          facts: [
            {
              k: "deployments",
              v: num(d.deployments.length, lang),
            },
            { k: "releases", v: num(d.releases.length, lang) },
          ],
          notes,
          table: {
            headers: ["Env", "Version", "Commit", "By", "When"],
            rows: d.deployments.map((x: any) => ({
              cells: [
                esc(x.environment),
                esc(x.version || "—"),
                esc(x.commitSha),
                esc(x.deployedBy || "—"),
                fmtDate(x.deployedAt, lang),
              ],
            })),
          },
        };
      })
    );
  if (s.sections.tests)
    blocks.push(
      genericBlock("Test Logs", s.tests, lang, (d) => ({
        facts: [
          { k: tr("test runs", lang), v: num(d.totalRuns, lang) },
          { k: tr("flaky tests", lang), v: num(d.flakyCount, lang) },
          {
            k: "coverage %",
            v: d.latestCoveragePct == null ? "—" : num(d.latestCoveragePct, lang),
          },
        ],
        notes: d.latest
          ? [
              `latest: ${num(d.latest.passed, lang)}/${num(
                d.latest.total,
                lang
              )} passed, ${num(d.latest.failed, lang)} failed`,
            ]
          : [tr("No data recorded yet", lang)],
        table:
          d.flaky.length === 0
            ? undefined
            : {
                headers: ["Flaky test", "flakiness", "pass", "fail"],
                rows: d.flaky.map((f: any) => ({
                  gap: true,
                  cells: [
                    esc(f.name),
                    num(f.flakiness, lang),
                    num(f.passCount, lang),
                    num(f.failCount, lang),
                  ],
                })),
              },
      }))
    );
  if (s.sections.benchmarks)
    blocks.push(
      genericBlock("Code Benchmarks", s.benchmarks, lang, (d) => ({
        facts: d.code
          ? [
              { k: "LOC", v: num(d.code.loc, lang) },
              {
                k: "lint",
                v: d.code.lintWarnings == null ? "—" : num(d.code.lintWarnings, lang),
              },
              {
                k: "type errors",
                v: d.code.typeErrors == null ? "—" : num(d.code.typeErrors, lang),
              },
              { k: "AI cost (30d) USD", v: num(d.totalAiCost, lang) },
            ]
          : [{ k: "code metrics", v: tr("No data recorded yet", lang) }],
        notes: [],
        table:
          d.api.length === 0
            ? undefined
            : {
                headers: ["Endpoint", "p50", "p95", "p99"],
                rows: d.api.map((a: any) => ({
                  cells: [
                    esc(a.endpoint),
                    num(a.p50Ms, lang),
                    num(a.p95Ms, lang),
                    num(a.p99Ms, lang),
                  ],
                })),
              },
      }))
    );
  if (s.sections.aiQuality)
    blocks.push(
      genericBlock("AI Output Quality", s.aiQuality, lang, (d) => ({
        facts: [
          { k: tr("samples (30d)", lang), v: num(d.totalSamples, lang) },
          { k: tr("rated", lang), v: num(d.totalRated, lang) },
        ],
        notes:
          d.totalSamples === 0 ? [tr("No data recorded yet", lang)] : [],
        table:
          d.modules.length === 0
            ? undefined
            : {
                headers: ["Module", "samples", "rated", "avg rating", "halluc."],
                rows: d.modules.map((m: any) => ({
                  cells: [
                    esc(m.module),
                    num(m.samples, lang),
                    num(m.ratedCount, lang),
                    m.avgHumanRating == null ? "—" : num(m.avgHumanRating, lang),
                    num(Math.round(m.hallucinationRate * 100), lang) + "%",
                  ],
                })),
              },
      }))
    );
  if (s.sections.access)
    blocks.push(
      genericBlock("Access & Audit", s.access, lang, (d) => ({
        facts: [
          { k: tr("users", lang), v: num(d.userCount, lang) },
          {
            k: tr("scenarios", lang),
            v: num(d.scenarios.total, lang),
          },
          { k: tr("Stale", lang), v: num(d.scenarios.stale, lang) },
          { k: "audit (30d)", v: num(d.auditEntries30d, lang) },
        ],
        notes: Object.entries(d.usersByRole).map(
          ([r, n]) => `${r}: ${num(n as number, lang)}`
        ),
      }))
    );
  return blocks;
}

// ───────────────────────────── Markdown ─────────────────────────────

export function renderMarkdown(report: ReportLike): string {
  const lang = report.language;
  const blocks = buildBlocks(report);
  const titleLine =
    report.mode === "INTERNAL"
      ? tr("Internal Stakeholder Review", lang)
      : tr("Reviewer Report", lang);
  const intro =
    report.mode === "INTERNAL"
      ? tr(
          "Honest internal view — gaps are shown as gaps, nothing is reframed.",
          lang
        )
      : tr(
          "Same honest numbers as internal — pending items are framed as roadmap, no metric changed.",
          lang
        );
  const lines: string[] = [];
  lines.push(`# ${esc(report.title)} — ${titleLine}`);
  lines.push("");
  lines.push(
    `${tr("Version", lang)}: ${num(report.version, lang)} · ${tr(
      "Mode",
      lang
    )}: ${report.mode} · ${tr("Generated", lang)}: ${fmtDate(
      report.createdAt,
      lang
    )}`
  );
  lines.push("");
  lines.push(`> ${intro}`);
  lines.push("");
  for (const b of blocks) {
    lines.push(`## ${b.title}`);
    if (b.unavailable) {
      lines.push("");
      lines.push(
        `**${tr("Source unavailable", lang)}** — ${tr(
          "This source could not be reached when the snapshot was captured",
          lang
        )}: ${esc(b.unavailable)}`
      );
      lines.push("");
      continue;
    }
    if (b.facts.length) {
      lines.push("");
      lines.push(b.facts.map((f) => `**${f.k}**: ${f.v}`).join(" · "));
    }
    for (const n of b.notes) lines.push(`\n${n}`);
    if (b.table && b.table.rows.length) {
      lines.push("");
      lines.push(`| ${b.table.headers.join(" | ")} |`);
      lines.push(`| ${b.table.headers.map(() => "---").join(" | ")} |`);
      for (const r of b.table.rows) {
        const mark = r.gap ? " ⚠" : "";
        lines.push(`| ${r.cells.join(" | ")}${mark} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ───────────────────────────── HTML ─────────────────────────────

const FA_FONT_STACK =
  "'Vazirmatn','IRANSans','Tahoma','Segoe UI',system-ui,sans-serif";
const EN_FONT_STACK =
  "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderHtml(
  report: ReportLike,
  opts: { print?: boolean } = {}
): string {
  const lang = report.language;
  const rtl = lang === "FA";
  const blocks = buildBlocks(report);
  const titleLine =
    report.mode === "INTERNAL"
      ? tr("Internal Stakeholder Review", lang)
      : tr("Reviewer Report", lang);
  const intro =
    report.mode === "INTERNAL"
      ? tr(
          "Honest internal view — gaps are shown as gaps, nothing is reframed.",
          lang
        )
      : tr(
          "Same honest numbers as internal — pending items are framed as roadmap, no metric changed.",
          lang
        );

  const body: string[] = [];
  body.push(
    `<header><h1>${esc(report.title)} — ${esc(titleLine)}</h1>` +
      `<p class="meta">${esc(tr("Version", lang))}: ${num(
        report.version,
        lang
      )} · ${esc(tr("Mode", lang))}: ${esc(report.mode)} · ${esc(
        tr("Generated", lang)
      )}: ${esc(fmtDate(report.createdAt, lang))}</p>` +
      `<p class="intro">${esc(intro)}</p></header>`
  );
  for (const b of blocks) {
    body.push(`<section><h2>${esc(b.title)}</h2>`);
    if (b.unavailable) {
      body.push(
        `<div class="unavailable"><strong>${esc(
          tr("Source unavailable", lang)
        )}</strong> — ${esc(
          tr(
            "This source could not be reached when the snapshot was captured",
            lang
          )
        )}: ${esc(b.unavailable)}</div></section>`
      );
      continue;
    }
    if (b.facts.length) {
      body.push(
        `<div class="facts">${b.facts
          .map(
            (f) =>
              `<span class="fact"><b>${esc(f.k)}</b> ${esc(f.v)}</span>`
          )
          .join("")}</div>`
      );
    }
    for (const n of b.notes)
      body.push(`<p class="note">${n}</p>`);
    if (b.table && b.table.rows.length) {
      body.push(
        `<table><thead><tr>${b.table.headers
          .map((h) => `<th>${esc(h)}</th>`)
          .join("")}</tr></thead><tbody>` +
          b.table.rows
            .map(
              (r) =>
                `<tr class="${r.gap ? "gap" : ""}">${r.cells
                  .map((c) => `<td>${c}</td>`)
                  .join("")}</tr>`
            )
            .join("") +
          `</tbody></table>`
      );
    }
    body.push(`</section>`);
  }

  const fontStack = rtl ? FA_FONT_STACK : EN_FONT_STACK;
  const autoPrint = opts.print
    ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},300)})</script>`
    : "";

  return `<!doctype html>
<html lang="${lang === "FA" ? "fa" : "en"}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(report.title)} — ${esc(titleLine)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font-family: ${fontStack};
    background: #ffffff; color: #18181b;
    line-height: 1.55;
    direction: ${rtl ? "rtl" : "ltr"};
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  header { border-bottom: 2px solid #10b981; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 8px; color: #064e3b; }
  h2 { font-size: 16px; margin: 28px 0 10px; color: #065f46;
       border-${rtl ? "right" : "left"}: 4px solid #10b981;
       padding-${rtl ? "right" : "left"}: 10px; }
  .meta { color: #52525b; font-size: 13px; margin: 4px 0; }
  .intro { color: #3f3f46; font-size: 13px; font-style: italic; margin: 8px 0 0; }
  .facts { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
  .fact { background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46;
          border-radius: 6px; padding: 4px 10px; font-size: 13px; }
  .fact b { color: #064e3b; }
  .note { font-size: 13px; margin: 6px 0; color: #27272a; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12.5px; }
  th, td { border: 1px solid #d4d4d8; padding: 6px 8px;
           text-align: ${rtl ? "right" : "left"}; }
  th { background: #f4f4f5; color: #3f3f46; font-weight: 600; }
  tr.gap td { background: #fef2f2; color: #991b1b; }
  .unavailable { background: #fffbeb; border: 1px solid #fde68a;
                 color: #92400e; padding: 12px; border-radius: 6px;
                 font-size: 13px; }
  @media print {
    body { padding: 0; font-size: 12px; }
    .wrap { max-width: none; }
    section { page-break-inside: avoid; }
    @page { margin: 16mm; }
  }
</style>
</head>
<body><div class="wrap">${body.join("\n")}</div>${autoPrint}</body>
</html>`;
}

// ───────────────────────────── PDF ─────────────────────────────

export interface PdfResult {
  available: boolean;
  /** Present only when available. */
  pdf?: Buffer;
  /** Honest reason when PDF generation is not possible here. */
  reason?: string;
  chromiumPath?: string;
}

/** Probe PATH for a usable system Chromium/Chrome. Honest — no fabrication. */
export function findChromium(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Render a PDF ONLY when a real system Chromium + puppeteer-core are available.
 * Otherwise returns `{ available:false, reason }` — we never fabricate a PDF;
 * the caller should fall back to the print-optimized HTML export.
 */
export async function renderPdf(report: ReportLike): Promise<PdfResult> {
  const chromiumPath = findChromium();
  if (!chromiumPath) {
    return {
      available: false,
      reason:
        "PDF export requires a system Chromium/Chrome on the server. None was found on PATH. Use the print-optimized HTML export (?print=1) instead.",
    };
  }
  let puppeteer: any;
  try {
    // Optional dependency — only loaded when actually generating a PDF.
    // Indirect require so the bundler does not hard-resolve an absent dep;
    // when puppeteer-core is not installed we fall back honestly to HTML.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = eval("require") as NodeJS.Require;
    puppeteer = req("puppeteer-core");
  } catch {
    return {
      available: false,
      chromiumPath,
      reason:
        "Chromium is present but 'puppeteer-core' is not installed. Install puppeteer-core to enable server-side PDF, or use the print-optimized HTML export.",
    };
  }
  const html = renderHtml(report, { print: false });
  let browser: any;
  try {
    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" },
    });
    return { available: true, pdf: Buffer.from(pdf), chromiumPath };
  } catch (e) {
    return {
      available: false,
      chromiumPath,
      reason: `Chromium launch/render failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ──────────────────── Service path (shared by API + test) ────────────────────

/**
 * Capture a fresh snapshot now and persist a Report. Version = max existing
 * version for the same title + 1. Each report stores its OWN immutable
 * snapshot, so old reports re-render from stored data, not live data.
 */
export async function createReport(input: {
  title: string;
  mode: ReportMode;
  language: ReportLang;
  sections: SectionsConfig;
  createdById?: string | null;
}) {
  const snapshot = await collectSnapshot(input.sections);
  const prev = await prisma.report.findFirst({
    where: { title: input.title },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (prev?.version ?? 0) + 1;
  return prisma.report.create({
    data: {
      title: input.title,
      mode: input.mode,
      language: input.language,
      version,
      sections: input.sections as unknown as object,
      snapshot: snapshot as unknown as object,
      createdById: input.createdById ?? undefined,
    },
  });
}
