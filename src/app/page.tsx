"use client";
import Link from "next/link";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, NAV, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Tooltip,
  XAxis,
} from "recharts";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Rocket,
  Boxes,
  ClipboardCheck,
  FlaskConical,
  FileText,
  Plug,
  DollarSign,
  Bell,
  Network,
} from "lucide-react";

interface TimelineEvent {
  id: string;
  type: "deploy" | "deploy-fail" | "job-fail" | "billing-drift";
  title: string;
  detail: string | null;
  at: string;
  severity: "critical" | "warning" | "info";
  link: string;
}

interface EnvironmentHealth {
  environment: string;
  lastDeployState: string | null;
  lastDeployAt: string | null;
  commitSha: string | null;
  version: string | null;
  rolledBack: boolean;
}

interface ScoreComponent {
  key: string;
  label: string;
  score: number | null;
  weight: number;
  available: boolean;
  note: string | null;
  detail: string | null;
}
interface Alert {
  id: string;
  severity: "critical" | "warning" | "info";
  area: string;
  message: string;
  link: string;
}
interface TrendSeries {
  key: string;
  enoughData: boolean;
  points: { day: string; value: number }[];
}
interface DeployGate {
  status: "allowed" | "blocked" | "warning";
  reasons: string[];
}
interface Blocker {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  area: string;
  link: string;
}
interface OverviewData {
  score: number | null;
  band: "green" | "amber" | "red" | "unknown";
  breakdown: ScoreComponent[];
  unavailableComponents: string[];
  partial: boolean;
  gate: DeployGate;
  blockers: Blocker[];
  lastDeployment: { version: string | null; env: string; at: string } | null;
  alerts: Alert[];
  trends: {
    testPassRate: TrendSeries;
    deployFrequency: TrendSeries;
    aiCostUsd: TrendSeries;
  };
  quickStats: {
    qaPassing: number | null;
    qaTotal: number | null;
    containersRunning: number | null;
    containersTotal: number | null;
    containersNote: string | null;
    openAlerts: number;
  };
  phase2: Phase2Signals | null;
  timeline: TimelineEvent[];
  environments: EnvironmentHealth[];
}

interface Phase2Signals {
  billing: {
    available: boolean;
    note: string | null;
    todaySpend: number;
    spend30d: number;
    requests30d: number;
    costSeries: TrendSeries;
    providers: {
      provider: string;
      balance: number | null;
      totalCredits: number | null;
      totalUsage: number | null;
      available: boolean;
      note: string | null;
    }[];
    recon: {
      provider: string;
      forDate: string;
      flagged: boolean;
      driftPct: number;
      driftAbs: number;
      status: string;
    } | null;
  };
  alerts: {
    available: boolean;
    note: string | null;
    open: number;
    bySeverity: { INFO: number; WARN: number; ERROR: number; CRITICAL: number };
    deliveryDelayed: boolean;
    queued: number;
  };
  deploy: {
    available: boolean;
    note: string | null;
    perEnv: {
      environment: string;
      state: string;
      commitSha: string;
      rolledBack: boolean;
      at: string;
    }[];
    running: { id: string; environment: string; state: string } | null;
  };
  migration: {
    available: boolean;
    note: string | null;
    inProgress: number;
    uncommitted: number;
  };
  ports: {
    available: boolean;
    note: string | null;
    hostName: string;
    conflicts: number;
    publicExposed: number;
  };
  discovery: {
    available: boolean;
    note: string | null;
    pending: number;
  };
}

const BAND_COLOR: Record<string, string> = {
  green: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
  unknown: "#71717a",
};

function Section({
  title,
  icon,
  children,
  right,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section
      className="mx-6 my-5 rounded-xl"
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        className="flex items-center justify-between gap-2 px-4 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-main)" }}>
          <span style={{ color: "var(--accent)" }}>{icon}</span>
          {title}
        </div>
        {right && (
          <span className="text-xs transition-colors duration-150" style={{ color: "var(--text-muted)" }}>
            {right}
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Gauge({
  score,
  band,
  lang,
}: {
  score: number | null;
  band: string;
  lang: Lang;
}) {
  const color = BAND_COLOR[band] || BAND_COLOR.unknown;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  const r = 52;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="#263241"
          strokeWidth="10"
        />
        {score != null && (
          <circle
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold" style={{ color }}>
          {score == null ? "—" : score}
        </span>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          {score == null ? t("ovUnavailable", lang) : "/ 100"}
        </span>
      </div>
    </div>
  );
}

function Sparkline({
  series,
  lang,
  kind,
}: {
  series: TrendSeries;
  lang: Lang;
  kind: "line" | "bar";
}) {
  if (!series.enoughData || series.points.length < 2) {
    return (
      <div
        className="flex h-20 items-center justify-center rounded-lg text-center text-xs"
        style={{ border: "1px dashed var(--border)", color: "var(--text-muted)" }}
      >
        {t("ovNotEnoughData", lang)}
      </div>
    );
  }
  return (
    <div className="h-20">
      <ResponsiveContainer width="100%" height="100%">
        {kind === "line" ? (
          <LineChart data={series.points}>
            <XAxis dataKey="day" hide />
            <Tooltip
              labelFormatter={(d) => fmtDate(String(d), lang)}
              contentStyle={{ fontSize: 11 }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        ) : (
          <BarChart data={series.points}>
            <XAxis dataKey="day" hide />
            <Tooltip
              labelFormatter={(d) => fmtDate(String(d), lang)}
              contentStyle={{ fontSize: 11 }}
            />
            <Bar dataKey="value" fill="#10b981" />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

const SEV_STYLE: Record<string, string> = {
  critical: "text-red-600 dark:text-red-300",
  warning:  "text-amber-600 dark:text-amber-300",
  info:     "text-slate-500 dark:text-[#b6bfcc]",
};
const SEV_LEFT: Record<string, string> = {
  critical: "#ef4444",
  warning:  "#f59e0b",
  info:     "#263241",
};
const SEV_BG: Record<string, string> = {
  critical: "rgba(239,68,68,0.08)",
  warning:  "rgba(245,158,11,0.08)",
  info:     "var(--bg-card)",
};

function fmtUsd(n: number): string {
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function navHref(key: string): string {
  return NAV.find((n) => n.key === key)?.href ?? "/";
}

const QUICK_KEYS = ["containers", "qa", "tests", "reports", "integrations"];
const QUICK_ICON: Record<string, React.ReactNode> = {
  containers: <Boxes size={16} />,
  qa: <ClipboardCheck size={16} />,
  tests: <FlaskConical size={16} />,
  reports: <FileText size={16} />,
  integrations: <Plug size={16} />,
};

function DeployGateSection({ gate, lang }: { gate: DeployGate; lang: Lang }) {
  const isBlocked = gate.status === "blocked";
  const isWarning = gate.status === "warning";
  const accentColor = isBlocked ? "#ef4444" : isWarning ? "#f59e0b" : "#10b981";
  const bgColor     = isBlocked ? "rgba(239,68,68,0.07)" : isWarning ? "rgba(245,158,11,0.07)" : "rgba(16,185,129,0.07)";
  const textColor   = isBlocked ? "#fca5a5" : isWarning ? "#fcd34d" : "#6ee7b7";
  const label = isBlocked
    ? t("ovDeployBlocked", lang)
    : isWarning
    ? t("ovDeployWarning", lang)
    : t("ovDeployAllowed", lang);
  const Icon = isBlocked || isWarning ? AlertTriangle : Activity;

  return (
    <div
      className="mx-6 mt-6 rounded-lg px-4 py-3"
      style={{
        background: bgColor,
        border: "1px solid var(--border)",
        borderLeft: `4px solid ${accentColor}`,
      }}
    >
      <div className="flex items-center gap-2 font-semibold text-sm" style={{ color: textColor }}>
        <Icon size={15} />
        {label}
        {gate.reasons.length > 0 && (
          <Link
            href="/alerts"
            className="ml-auto text-xs opacity-60 hover:opacity-100 transition-opacity"
          >
            {t("ovDeployGateReasons", lang)} {gate.reasons.length}
          </Link>
        )}
      </div>
      {gate.reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs opacity-75" style={{ color: textColor }}>
          {gate.reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="flex items-start gap-1">
              <span className="shrink-0">•</span>
              <span>{r}</span>
            </li>
          ))}
          {gate.reasons.length > 3 && (
            <li className="opacity-60">+{gate.reasons.length - 3} more…</li>
          )}
        </ul>
      )}
    </div>
  );
}

function TopBlockersSection({ blockers, lang }: { blockers: Blocker[]; lang: Lang }) {
  return (
    <Section title={`${t("ovTopBlockers", lang)} (${blockers.length})`} icon={<AlertTriangle size={16} />}>
      {blockers.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--success)" }}>{t("ovNoBlockers", lang)}</p>
      ) : (
        <ul className="space-y-2">
          {blockers.map((b) => (
            <li key={b.id}>
              <Link
                href={b.link}
                className={`flex items-start gap-2 rounded-r py-2.5 px-3 text-sm transition-opacity hover:opacity-90 ${SEV_STYLE[b.severity]}`}
                style={{
                  background: SEV_BG[b.severity],
                  borderLeft: `3px solid ${SEV_LEFT[b.severity]}`,
                }}
              >
                <span
                  className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ background: "rgba(0,0,0,0.25)", color: "inherit" }}
                >
                  {b.severity === "critical" ? t("ovSevCritical", lang) : b.severity === "warning" ? t("ovSevWarning", lang) : t("ovSevInfo", lang)}
                </span>
                <span className="flex-1">{b.title}</span>
                <span className="shrink-0 text-[10px] uppercase opacity-40">{b.area}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ─── RecentChangesTimeline ───
const TYPE_LABEL: Record<string, string> = {
  deploy: "Deploy",
  "deploy-fail": "Deploy fail",
  "job-fail": "Job fail",
  "billing-drift": "Billing drift",
};

function RecentChangesTimeline({ events, lang }: { events: TimelineEvent[]; lang: Lang }) {
  return (
    <Section title={t("ovTimeline", lang)} icon={<Activity size={16} />}
      right={
        <Link href="/deployments" className="text-xs transition-colors hover:text-gray-900 dark:hover:text-white" style={{ color: "var(--text-muted)" }}>
          {lang === "fa" ? "مشاهده" : "View all"} →
        </Link>
      }
    >
      {events.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("ovTimelineEmpty", lang)}</p>
      ) : (
        <ol className="relative space-y-4 pl-4" style={{ borderLeft: "1px solid var(--border)" }}>
          {events.map((ev) => {
            const isCrit = ev.severity === "critical";
            const isWarn = ev.severity === "warning";
            const dotCls = isCrit
              ? "bg-red-500"
              : isWarn
              ? "bg-amber-400"
              : "bg-emerald-400";
            return (
              <li key={ev.id} className="relative">
                <span className={`absolute -left-[1.15rem] top-1 h-3 w-3 rounded-full ${dotCls}`} style={{ boxShadow: "0 0 0 2px var(--bg-panel)" }} />
                <Link href={ev.link} className="group flex items-start justify-between gap-2 hover:opacity-80">
                  <div>
                    <span
                      className="text-[10px] font-semibold rounded px-1.5 py-0.5 mr-2 uppercase tracking-wide"
                      style={{ background: "var(--bg-card)", color: "var(--text-muted)" }}
                    >
                      {TYPE_LABEL[ev.type] ?? ev.type}
                    </span>
                    <span className="text-sm" style={{ color: "var(--text-main)" }}>{ev.title}</span>
                    {ev.detail && (
                      <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>{ev.detail}</span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
                    {fmtDate(ev.at, lang)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

// ─── EnvironmentHealthSummary ───
function EnvironmentHealthSummary({ environments, lang }: { environments: EnvironmentHealth[]; lang: Lang }) {
  return (
    <Section title={t("ovEnvHealth", lang)} icon={<Rocket size={16} />}
      right={
        <Link href="/deploy" className="text-xs transition-colors hover:text-gray-900 dark:hover:text-white" style={{ color: "var(--text-muted)" }}>
          {lang === "fa" ? "مشاهده" : "View"} →
        </Link>
      }
    >
      {environments.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("ovEnvHealthEmpty", lang)}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {environments.map((env) => {
            const isOk = env.lastDeployState === "SUCCEEDED" && !env.rolledBack;
            const isFail = env.lastDeployState === "FAILED" || env.lastDeployState === "ROLLED_BACK" || env.rolledBack;
            const isRunning = env.lastDeployState === "RUNNING" || env.lastDeployState === "QUEUED";
            const borderCls = isFail
              ? "border-red-300 dark:border-red-900"
              : isOk
              ? "border-emerald-300 dark:border-emerald-900"
              : isRunning
              ? "border-amber-300 dark:border-amber-900"
              : "border-zinc-200 dark:border-zinc-800";
            const badgeCls = isFail
              ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300"
              : isOk
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
              : isRunning
              ? "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
            const stateLabel = isOk
              ? t("ovEnvStateOk", lang)
              : isFail
              ? env.rolledBack && env.lastDeployState !== "ROLLED_BACK"
                ? t("ovEnvStateRollback", lang)
                : t("ovEnvStateFail", lang)
              : isRunning
              ? t("ovEnvStateRunning", lang)
              : env.lastDeployState ?? "—";

            return (
              <div
                key={env.environment}
                className="rounded-xl p-3 text-sm"
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderLeft: `3px solid ${isFail ? "#ef4444" : isOk ? "#10b981" : isRunning ? "#f59e0b" : "#263241"}`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold" style={{ color: "var(--text-main)" }}>
                    {env.environment}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${badgeCls}`}>
                    {stateLabel}
                  </span>
                </div>
                <div className="mt-1.5 space-y-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {env.version && <p>v{env.version}</p>}
                  {env.commitSha && <p className="font-mono">{env.commitSha.slice(0, 8)}</p>}
                  {env.lastDeployAt && <p>{fmtDate(env.lastDeployAt, lang)}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ─── ServiceDependencyMap ───
function ServiceDependencyMap({ lang }: { lang: Lang }) {
  // Static graph: purely visual, no backend data needed.
  const nodes = [
    { id: "frontend", label: "Frontend", sub: "Next.js", col: 0, row: 0 },
    { id: "backend", label: "API / Server", sub: "Next.js API", col: 1, row: 0 },
    { id: "db", label: "Database", sub: "PostgreSQL", col: 2, row: 0 },
    { id: "cache", label: "Cache", sub: "Redis", col: 2, row: 1 },
    { id: "apis", label: "External APIs", sub: "Integrations", col: 1, row: 1 },
    { id: "workers", label: "Async Workers", sub: "Celery / Queue", col: 1, row: 2 },
  ];

  return (
    <Section title={t("ovServiceMap", lang)} icon={<Network size={16} />}>
      <div className="overflow-x-auto">
        <div className="flex items-start gap-4 min-w-[600px] text-sm">
          {/* Column 0 */}
          <div className="flex flex-col gap-2 pt-4">
            {nodes.filter(n => n.col === 0).map(n => (
              <div
                key={n.id}
                className="rounded-lg px-3 py-2 text-center w-28"
                style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
              >
                <p className="font-semibold text-xs" style={{ color: "var(--text-main)" }}>{n.label}</p>
                <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{n.sub}</p>
              </div>
            ))}
          </div>

          {/* Arrow */}
          <div className="flex items-start pt-6 text-lg font-light select-none" style={{ color: "var(--border)" }}>→</div>

          {/* Column 1 */}
          <div className="flex flex-col gap-2">
            {nodes.filter(n => n.col === 1).map(n => (
              <div
                key={n.id}
                className="rounded-lg px-3 py-2 text-center w-28"
                style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
              >
                <p className="font-semibold text-xs" style={{ color: "var(--text-main)" }}>{n.label}</p>
                <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{n.sub}</p>
              </div>
            ))}
          </div>

          {/* Arrow */}
          <div className="flex items-start pt-6 text-lg font-light select-none" style={{ color: "var(--border)" }}>→</div>

          {/* Column 2 */}
          <div className="flex flex-col gap-2">
            {nodes.filter(n => n.col === 2).map(n => (
              <div
                key={n.id}
                className="rounded-lg px-3 py-2 text-center w-28"
                style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
              >
                <p className="font-semibold text-xs" style={{ color: "var(--text-main)" }}>{n.label}</p>
                <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{n.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

export default function Home() {
  const { lang } = useUI();
  const L = lang as Lang;
  const { data, error } = useSWR<OverviewData>("/api/overview", fetcher, {
    refreshInterval: 15000,
  });

  return (
    <div>
      <PageHeader title={t("ovTitle", L)} desc={t("ovDesc", L)} />

      {error && (
        <div
          className="mx-6 my-6 rounded-lg p-4 text-sm text-red-600 dark:text-red-300"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid var(--border)",
            borderLeft: "4px solid #ef4444",
          }}
        >
          {t("ovUnavailable", L)}
        </div>
      )}

      {!data && !error && (
        <div className="mx-6 my-6 text-sm" style={{ color: "var(--text-muted)" }}>
          {t("loading", L)}
        </div>
      )}

      {data && (
        <>
          {/* Deploy readiness gate */}
          <DeployGateSection gate={data.gate} lang={L} />

          {/* Readiness + quick stats */}
          <Section
            title={t("ovReadiness", L)}
            icon={<Activity size={16} />}
          >
            <div className="flex flex-wrap items-center gap-6">
              <Gauge score={data.score} band={data.band} lang={L} />
              <div className="space-y-2 text-sm">
                {data.score == null && (
                  <p style={{ color: "var(--text-muted)" }}>{t("ovScoreUnknown", L)}</p>
                )}
                {data.partial && (
                  <p className="flex items-center gap-1 text-amber-400">
                    <AlertTriangle size={14} />
                    {t("ovPartial", L)}
                  </p>
                )}
                <div className="flex flex-wrap gap-4" style={{ color: "var(--text-secondary)" }}>
                  <span>
                    <b>{data.quickStats.qaPassing ?? "—"}/{data.quickStats.qaTotal ?? "—"}</b>{" "}
                    {t("ovStatQaPassing", L)}
                  </span>
                  <span>
                    {data.quickStats.containersNote ? (
                      <span className="text-amber-400">
                        {t("ovContainerHealth", L)}: {t("ovUnavailable", L)}
                      </span>
                    ) : (
                      <>
                        <b style={{ color: "var(--text-main)" }}>{data.quickStats.containersRunning ?? "—"}/{data.quickStats.containersTotal ?? "—"}</b>{" "}
                        {t("ovStatRunning", L)}
                      </>
                    )}
                  </span>
                  <span>
                    <b style={{ color: "var(--text-main)" }}>{data.quickStats.openAlerts}</b> {t("ovStatOpenAlerts", L)}
                  </span>
                </div>
              </div>
            </div>

            {/* Breakdown — always visible */}
            <div
              className="mt-4 grid gap-1.5 pt-4 sm:grid-cols-2"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              {data.breakdown.map((c) => (
                <div
                  key={c.key}
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="text-[11px] tabular-nums w-8 shrink-0"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {Math.round(c.weight * 100)}%
                    </span>
                    <span className="truncate text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {t(c.label, L)}
                    </span>
                  </div>
                  {c.available && c.score != null ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="h-1.5 w-16 rounded-full" style={{ background: "var(--border)" }}>
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${c.score}%`,
                            backgroundColor:
                              c.score >= 85 ? "#10b981" : c.score >= 60 ? "#f59e0b" : "#ef4444",
                          }}
                        />
                      </div>
                      <span className="font-semibold tabular-nums w-10 text-right text-[13px]" style={{ color: "var(--text-main)" }}>
                        {c.score}%
                      </span>
                      {c.detail && (
                        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>({c.detail})</span>
                      )}
                    </div>
                  ) : (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ background: "var(--border)", color: "var(--text-muted)" }}
                    >
                      {t("ovExcluded", L)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {data.unavailableComponents && data.unavailableComponents.length > 0 && (
              <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                {lang === "fa"
                  ? "منابع ناموجود از امتیاز حذف می‌شوند."
                  : "Unavailable sources are excluded from the score."}
              </p>
            )}
          </Section>

          {/* Top blockers */}
          <TopBlockersSection blockers={data.blockers} lang={L} />

          {/* Last deployment */}
          <Section
            title={t("ovLastDeployment", L)}
            icon={<Rocket size={16} />}
          >
            {data.lastDeployment ? (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {t("colVersion", L)}:
                  </span>{" "}
                  <b>{data.lastDeployment.version ?? "—"}</b>
                </span>
                <span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {t("colEnvironment", L)}:
                  </span>{" "}
                  <b>{data.lastDeployment.env}</b>
                </span>
                <span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {t("colDeployedAt", L)}:
                  </span>{" "}
                  <b>{fmtDate(data.lastDeployment.at, L)}</b>
                </span>
              </div>
            ) : (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                {t("ovNoDeployment", L)}
              </p>
            )}
          </Section>

          {/* Active alerts */}
          <Section
            title={`${t("ovAlerts", L)} (${data.alerts.length})`}
            icon={<AlertTriangle size={16} />}
          >
            {data.alerts.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--success)" }}>
                {t("ovNoAlerts", L)}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {data.alerts.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={a.link}
                      className={`flex items-start gap-2 rounded-r py-2.5 px-3 text-sm transition-opacity hover:opacity-90 ${SEV_STYLE[a.severity]}`}
                      style={{
                        background: SEV_BG[a.severity],
                        borderLeft: `3px solid ${SEV_LEFT[a.severity]}`,
                      }}
                    >
                      <span
                        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{ background: "rgba(0,0,0,0.25)", color: "inherit" }}
                      >
                        {a.severity === "critical"
                          ? t("ovSevCritical", L)
                          : a.severity === "warning"
                          ? t("ovSevWarning", L)
                          : t("ovSevInfo", L)}
                      </span>
                      <span>{a.message}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Quick links */}
          <Section
            title={t("ovQuickLinks", L)}
            icon={<ChevronRight size={16} />}
          >
            <div className="flex flex-wrap gap-2">
              {QUICK_KEYS.map((k) => {
                const nav = NAV.find((n) => n.key === k);
                if (!nav) return null;
                return (
                  <Link
                    key={k}
                    href={nav.href}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors duration-150 hover:text-gray-900 dark:hover:text-white"
                    style={{
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    <span style={{ color: "var(--accent)" }}>{QUICK_ICON[k]}</span>
                    {lang === "fa" ? nav.fa : nav.en}
                  </Link>
                );
              })}
            </div>
          </Section>

          {/* Trends */}
          <Section title={t("ovTrends", L)} icon={<Activity size={16} />}>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <p className="mb-2 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  {t("ovTrendTestPass", L)}
                </p>
                <Sparkline
                  series={data.trends.testPassRate}
                  lang={L}
                  kind="line"
                />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  {t("ovTrendDeploys", L)}
                </p>
                <Sparkline
                  series={data.trends.deployFrequency}
                  lang={L}
                  kind="bar"
                />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  {t("ovTrendAiCost", L)}
                </p>
                <Sparkline
                  series={data.trends.aiCostUsd}
                  lang={L}
                  kind="line"
                />
              </div>
            </div>
          </Section>

          {/* Recent changes timeline */}
          <RecentChangesTimeline events={data.timeline} lang={L} />

          {/* Environment health */}
          <EnvironmentHealthSummary environments={data.environments} lang={L} />

          {/* Service dependency map */}
          <ServiceDependencyMap lang={L} />

          {data.phase2 && (
            <>
              {/* Cost & Billing */}
              <Section
                title={t("ovP2CostBilling", L)}
                icon={<DollarSign size={16} />}
                right={
                  <Link
                    href={navHref("billing")}
                    className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    {lang === "fa" ? "مشاهده" : "View"} →
                  </Link>
                }
              >
                {!data.phase2.billing.available ? (
                  <p className="text-sm text-zinc-500">
                    {t("ovP2NoBilling", L)}
                  </p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                      <span>
                        <span className="text-zinc-500">
                          {t("ovP2Today", L)}:
                        </span>{" "}
                        <b>{fmtUsd(data.phase2.billing.todaySpend)}</b>
                      </span>
                      <span>
                        <span className="text-zinc-500">
                          {t("ovP2Spend30d", L)}:
                        </span>{" "}
                        <b>{fmtUsd(data.phase2.billing.spend30d)}</b>
                      </span>
                      <span>
                        <span className="text-zinc-500">
                          {t("ovP2ReconDrift", L)}:
                        </span>{" "}
                        {data.phase2.billing.recon == null ? (
                          <span className="text-zinc-500">
                            {t("ovP2NoRecon", L)}
                          </span>
                        ) : data.phase2.billing.recon.flagged ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                            {t("ovP2ReconFlagged", L)} —{" "}
                            {data.phase2.billing.recon.provider}{" "}
                            {data.phase2.billing.recon.driftPct}%
                          </span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {t("ovP2ReconOk", L)}
                          </span>
                        )}
                      </span>
                    </div>

                    <div>
                      <p className="mb-1 text-xs font-medium text-zinc-500">
                        {t("ovP2LiveBalance", L)}
                      </p>
                      {data.phase2.billing.providers.length === 0 ? (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {t("ovP2MgmtKeyMissing", L)}
                        </p>
                      ) : (
                        <ul className="space-y-1 text-sm">
                          {data.phase2.billing.providers.map((p) => (
                            <li
                              key={p.provider}
                              className="flex items-center justify-between gap-3"
                            >
                              <span className="text-zinc-600 dark:text-zinc-300">
                                {p.provider}
                              </span>
                              {p.available && p.balance != null ? (
                                <b>{fmtUsd(p.balance)}</b>
                              ) : (
                                <span className="text-xs text-amber-600 dark:text-amber-400">
                                  {t("ovUnavailable", L)}
                                  {p.note ? ` — ${p.note}` : ""}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <p className="mb-2 text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                        {t("ovP2CostPerDay", L)}
                      </p>
                      <Sparkline
                        series={data.phase2.billing.costSeries}
                        lang={L}
                        kind="bar"
                      />
                    </div>
                  </div>
                )}
              </Section>

              {/* Alerts */}
              <Section
                title={t("ovP2Alerts", L)}
                icon={<Bell size={16} />}
                right={
                  <Link
                    href={navHref("alerts")}
                    className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    {lang === "fa" ? "مشاهده" : "View"} →
                  </Link>
                }
              >
                {!data.phase2.alerts.available ? (
                  <p className="text-sm text-zinc-500">
                    {t("ovUnavailable", L)}
                    {data.phase2.alerts.note
                      ? ` — ${data.phase2.alerts.note}`
                      : ""}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {data.phase2.alerts.deliveryDelayed && (
                      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                        {t("ovP2DeliveryDelayed", L)} —{" "}
                        {data.phase2.alerts.queued} {t("ovP2Queued", L)}
                      </div>
                    )}
                    {data.phase2.alerts.open === 0 ? (
                      <p className="text-sm text-emerald-600 dark:text-emerald-400">
                        {t("ovP2NoOpenAlerts", L)}
                      </p>
                    ) : (
                      <div>
                        <p className="mb-1 text-xs font-medium text-zinc-500">
                          {t("ovP2OpenBySeverity", L)}
                        </p>
                        <div className="flex flex-wrap gap-2 text-sm">
                          {(
                            ["CRITICAL", "ERROR", "WARN", "INFO"] as const
                          ).map((sev) => (
                            <span
                              key={sev}
                              className="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800"
                            >
                              <b>{data.phase2!.alerts.bySeverity[sev]}</b>{" "}
                              <span className="text-xs text-zinc-500">
                                {sev}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Section>

              {/* Deploy & Migration status */}
              <Section
                title={t("ovP2DeployMigration", L)}
                icon={<Rocket size={16} />}
                right={
                  <Link
                    href={navHref("deploy")}
                    className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    {lang === "fa" ? "مشاهده" : "View"} →
                  </Link>
                }
              >
                <div className="space-y-3">
                  {data.phase2.deploy.running && (
                    <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                      {t("ovP2DeployRunning", L)} —{" "}
                      {data.phase2.deploy.running.environment} (
                      {data.phase2.deploy.running.state})
                    </div>
                  )}
                  {!data.phase2.deploy.available ? (
                    <p className="text-sm text-zinc-500">
                      {t("ovUnavailable", L)}
                    </p>
                  ) : data.phase2.deploy.perEnv.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      {t("ovP2NoDeployRuns", L)}
                    </p>
                  ) : (
                    <div>
                      <p className="mb-1 text-xs font-medium text-zinc-500">
                        {t("ovP2LatestPerEnv", L)}
                      </p>
                      <ul className="space-y-1 text-sm">
                        {data.phase2.deploy.perEnv.map((e) => (
                          <li
                            key={e.environment}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="text-zinc-600 dark:text-zinc-300">
                              {e.environment}
                            </span>
                            <span className="flex items-center gap-2">
                              <span
                                className={
                                  e.state === "FAILED" ||
                                  e.state === "ROLLED_BACK" ||
                                  e.rolledBack
                                    ? "text-red-600 dark:text-red-400"
                                    : e.state === "SUCCEEDED"
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : "text-zinc-500"
                                }
                              >
                                {e.state}
                                {e.rolledBack &&
                                e.state !== "ROLLED_BACK"
                                  ? ` (${t("ovP2RolledBack", L)})`
                                  : ""}
                              </span>
                              <span className="text-xs text-zinc-500">
                                {e.commitSha.slice(0, 8)} ·{" "}
                                {fmtDate(e.at, L)}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
                    {!data.phase2.migration.available ? (
                      <span className="text-zinc-500">
                        {t("ovUnavailable", L)}
                      </span>
                    ) : data.phase2.migration.inProgress === 0 &&
                      data.phase2.migration.uncommitted === 0 ? (
                      <Link
                        href={navHref("migration")}
                        className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                      >
                        {t("ovP2NoMigration", L)}
                      </Link>
                    ) : (
                      <>
                        <Link
                          href={navHref("migration")}
                          className="hover:underline"
                        >
                          <span className="text-zinc-500">
                            {t("ovP2MigInProgress", L)}:
                          </span>{" "}
                          <b>{data.phase2.migration.inProgress}</b>
                        </Link>
                        <Link
                          href={navHref("migration")}
                          className="hover:underline"
                        >
                          <span className="text-zinc-500">
                            {t("ovP2MigUncommitted", L)}:
                          </span>{" "}
                          <b
                            className={
                              data.phase2.migration.uncommitted > 0
                                ? "text-amber-600 dark:text-amber-400"
                                : ""
                            }
                          >
                            {data.phase2.migration.uncommitted}
                          </b>
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              </Section>

              {/* Infrastructure */}
              <Section
                title={t("ovP2Infra", L)}
                icon={<Network size={16} />}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Link
                    href={navHref("ports")}
                    className="rounded border border-zinc-200 p-3 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
                  >
                    <p className="text-xs text-zinc-500">
                      {t("ovP2PortConflicts", L)}
                    </p>
                    {!data.phase2.ports.available ? (
                      <p className="text-zinc-500">
                        {t("ovUnavailable", L)}
                      </p>
                    ) : (
                      <p
                        className={`text-lg font-bold ${
                          data.phase2.ports.conflicts > 0
                            ? "text-amber-600 dark:text-amber-400"
                            : ""
                        }`}
                      >
                        {data.phase2.ports.conflicts}
                      </p>
                    )}
                  </Link>
                  <Link
                    href={navHref("ports")}
                    className="rounded border border-zinc-200 p-3 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
                  >
                    <p className="text-xs text-zinc-500">
                      {t("ovP2PublicExposed", L)}
                    </p>
                    {!data.phase2.ports.available ? (
                      <p className="text-zinc-500">
                        {t("ovUnavailable", L)}
                      </p>
                    ) : (
                      <p className="text-lg font-bold">
                        {data.phase2.ports.publicExposed}
                      </p>
                    )}
                  </Link>
                  <Link
                    href={navHref("discovery")}
                    className="rounded border border-zinc-200 p-3 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
                  >
                    <p className="text-xs text-zinc-500">
                      {t("ovP2PendingProposals", L)}
                    </p>
                    {!data.phase2.discovery.available ? (
                      <p className="text-zinc-500">
                        {t("ovUnavailable", L)}
                      </p>
                    ) : (
                      <p
                        className={`text-lg font-bold ${
                          data.phase2.discovery.pending > 0
                            ? "text-amber-600 dark:text-amber-400"
                            : ""
                        }`}
                      >
                        {data.phase2.discovery.pending}
                      </p>
                    )}
                  </Link>
                </div>
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}
