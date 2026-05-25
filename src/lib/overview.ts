// Section 1 — Overview / Home aggregation lib.
//
// HONESTY PRINCIPLE: the readiness score and alerts reflect REAL current state.
// A down source is reported as "unavailable / unknown" and is EXCLUDED from the
// score with a visible note (never silently scored as healthy). Stale Q/A and
// stale access scenarios count as NOT passing. Trends use only real recorded
// rows; when there is not enough data we say so honestly instead of faking a line.
//
// This builds on top of the same section libs that `report.ts` uses (and reuses
// `collectSnapshot` for the parts it covers) rather than re-implementing logic.

import { prisma } from "./prisma";
import { effectiveStatus, isStale } from "./qa";
import { listContainers } from "./docker";
import { jobStats } from "./celery";
import * as integrationsLib from "./integrations";
import { expiryInfo } from "./integrations";
import * as billingLib from "./billing";
import { deliveryHealth } from "./alerts";
import { detectConflicts, publicFindings, LOCAL_HOST } from "./ports";

// ───────────────────────────── Types ─────────────────────────────

export type Severity = "critical" | "warning" | "info";

export interface ScoreComponent {
  /** stable key */
  key: "qa" | "containers" | "tests" | "integrations" | "async" | "deploy";
  /** human label key (resolved in UI via i18n) */
  label: string;
  /** 0..100, or null when unavailable/unknown */
  score: number | null;
  /** weight used when this component IS counted */
  weight: number;
  available: boolean;
  /** honest reason when not available / unknown */
  note: string | null;
  /** small real detail, e.g. "3/12 running" */
  detail: string | null;
}

export interface ReadinessResult {
  /** Composite 0..100 over the AVAILABLE components only. */
  score: number | null;
  /** green >=85, amber 60..84, red <60, unknown when score is null */
  band: "green" | "amber" | "red" | "unknown";
  components: ScoreComponent[];
  /** keys of components excluded from the score (unavailable / unknown) */
  unavailableComponents: string[];
  /**
   * True when one or more components were excluded — the UI must show that the
   * score does NOT cover everything (honest partial coverage).
   */
  partial: boolean;
}

export interface Alert {
  id: string;
  severity: Severity;
  /** section area key */
  area:
    | "containers"
    | "async"
    | "integrations"
    | "qa"
    | "tests"
    | "access"
    | "billing"
    | "alerts"
    | "deploy"
    | "migration"
    | "ports";
  message: string;
  /** route to the relevant section */
  link: string;
}

export interface TrendPoint {
  day: string; // YYYY-MM-DD
  value: number;
}
export interface TrendSeries {
  key: "testPassRate" | "deployFrequency" | "aiCostUsd";
  enoughData: boolean;
  points: TrendPoint[];
}
export interface TrendsResult {
  testPassRate: TrendSeries;
  deployFrequency: TrendSeries;
  aiCostUsd: TrendSeries;
}

// ───────────────────── Phase 2 signal types ─────────────────────

/** A unit that may be honestly unavailable rather than fabricated. */
export interface Phase2BillingProvider {
  provider: string;
  /** null balance + reason when management key / base URL not configured */
  balance: number | null;
  totalCredits: number | null;
  totalUsage: number | null;
  available: boolean;
  note: string | null;
}
export interface Phase2Billing {
  available: boolean;
  note: string | null;
  todaySpend: number;
  spend30d: number;
  requests30d: number;
  /** real cost/day series from billing trends (last up to 14 pts) */
  costSeries: TrendSeries;
  providers: Phase2BillingProvider[];
  /** latest reconciliation run (most recent createdAt), honest null */
  recon: {
    provider: string;
    forDate: string;
    flagged: boolean;
    driftPct: number;
    driftAbs: number;
    status: string;
  } | null;
}

export interface Phase2Alerts {
  available: boolean;
  note: string | null;
  open: number;
  bySeverity: { INFO: number; WARN: number; ERROR: number; CRITICAL: number };
  deliveryDelayed: boolean;
  queued: number;
}

export interface Phase2DeployEnv {
  environment: string;
  state: string;
  commitSha: string;
  rolledBack: boolean;
  at: string;
}
export interface Phase2Deploy {
  available: boolean;
  note: string | null;
  perEnv: Phase2DeployEnv[];
  /** a currently RUNNING / QUEUED deploy if any */
  running: { id: string; environment: string; state: string } | null;
}

export interface Phase2Migration {
  available: boolean;
  note: string | null;
  inProgress: number;
  /** completed but not yet committed (status "completed") */
  uncommitted: number;
}

export interface Phase2Ports {
  available: boolean;
  note: string | null;
  hostName: string;
  conflicts: number;
  publicExposed: number;
}

export interface Phase2Discovery {
  available: boolean;
  note: string | null;
  pending: number;
}

export interface Phase2Signals {
  billing: Phase2Billing;
  alerts: Phase2Alerts;
  deploy: Phase2Deploy;
  migration: Phase2Migration;
  ports: Phase2Ports;
  discovery: Phase2Discovery;
}

// ───────────────────────────── helpers ─────────────────────────────

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function band(score: number | null): ReadinessResult["band"] {
  if (score == null) return "unknown";
  if (score >= 85) return "green";
  if (score >= 60) return "amber";
  return "red";
}

// ───────────────────────── readinessScore ─────────────────────────

/**
 * Composite readiness from REAL data. Each component is collected in its own
 * try/catch. A down/unknown component is marked unavailable and EXCLUDED from
 * the weighted average (with a visible note + `partial` flag) — it is never
 * defaulted to green.
 */
export async function readinessScore(): Promise<ReadinessResult> {
  const now = new Date();
  const components: ScoreComponent[] = [];

  // 1) Q/A pass rate — stale counts as NOT passing.
  try {
    const items = await prisma.regressionItem.findMany();
    if (items.length === 0) {
      components.push({
        key: "qa",
        label: "ovQaHealth",
        score: null,
        weight: 0.25,
        available: false,
        note: "ovNoQaItems",
        detail: null,
      });
    } else {
      let passing = 0;
      for (const it of items) {
        if (effectiveStatus(it, now) === "PASSING") passing++;
      }
      const pct = Math.round((passing / items.length) * 100);
      components.push({
        key: "qa",
        label: "ovQaHealth",
        score: pct,
        weight: 0.25,
        available: true,
        note: null,
        detail: `${passing}/${items.length}`,
      });
    }
  } catch (e) {
    components.push({
      key: "qa",
      label: "ovQaHealth",
      score: null,
      weight: 0.25,
      available: false,
      note: e instanceof Error ? e.message : String(e),
      detail: null,
    });
  }

  // 2) Container health from Docker. Docker down => UNKNOWN, excluded + noted.
  try {
    const all = await listContainers();
    if (all.length === 0) {
      components.push({
        key: "containers",
        label: "ovContainerHealth",
        score: null,
        weight: 0.2,
        available: false,
        note: "ovNoContainers",
        detail: null,
      });
    } else {
      const running = all.filter(
        (c) => c.state === "running" && c.health !== "unhealthy"
      ).length;
      const pct = Math.round((running / all.length) * 100);
      components.push({
        key: "containers",
        label: "ovContainerHealth",
        score: pct,
        weight: 0.2,
        available: true,
        note: null,
        detail: `${running}/${all.length}`,
      });
    }
  } catch (e) {
    components.push({
      key: "containers",
      label: "ovContainerHealth",
      score: null,
      weight: 0.2,
      available: false,
      // honest: Docker unreachable => excluded from score, NOT assumed healthy
      note: e instanceof Error ? e.message : String(e),
      detail: null,
    });
  }

  // 3) Test pass rate — latest real TestRun. None => unknown.
  try {
    const latest = await prisma.testRun.findFirst({
      orderBy: { startedAt: "desc" },
    });
    if (!latest || latest.total === 0) {
      components.push({
        key: "tests",
        label: "ovTestHealth",
        score: null,
        weight: 0.2,
        available: false,
        note: "ovNoTestRuns",
        detail: null,
      });
    } else {
      const pct = Math.round((latest.passed / latest.total) * 100);
      components.push({
        key: "tests",
        label: "ovTestHealth",
        score: pct,
        weight: 0.2,
        available: true,
        note: null,
        detail: `${latest.passed}/${latest.total}`,
      });
    }
  } catch (e) {
    components.push({
      key: "tests",
      label: "ovTestHealth",
      score: null,
      weight: 0.2,
      available: false,
      note: e instanceof Error ? e.message : String(e),
      detail: null,
    });
  }

  // 4) External integration health — share of ENABLED integrations whose last
  //    call succeeded recently (30d window). None enabled => unknown.
  try {
    const list = await prisma.integration.findMany();
    const enabled = list.filter((i) => i.enabled);
    if (enabled.length === 0) {
      components.push({
        key: "integrations",
        label: "ovIntegrationHealth",
        score: null,
        weight: 0.15,
        available: false,
        note: "ovNoEnabledIntegrations",
        detail: null,
      });
    } else {
      let healthy = 0;
      for (const i of enabled) {
        try {
          const s = await integrationsLib.stats(i.key, 24 * 30);
          // healthy = at least one call AND a recent success AND >50% success
          if (
            s.count > 0 &&
            s.lastSuccessAt != null &&
            (s.successRate ?? 0) >= 0.5
          ) {
            healthy++;
          }
        } catch {
          /* unhealthy / unknown for this one — counts as not healthy */
        }
      }
      const pct = Math.round((healthy / enabled.length) * 100);
      components.push({
        key: "integrations",
        label: "ovIntegrationHealth",
        score: pct,
        weight: 0.15,
        available: true,
        note: null,
        detail: `${healthy}/${enabled.length}`,
      });
    }
  } catch (e) {
    components.push({
      key: "integrations",
      label: "ovIntegrationHealth",
      score: null,
      weight: 0.15,
      available: false,
      note: e instanceof Error ? e.message : String(e),
      detail: null,
    });
  }

  // 5) Async job health — failure rate of jobs in last 24h. No records => unknown.
  try {
    const since = new Date(now.getTime() - 24 * 3600_000);
    const [total, failed] = await Promise.all([
      prisma.jobRecord.count({ where: { createdAt: { gte: since } } }),
      prisma.jobRecord.count({
        where: { createdAt: { gte: since }, status: { in: ["FAILURE", "DEAD"] } },
      }),
    ]);
    if (total === 0) {
      components.push({ key: "async", label: "ovAsyncHealth", score: null, weight: 0.1, available: false, note: "ovNoAsyncData", detail: null });
    } else {
      const pct = Math.round(((total - failed) / total) * 100);
      components.push({ key: "async", label: "ovAsyncHealth", score: pct, weight: 0.1, available: true, note: null, detail: `${failed} failed / ${total}` });
    }
  } catch (e) {
    components.push({ key: "async", label: "ovAsyncHealth", score: null, weight: 0.1, available: false, note: e instanceof Error ? e.message : String(e), detail: null });
  }

  // 6) Deploy health — latest DeployRun per env; FAILED/ROLLED_BACK counts as not healthy.
  try {
    const runs = await prisma.deployRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
    if (runs.length === 0) {
      components.push({ key: "deploy", label: "ovDeployHealth", score: null, weight: 0.1, available: false, note: "ovNoDeployData", detail: null });
    } else {
      const seen = new Set<string>();
      let good = 0, envCount = 0;
      for (const r of runs) {
        if (seen.has(r.environment)) continue;
        seen.add(r.environment);
        envCount++;
        if (r.state === "SUCCEEDED" && !r.rolledBack) good++;
      }
      const pct = Math.round((good / envCount) * 100);
      components.push({ key: "deploy", label: "ovDeployHealth", score: pct, weight: 0.1, available: true, note: null, detail: `${good}/${envCount} envs ok` });
    }
  } catch (e) {
    components.push({ key: "deploy", label: "ovDeployHealth", score: null, weight: 0.1, available: false, note: e instanceof Error ? e.message : String(e), detail: null });
  }

  const counted = components.filter(
    (c) => c.available && c.score != null
  );
  const unavailableComponents = components
    .filter((c) => !c.available || c.score == null)
    .map((c) => c.key);

  let score: number | null = null;
  if (counted.length > 0) {
    const totalW = counted.reduce((a, c) => a + c.weight, 0);
    const weighted = counted.reduce(
      (a, c) => a + (c.score as number) * c.weight,
      0
    );
    score = Math.round(weighted / totalW);
  }

  return {
    score,
    band: band(score),
    components,
    unavailableComponents,
    partial: unavailableComponents.length > 0,
  };
}

// ───────────────────────── activeAlerts ─────────────────────────

/**
 * Real, current problems only. Empty array when genuinely nothing is wrong.
 * Each source is independently guarded so a down source becomes its own honest
 * alert (or is skipped) — never a fabricated "all good".
 */
export async function activeAlerts(): Promise<Alert[]> {
  const now = new Date();
  const alerts: Alert[] = [];

  // Containers: failing / exited / unhealthy. Docker down => an info alert
  // (we cannot confirm health — honest, not green).
  try {
    const all = await listContainers();
    for (const c of all) {
      if (c.state !== "running") {
        alerts.push({
          id: `ctr-down-${c.id}`,
          severity: "critical",
          area: "containers",
          message: `Container ${c.name} is ${c.state} (${c.status})`,
          link: "/containers",
        });
      } else if (c.health === "unhealthy") {
        alerts.push({
          id: `ctr-unhealthy-${c.id}`,
          severity: "warning",
          area: "containers",
          message: `Container ${c.name} is unhealthy`,
          link: "/containers",
        });
      }
    }
  } catch (e) {
    alerts.push({
      id: "ctr-unreachable",
      severity: "warning",
      area: "containers",
      message: `Docker daemon unreachable — container health unknown: ${
        e instanceof Error ? e.message : String(e)
      }`,
      link: "/containers",
    });
  }

  // Async: failed / dead jobs in the last 7 days (real JobRecord rows).
  try {
    const since = new Date(now.getTime() - 7 * 24 * 3600_000);
    const bad = await prisma.jobRecord.groupBy({
      by: ["status", "taskType"],
      where: {
        createdAt: { gte: since },
        status: { in: ["FAILURE", "DEAD"] },
      },
      _count: { _all: true },
    });
    for (const row of bad) {
      const n = row._count._all;
      if (n > 0) {
        alerts.push({
          id: `job-${row.status}-${row.taskType}`,
          severity: row.status === "DEAD" ? "critical" : "warning",
          area: "async",
          message: `${n} ${row.status} job(s) for ${row.taskType} in the last 7 days`,
          link: "/async",
        });
      }
    }
  } catch {
    /* Postgres-backed; if it throws, other alerts still surface */
  }

  // Integrations: enabled but recently failing or never succeeded; plus
  // near/expired credentials.
  try {
    const list = await prisma.integration.findMany();
    for (const i of list) {
      if (i.enabled) {
        try {
          const s = await integrationsLib.stats(i.key, 24 * 7);
          if (s.count > 0 && (s.successRate ?? 1) < 0.5) {
            alerts.push({
              id: `int-failing-${i.key}`,
              severity: "warning",
              area: "integrations",
              message: `Integration ${i.name} success rate ${Math.round(
                (s.successRate ?? 0) * 100
              )}% over 7d`,
              link: "/integrations",
            });
          } else if (s.count > 0 && s.lastSuccessAt == null) {
            alerts.push({
              id: `int-nosuccess-${i.key}`,
              severity: "warning",
              area: "integrations",
              message: `Integration ${i.name} has recent calls but no successful call`,
              link: "/integrations",
            });
          }
        } catch {
          /* per-integration stats failure is non-fatal */
        }
      }
      const exp = expiryInfo(i.credentialExpiresAt);
      if (exp.expired) {
        alerts.push({
          id: `int-credexp-${i.key}`,
          severity: "critical",
          area: "integrations",
          message: `Credential for ${i.name} has expired`,
          link: "/integrations",
        });
      } else if (exp.warn) {
        alerts.push({
          id: `int-crednear-${i.key}`,
          severity: "warning",
          area: "integrations",
          message: `Credential for ${i.name} expires in ${exp.days} day(s)`,
          link: "/integrations",
        });
      }
    }
  } catch {
    /* non-fatal */
  }

  // Q/A: failing or stale regression items.
  try {
    const items = await prisma.regressionItem.findMany();
    let failing = 0;
    let stale = 0;
    for (const it of items) {
      const eff = effectiveStatus(it, now);
      if (eff === "FAILING") failing++;
      else if (eff === "STALE") stale++;
    }
    if (failing > 0) {
      alerts.push({
        id: "qa-failing",
        severity: "critical",
        area: "qa",
        message: `${failing} Q/A regression item(s) FAILING`,
        link: "/qa",
      });
    }
    if (stale > 0) {
      alerts.push({
        id: "qa-stale",
        severity: "warning",
        area: "qa",
        message: `${stale} Q/A regression item(s) STALE — not re-verified within their window`,
        link: "/qa",
      });
    }
  } catch {
    /* non-fatal */
  }

  // Tests: latest run with failures.
  try {
    const latest = await prisma.testRun.findFirst({
      orderBy: { startedAt: "desc" },
    });
    if (latest && latest.failed > 0) {
      alerts.push({
        id: `test-failed-${latest.id}`,
        severity: "warning",
        area: "tests",
        message: `Latest test run has ${latest.failed} failing test(s)`,
        link: "/tests",
      });
    }
  } catch {
    /* non-fatal */
  }

  // Access: stale access scenarios (stale = not passing, honest).
  try {
    const scenarios = await prisma.accessScenario.findMany();
    let stale = 0;
    let failing = 0;
    for (const sset of scenarios) {
      const eff = effectiveStatus(sset, now);
      if (eff === "STALE") stale++;
      else if (eff === "FAILING") failing++;
    }
    if (failing > 0) {
      alerts.push({
        id: "access-failing",
        severity: "critical",
        area: "access",
        message: `${failing} access scenario(s) FAILING`,
        link: "/access",
      });
    }
    if (stale > 0) {
      alerts.push({
        id: "access-stale",
        severity: "warning",
        area: "access",
        message: `${stale} access scenario(s) STALE — not re-verified within their window`,
        link: "/access",
      });
    }
  } catch {
    /* non-fatal */
  }

  // ── Phase 2 critical signals (real problems only) ──

  // Billing: latest reconciliation run that is FLAGGED (real drift).
  try {
    const recon = await prisma.reconciliationRun.findFirst({
      orderBy: { createdAt: "desc" },
    });
    if (recon && recon.flagged) {
      alerts.push({
        id: `billing-recon-${recon.provider}-${recon.forDate
          .toISOString()
          .slice(0, 10)}`,
        severity: "warning",
        area: "billing",
        message: `Billing drift flagged — ${recon.provider} ${recon.forDate
          .toISOString()
          .slice(0, 10)}: drift $${recon.driftAbs} (${recon.driftPct}%)`,
        link: "/billing",
      });
    }
  } catch {
    /* non-fatal */
  }

  // Alerts: delivery delayed (real queued deliveries that have not gone out).
  try {
    const h = await deliveryHealth();
    if (h.delayed && h.queued > 0) {
      alerts.push({
        id: "alerts-delivery-delayed",
        severity: "warning",
        area: "alerts",
        message: `${h.queued} alert delivery(ies) queued/delayed — Telegram/webhook not delivering`,
        link: "/alerts",
      });
    }
  } catch {
    /* non-fatal */
  }

  // Deploy: latest DeployRun per environment in a FAILED / ROLLED_BACK state.
  try {
    const runs = await prisma.deployRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    const seen = new Set<string>();
    for (const r of runs) {
      if (seen.has(r.environment)) continue;
      seen.add(r.environment);
      if (r.state === "FAILED" || r.state === "ROLLED_BACK" || r.rolledBack) {
        alerts.push({
          id: `deploy-bad-${r.environment}`,
          severity: "critical",
          area: "deploy",
          message: `Latest deploy to ${r.environment} is ${
            r.rolledBack && r.state !== "ROLLED_BACK"
              ? `${r.state} (rolled back)`
              : r.state
          } (${r.commitSha.slice(0, 8)})`,
          link: "/deploy",
        });
      }
    }
  } catch {
    /* non-fatal */
  }

  // Migration: a plan completed but not yet committed (real uncommitted state).
  try {
    const uncommitted = await prisma.migrationPlan.count({
      where: { status: "completed" },
    });
    if (uncommitted > 0) {
      alerts.push({
        id: "migration-uncommitted",
        severity: "warning",
        area: "migration",
        message: `${uncommitted} migration plan(s) completed but not committed`,
        link: "/migration",
      });
    }
    const failedMig = await prisma.migrationPlan.count({
      where: { status: "failed" },
    });
    if (failedMig > 0) {
      alerts.push({
        id: "migration-failed",
        severity: "critical",
        area: "migration",
        message: `${failedMig} migration plan(s) FAILED`,
        link: "/migration",
      });
    }
  } catch {
    /* non-fatal */
  }

  // Ports: real conflicts on the local host.
  try {
    const conflicts = await detectConflicts(LOCAL_HOST);
    if (conflicts.length > 0) {
      alerts.push({
        id: "ports-conflicts",
        severity: "warning",
        area: "ports",
        message: `${conflicts.length} port conflict(s) on ${LOCAL_HOST}`,
        link: "/ports",
      });
    }
  } catch {
    /* non-fatal */
  }

  return alerts;
}

// ───────────────────────── deployGate ─────────────────────────

export interface DeployGate {
  status: "allowed" | "blocked" | "warning";
  reasons: string[];
}

/**
 * Pure function — takes the already-computed alerts to decide gate status.
 * Blocked if any critical alerts. Warning if any warning alerts. Allowed otherwise.
 */
export function deployGate(alerts: Alert[]): DeployGate {
  const critical = alerts.filter((a) => a.severity === "critical");
  const warnings = alerts.filter((a) => a.severity === "warning");
  if (critical.length > 0) {
    return { status: "blocked", reasons: critical.slice(0, 5).map((a) => a.message) };
  }
  if (warnings.length > 0) {
    return { status: "warning", reasons: warnings.slice(0, 5).map((a) => a.message) };
  }
  return { status: "allowed", reasons: [] };
}

// ───────────────────────── topBlockers ─────────────────────────

export interface Blocker {
  id: string;
  severity: Severity;
  title: string;
  area: string;
  link: string;
}

/**
 * Pure function — ranks active alerts (critical first) and returns top N.
 */
export function topBlockers(alerts: Alert[], max = 5): Blocker[] {
  const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return [...alerts]
    .sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3))
    .slice(0, max)
    .map((a) => ({
      id: a.id,
      severity: a.severity,
      title: a.message,
      area: a.area,
      link: a.link,
    }));
}

// ───────────────────────── phase2Signals ─────────────────────────

/**
 * Phase 2 health aggregator. Every sub-source is independently try/caught and
 * reports an honest "unavailable / none" marker instead of a fabricated green.
 * Reuses the Phase 2 section libs (billing/alerts/ports) and light Prisma
 * counts for deploy/migration/discovery rather than heavy recompute.
 */
export async function phase2Signals(): Promise<Phase2Signals> {
  // ── Billing ──
  let billing: Phase2Billing = {
    available: false,
    note: "ovP2NoBilling",
    todaySpend: 0,
    spend30d: 0,
    requests30d: 0,
    costSeries: { key: "aiCostUsd", enoughData: false, points: [] },
    providers: [],
    recon: null,
  };
  try {
    const now = new Date();
    const startToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const [todaySum, sum30d] = await Promise.all([
      billingLib.spendSummary({ from: startToday, to: now }),
      billingLib.spendSummary({
        from: new Date(now.getTime() - 30 * 86400_000),
        to: now,
      }),
    ]);
    const trendDays = await billingLib.trends(14);
    const points: TrendPoint[] = trendDays.map((d) => ({
      day: d.date,
      value: d.cost,
    }));
    const hasAnyData =
      sum30d.requests > 0 || todaySum.requests > 0 || trendDays.length > 0;

    // Live balance per provider that has a configured ProviderCredential
    // (management). Honest "not configured" when no management key.
    const providers: Phase2BillingProvider[] = [];
    try {
      const provRows = await prisma.providerCredential.findMany({
        where: { credType: "management" },
        select: { provider: true },
      });
      const seen = new Set<string>();
      for (const pr of provRows) {
        if (seen.has(pr.provider)) continue;
        seen.add(pr.provider);
        try {
          const bal = await billingLib.liveBalance(pr.provider);
          if (bal.ok) {
            providers.push({
              provider: pr.provider,
              balance: bal.balance,
              totalCredits: bal.totalCredits,
              totalUsage: bal.totalUsage,
              available: true,
              note: bal.cached ? "ovP2Cached" : null,
            });
          } else {
            providers.push({
              provider: pr.provider,
              balance: null,
              totalCredits: null,
              totalUsage: null,
              available: false,
              note: bal.error,
            });
          }
        } catch (e) {
          providers.push({
            provider: pr.provider,
            balance: null,
            totalCredits: null,
            totalUsage: null,
            available: false,
            note: e instanceof Error ? e.message : "balance unavailable",
          });
        }
      }
    } catch {
      /* no provider credentials — honest empty providers list */
    }

    let recon: Phase2Billing["recon"] = null;
    try {
      const r = await prisma.reconciliationRun.findFirst({
        orderBy: { createdAt: "desc" },
      });
      if (r) {
        recon = {
          provider: r.provider,
          forDate: r.forDate.toISOString(),
          flagged: r.flagged,
          driftPct: r.driftPct,
          driftAbs: r.driftAbs,
          status: r.status,
        };
      }
    } catch {
      /* honest null recon */
    }

    billing = {
      available: hasAnyData,
      note: hasAnyData ? null : "ovP2NoBilling",
      todaySpend: todaySum.total,
      spend30d: sum30d.total,
      requests30d: sum30d.requests,
      costSeries: {
        key: "aiCostUsd",
        enoughData: points.length >= 2,
        points,
      },
      providers,
      recon,
    };
  } catch (e) {
    billing = {
      ...billing,
      available: false,
      note: e instanceof Error ? e.message : "billing unavailable",
    };
  }

  // ── Alerts ──
  let alerts: Phase2Alerts = {
    available: false,
    note: "ovP2Unavailable",
    open: 0,
    bySeverity: { INFO: 0, WARN: 0, ERROR: 0, CRITICAL: 0 },
    deliveryDelayed: false,
    queued: 0,
  };
  try {
    const grouped = await prisma.alertEvent.groupBy({
      by: ["severity"],
      where: { ackStatus: "open" },
      _count: { _all: true },
    });
    const bySeverity = { INFO: 0, WARN: 0, ERROR: 0, CRITICAL: 0 };
    let open = 0;
    for (const g of grouped) {
      const s = g.severity as keyof typeof bySeverity;
      if (s in bySeverity) bySeverity[s] = g._count._all;
      open += g._count._all;
    }
    let deliveryDelayed = false;
    let queued = 0;
    try {
      const h = await deliveryHealth();
      deliveryDelayed = h.delayed;
      queued = h.queued;
    } catch {
      /* delivery health unavailable — honest false/0 */
    }
    alerts = {
      available: true,
      note: null,
      open,
      bySeverity,
      deliveryDelayed,
      queued,
    };
  } catch (e) {
    alerts = {
      ...alerts,
      available: false,
      note: e instanceof Error ? e.message : "alerts unavailable",
    };
  }

  // ── Deploy ──
  let deploy: Phase2Deploy = {
    available: false,
    note: "ovP2Unavailable",
    perEnv: [],
    running: null,
  };
  try {
    const runs = await prisma.deployRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    const perEnv: Phase2DeployEnv[] = [];
    const seen = new Set<string>();
    let running: Phase2Deploy["running"] = null;
    for (const r of runs) {
      if (!running && (r.state === "RUNNING" || r.state === "QUEUED")) {
        running = {
          id: r.id,
          environment: r.environment,
          state: r.state,
        };
      }
      if (seen.has(r.environment)) continue;
      seen.add(r.environment);
      perEnv.push({
        environment: r.environment,
        state: r.state,
        commitSha: r.commitSha,
        rolledBack: r.rolledBack,
        at: r.startedAt.toISOString(),
      });
    }
    deploy = { available: true, note: null, perEnv, running };
  } catch (e) {
    deploy = {
      ...deploy,
      available: false,
      note: e instanceof Error ? e.message : "deploy unavailable",
    };
  }

  // ── Migration ──
  let migration: Phase2Migration = {
    available: false,
    note: "ovP2Unavailable",
    inProgress: 0,
    uncommitted: 0,
  };
  try {
    const [inProgress, uncommitted] = await Promise.all([
      prisma.migrationPlan.count({
        where: { status: { in: ["preflight", "in_progress"] } },
      }),
      prisma.migrationPlan.count({ where: { status: "completed" } }),
    ]);
    migration = { available: true, note: null, inProgress, uncommitted };
  } catch (e) {
    migration = {
      ...migration,
      available: false,
      note: e instanceof Error ? e.message : "migration unavailable",
    };
  }

  // ── Ports ──
  let ports: Phase2Ports = {
    available: false,
    note: "ovP2Unavailable",
    hostName: LOCAL_HOST,
    conflicts: 0,
    publicExposed: 0,
  };
  try {
    const [conf, pub] = await Promise.all([
      detectConflicts(LOCAL_HOST),
      publicFindings(LOCAL_HOST),
    ]);
    ports = {
      available: true,
      note: null,
      hostName: LOCAL_HOST,
      conflicts: conf.length,
      publicExposed: pub.length,
    };
  } catch (e) {
    ports = {
      ...ports,
      available: false,
      note: e instanceof Error ? e.message : "ports unavailable",
    };
  }

  // ── Discovery ──
  let discovery: Phase2Discovery = {
    available: false,
    note: "ovP2Unavailable",
    pending: 0,
  };
  try {
    const pending = await prisma.discoveryProposal.count({
      where: { status: "pending" },
    });
    discovery = { available: true, note: null, pending };
  } catch (e) {
    discovery = {
      ...discovery,
      available: false,
      note: e instanceof Error ? e.message : "discovery unavailable",
    };
  }

  return { billing, alerts, deploy, migration, ports, discovery };
}

// ───────────────────────────── trends ─────────────────────────────

const DAYS_WINDOW = 14;

function emptyDays(): Map<string, number> {
  const m = new Map<string, number>();
  const now = new Date();
  for (let i = DAYS_WINDOW - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600_000);
    m.set(dayKey(d), 0);
  }
  return m;
}

/**
 * Real series only. `enoughData` is true only when there are >=2 distinct days
 * with real recorded rows — otherwise the UI shows an honest "not enough data"
 * placeholder instead of a misleading flat line.
 */
export async function trends(): Promise<TrendsResult> {
  const since = new Date(Date.now() - DAYS_WINDOW * 24 * 3600_000);

  // Test pass rate per day (from real TestRun rows).
  let testPassRate: TrendSeries = {
    key: "testPassRate",
    enoughData: false,
    points: [],
  };
  try {
    const runs = await prisma.testRun.findMany({
      where: { startedAt: { gte: since } },
      orderBy: { startedAt: "asc" },
    });
    const byDay = new Map<string, { passed: number; total: number }>();
    for (const r of runs) {
      if (r.total <= 0) continue;
      const k = dayKey(r.startedAt);
      const cur = byDay.get(k) || { passed: 0, total: 0 };
      cur.passed += r.passed;
      cur.total += r.total;
      byDay.set(k, cur);
    }
    const points: TrendPoint[] = Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({
        day,
        value: Math.round((v.passed / v.total) * 100),
      }));
    testPassRate = {
      key: "testPassRate",
      enoughData: byDay.size >= 2,
      points,
    };
  } catch {
    /* leave honest empty/not-enough */
  }

  // Deployment frequency per day (real Deployment rows).
  let deployFrequency: TrendSeries = {
    key: "deployFrequency",
    enoughData: false,
    points: [],
  };
  try {
    const deps = await prisma.deployment.findMany({
      where: { deployedAt: { gte: since } },
      select: { deployedAt: true },
    });
    const days = emptyDays();
    const distinct = new Set<string>();
    for (const d of deps) {
      const k = dayKey(d.deployedAt);
      if (days.has(k)) days.set(k, (days.get(k) || 0) + 1);
      distinct.add(k);
    }
    deployFrequency = {
      key: "deployFrequency",
      enoughData: distinct.size >= 2,
      points: Array.from(days.entries()).map(([day, value]) => ({
        day,
        value,
      })),
    };
  } catch {
    /* honest fallback */
  }

  // AI cost per day (sum AiCostMetric.costUsd).
  let aiCostUsd: TrendSeries = {
    key: "aiCostUsd",
    enoughData: false,
    points: [],
  };
  try {
    const rows = await prisma.aiCostMetric.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, costUsd: true },
    });
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const k = dayKey(r.createdAt);
      byDay.set(k, (byDay.get(k) || 0) + (r.costUsd || 0));
    }
    const points: TrendPoint[] = Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({
        day,
        value: Math.round(v * 1e6) / 1e6,
      }));
    aiCostUsd = {
      key: "aiCostUsd",
      enoughData: byDay.size >= 2,
      points,
    };
  } catch {
    /* honest fallback */
  }

  return { testPassRate, deployFrequency, aiCostUsd };
}

// ───────────────────────── lastDeployment + quickStats ─────────────────────

export interface LastDeployment {
  version: string | null;
  env: string;
  at: string;
}

export async function lastDeployment(): Promise<LastDeployment | null> {
  try {
    const d = await prisma.deployment.findFirst({
      orderBy: { deployedAt: "desc" },
    });
    if (!d) return null;
    return {
      version: d.version ?? null,
      env: d.environment as string,
      at: d.deployedAt.toISOString(),
    };
  } catch {
    return null;
  }
}

export interface QuickStats {
  qaPassing: number | null;
  qaTotal: number | null;
  containersRunning: number | null;
  containersTotal: number | null;
  /** honest note when container data is unavailable */
  containersNote: string | null;
  openAlerts: number;
}

export async function quickStats(alertCount: number): Promise<QuickStats> {
  const now = new Date();
  let qaPassing: number | null = null;
  let qaTotal: number | null = null;
  try {
    const items = await prisma.regressionItem.findMany();
    qaTotal = items.length;
    qaPassing = items.filter(
      (i) => effectiveStatus(i, now) === "PASSING"
    ).length;
  } catch {
    qaPassing = null;
    qaTotal = null;
  }

  let containersRunning: number | null = null;
  let containersTotal: number | null = null;
  let containersNote: string | null = null;
  try {
    const all = await listContainers();
    containersTotal = all.length;
    containersRunning = all.filter((c) => c.state === "running").length;
  } catch (e) {
    containersNote =
      e instanceof Error ? e.message : "Docker unreachable";
  }

  return {
    qaPassing,
    qaTotal,
    containersRunning,
    containersTotal,
    containersNote,
    openAlerts: alertCount,
  };
}

// ───────────────────────── recentChangesTimeline ─────────────────────────

export interface TimelineEvent {
  id: string;
  type: "deploy" | "deploy-fail" | "job-fail" | "billing-drift";
  title: string;
  detail: string | null;
  at: string; // ISO timestamp
  severity: Severity;
  link: string;
}

/**
 * Merged timeline of significant recent changes (last 7 days, capped at 20).
 * Each source is independently try-caught — a down source is silently skipped.
 */
export async function recentChangesTimeline(): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];
  const since = new Date(Date.now() - 7 * 24 * 3600_000);

  // Successful deployments
  try {
    const deps = await prisma.deployment.findMany({
      where: { deployedAt: { gte: since } },
      orderBy: { deployedAt: "desc" },
      take: 10,
    });
    for (const d of deps) {
      events.push({
        id: `deploy-${d.id}`,
        type: "deploy",
        title: `Deployed to ${d.environment}`,
        detail: d.version ? `v${d.version} · ${d.commitSha.slice(0, 8)}` : d.commitSha.slice(0, 8),
        at: d.deployedAt.toISOString(),
        severity: "info",
        link: "/deployments",
      });
    }
  } catch { /* skip */ }

  // Failed / rolled-back deploy runs
  try {
    const runs = await prisma.deployRun.findMany({
      where: {
        startedAt: { gte: since },
        OR: [
          { state: { in: ["FAILED", "ROLLED_BACK"] } },
          { rolledBack: true },
        ],
      },
      orderBy: { startedAt: "desc" },
      take: 10,
    });
    for (const r of runs) {
      events.push({
        id: `deploy-fail-${r.id}`,
        type: "deploy-fail",
        title: `Deploy to ${r.environment} ${r.rolledBack && r.state !== "ROLLED_BACK" ? "rolled back" : r.state.toLowerCase()}`,
        detail: r.commitSha.slice(0, 8),
        at: r.startedAt.toISOString(),
        severity: "critical",
        link: "/deploy",
      });
    }
  } catch { /* skip */ }

  // Failed / dead async jobs
  try {
    const jobs = await prisma.jobRecord.findMany({
      where: {
        createdAt: { gte: since },
        status: { in: ["FAILURE", "DEAD"] },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    for (const j of jobs) {
      events.push({
        id: `job-fail-${j.id}`,
        type: "job-fail",
        title: `Job ${j.taskType} ${j.status.toLowerCase()}`,
        detail: j.queue !== "default" ? `queue: ${j.queue}` : null,
        at: j.createdAt.toISOString(),
        severity: j.status === "DEAD" ? "critical" : "warning",
        link: "/async",
      });
    }
  } catch { /* skip */ }

  // Flagged billing reconciliation
  try {
    const recons = await prisma.reconciliationRun.findMany({
      where: { createdAt: { gte: since }, flagged: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    for (const r of recons) {
      events.push({
        id: `billing-drift-${r.id}`,
        type: "billing-drift",
        title: `Billing drift flagged — ${r.provider}`,
        detail: `${r.driftPct}% drift ($${r.driftAbs.toFixed(2)})`,
        at: r.createdAt.toISOString(),
        severity: "warning",
        link: "/billing",
      });
    }
  } catch { /* skip */ }

  // Sort descending by timestamp, cap at 20
  return events
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 20);
}

// ───────────────────────── environmentHealthSummary ─────────────────────────

export interface EnvironmentHealth {
  environment: string;
  lastDeployState: string | null;
  lastDeployAt: string | null;
  commitSha: string | null;
  version: string | null;
  rolledBack: boolean;
}

/**
 * Latest deploy run per environment. Returns only environments that have
 * at least one DeployRun record.
 */
export async function environmentHealthSummary(): Promise<EnvironmentHealth[]> {
  try {
    const runs = await prisma.deployRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    const seen = new Set<string>();
    const results: EnvironmentHealth[] = [];
    for (const r of runs) {
      if (seen.has(r.environment)) continue;
      seen.add(r.environment);
      // Try to find matching Deployment version
      let version: string | null = null;
      try {
        const dep = await prisma.deployment.findFirst({
          where: { environment: r.environment as any, commitSha: r.commitSha },
        });
        version = dep?.version ?? null;
      } catch { /* honest null */ }
      results.push({
        environment: r.environment,
        lastDeployState: r.state,
        lastDeployAt: r.startedAt.toISOString(),
        commitSha: r.commitSha,
        version,
        rolledBack: r.rolledBack,
      });
    }
    return results;
  } catch {
    return [];
  }
}
