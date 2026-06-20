"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  GitBranch,
  GitCommit,
  RotateCcw,
  Rocket,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
  GitCompareArrows,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";

const ENVS = ["DEV", "PROD"] as const;
const PROVIDERS = ["local", "github", "gitlab", "gitea"] as const;

type Lang = "en" | "fa";

async function api(url: string, method: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = "Request failed";
    try {
      msg = (await r.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

type CiSummary = {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  ciUrl: string | null;
  finishedAt: string | null;
  status: "passing" | "failing" | "unknown";
};
type QaSummary = {
  passing: number;
  failing: number;
  stale: number;
  environments: string[];
};
type Commit = {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  changedFiles: string[];
  branches: string[];
  issueRefs: string[];
  ci: CiSummary | null;
  qa: QaSummary | null;
};
type MatrixRow = {
  environment: string;
  deployed: boolean;
  version: string | null;
  shortSha: string | null;
  deployedBy: string | null;
  deployedAt: string | null;
  status: "active" | "rolled-back" | "empty";
  durationMs: number | null;
  logUrl: string | null;
};
type Deployment = {
  id: string;
  environment: string;
  commitSha: string;
  version: string | null;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  logUrl?: string | null;
  rollbackOfId?: string | null;
  deployedAt: string;
};
type Release = {
  id: string;
  version: string;
  commitSha: string;
  changelog: string | null;
  date: string;
  deployedBy: { name: string } | null;
};
type CompareResult = {
  from: { environment: string; commitSha: string; version: string | null };
  to: { environment: string; commitSha: string | null; version: string | null };
  sameCommit: boolean;
  commits: Array<{
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    message: string;
  }>;
  files?: Array<{ status: string; file: string }>;
  summary?: { files: number; insertions: number; deletions: number };
  services?: string[];
  risk?: "low" | "medium" | "high" | "none" | "unknown";
  sensitiveFiles?: boolean;
  note?: string;
};

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-6 my-6 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function formatDuration(ms?: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function CiBadge({ ci, L }: { ci: CiSummary | null; L: Lang }) {
  if (!ci)
    return (
      <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] text-zinc-500">
        {t("ciUnknown", L)}
      </span>
    );
  const tone =
    ci.status === "passing"
      ? "bg-emerald-600/15 text-emerald-500"
      : ci.status === "failing"
      ? "bg-red-600/15 text-red-500"
      : "bg-zinc-500/15 text-zinc-500";
  const label =
    ci.status === "passing"
      ? `${t("ciResult", L)}: ${ci.passed}/${ci.total}`
      : ci.status === "failing"
      ? `${t("ciResult", L)}: ${ci.failed} ${t("ciFailing", L)}`
      : t("ciUnknown", L);
  const inner = (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{label}</span>
  );
  return ci.ciUrl ? (
    <a href={ci.ciUrl} target="_blank" rel="noreferrer" className="hover:underline">
      {inner}
    </a>
  ) : (
    inner
  );
}

function QaBadge({ qa, L }: { qa: QaSummary | null; L: Lang }) {
  if (!qa) return null;
  const failing = qa.failing > 0;
  const stale = qa.failing === 0 && qa.stale > 0;
  const tone = failing
    ? "bg-red-600/15 text-red-500"
    : stale
    ? "bg-amber-600/15 text-amber-500"
    : "bg-emerald-600/15 text-emerald-500";
  const label = failing
    ? `${t("qaFailing", L)}: ${qa.failing}`
    : stale
    ? `${t("qaStale", L)}: ${qa.stale}`
    : `${t("qaPassing", L)}: ${qa.passing}`;
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{label}</span>;
}

function RiskBadge({ risk, L }: { risk?: string; L: Lang }) {
  const tone =
    risk === "high"
      ? "bg-red-600/15 text-red-500"
      : risk === "medium"
      ? "bg-amber-600/15 text-amber-500"
      : risk === "low"
      ? "bg-emerald-600/15 text-emerald-500"
      : "bg-zinc-500/15 text-zinc-500";
  const label =
    risk === "high"
      ? t("riskHigh", L)
      : risk === "medium"
      ? t("riskMedium", L)
      : risk === "low"
      ? t("riskLow", L)
      : risk === "none"
      ? t("riskNone", L)
      : t("riskUnknown", L);
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function StatusPill({ status, L }: { status: MatrixRow["status"]; L: Lang }) {
  if (status === "rolled-back")
    return (
      <span className="rounded bg-amber-600/15 px-2 py-0.5 text-xs text-amber-500">
        {t("envStatusRolledBack", L)}
      </span>
    );
  if (status === "empty")
    return (
      <span className="rounded bg-zinc-500/15 px-2 py-0.5 text-xs text-zinc-500">
        {t("envStatusEmpty", L)}
      </span>
    );
  return (
    <span className="rounded bg-emerald-600/15 px-2 py-0.5 text-xs text-emerald-500">
      {t("envStatusActive", L)}
    </span>
  );
}

export default function Page() {
  const { lang } = useUI();
  const L = lang as Lang;

  const { data: cfg, mutate: mutCfg } = useSWR("/api/git/config", fetcher);
  const { data: commitsRes, mutate: mutCommits } = useSWR(
    "/api/git/commits?limit=30",
    fetcher
  );
  const { data: matrix, mutate: mutMatrix } = useSWR<MatrixRow[]>(
    "/api/deployments/matrix",
    fetcher
  );
  const { data: deployments, mutate: mutDeps } = useSWR<Deployment[]>(
    "/api/deployments",
    fetcher
  );
  const { data: releases, mutate: mutReleases } = useSWR<Release[]>(
    "/api/releases",
    fetcher
  );
  const { data: tagsRes } = useSWR("/api/git/tags", fetcher);
  const tagList: { name: string }[] = tagsRes?.tags || [];

  const [form, setForm] = useState<any>(null);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diffA, setDiffA] = useState("");
  const [diffB, setDiffB] = useState("");
  const [diff, setDiff] = useState<any>(null);
  const [rel, setRel] = useState({ version: "", commitSha: "", changelog: "" });

  // Release comparison state
  const [cmpFrom, setCmpFrom] = useState<string>("DEV");
  const [cmpTo, setCmpTo] = useState<string>("PROD");
  const [cmp, setCmp] = useState<CompareResult | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);

  const configured = commitsRes?.configured !== false;
  const commits: Commit[] = commitsRes?.commits || [];
  const cfgForm = form ?? cfg ?? { provider: "local" };

  const deploymentsByEnv = useMemo(() => {
    const out: Record<string, Deployment[]> = {};
    for (const d of deployments || []) {
      (out[d.environment] = out[d.environment] || []).push(d);
    }
    return out;
  }, [deployments]);

  const saveConfig = async () => {
    setErr("");
    try {
      await api("/api/git/config", "PUT", {
        provider: cfgForm.provider || "local",
        repoPath: cfgForm.repoPath || null,
        repoUrl: cfgForm.repoUrl || null,
        branch: cfgForm.branch || null,
        token: cfgForm.token || null,
      });
      setForm(null);
      mutCfg();
      mutCommits();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const deployCommit = async (sha: string, env: string) => {
    setErr("");
    try {
      await api("/api/deployments", "POST", { environment: env, commitSha: sha });
      mutMatrix();
      mutDeps();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const rollback = async (id: string) => {
    if (!confirm(t("rollbackConfirm", L))) return;
    setErr("");
    try {
      await api(`/api/deployments/${id}/rollback`, "POST");
      mutMatrix();
      mutDeps();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const computeDiff = async () => {
    setErr("");
    setDiff(null);
    try {
      const r = await fetcher(
        `/api/git/diff?a=${encodeURIComponent(diffA)}&b=${encodeURIComponent(diffB)}`
      );
      setDiff(r.diff);
    } catch (e: any) {
      setErr(e.info?.error || e.message);
    }
  };

  const runCompare = async () => {
    setErr("");
    setCmp(null);
    setCmpLoading(true);
    try {
      const r = await fetcher(
        `/api/deployments/compare?from=${cmpFrom}&to=${cmpTo}`
      );
      setCmp(r);
    } catch (e: any) {
      setErr(e.info?.error || e.message);
    } finally {
      setCmpLoading(false);
    }
  };

  const createRelease = async () => {
    setErr("");
    try {
      await api("/api/releases", "POST", {
        version: rel.version,
        commitSha: rel.commitSha,
        changelog: rel.changelog || null,
      });
      setRel({ version: "", commitSha: "", changelog: "" });
      mutReleases();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const envsForCommit = (sha: string) =>
    (deployments || [])
      .filter((d) => d.status === "active" && d.commitSha === sha)
      .map((d) => d.environment);

  return (
    <div className="pb-10">
      <PageHeader
        title={t("deployTracking", L)}
        desc={t("deployTrackingDesc", L)}
      />

      {err && (
        <div className="mx-6 mt-4 rounded border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-500">
          {err}
        </div>
      )}

      {/* Git config */}
      <Section
        title={t("gitConfig", L)}
        icon={<SettingsIcon size={16} className="text-emerald-500" />}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("provider", L)}</span>
            <select
              value={cfgForm.provider || "local"}
              onChange={(e) =>
                setForm({ ...cfgForm, provider: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p} className="dark:bg-zinc-900">
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("repoPath", L)}</span>
            <input
              value={cfgForm.repoPath || ""}
              onChange={(e) =>
                setForm({ ...cfgForm, repoPath: e.target.value })
              }
              placeholder="/opt/app"
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("repoUrl", L)}</span>
            <input
              value={cfgForm.repoUrl || ""}
              onChange={(e) =>
                setForm({ ...cfgForm, repoUrl: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("branch", L)}</span>
            <input
              value={cfgForm.branch || ""}
              onChange={(e) => setForm({ ...cfgForm, branch: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("token", L)}</span>
            <input
              value={cfgForm.token || ""}
              onChange={(e) => setForm({ ...cfgForm, token: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={saveConfig}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
          >
            {t("saveConfig", L)}
          </button>
          <Link
            href="/settings"
            className="text-sm text-emerald-500 hover:underline"
          >
            {t("goToSettings", L)}
          </Link>
        </div>
      </Section>

      {/* Environment matrix — adds Status column */}
      <Section
        title={t("envMatrix", L)}
        icon={<Rocket size={16} className="text-emerald-500" />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-start text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="py-2 text-start">{t("colEnvironment", L)}</th>
                <th className="py-2 text-start">{t("colVersion", L)}</th>
                <th className="py-2 text-start">{t("colCommit", L)}</th>
                <th className="py-2 text-start">{t("colDeployedBy", L)}</th>
                <th className="py-2 text-start">{t("colDeployedAt", L)}</th>
                <th className="py-2 text-start">{t("colStatus", L)}</th>
              </tr>
            </thead>
            <tbody>
              {(matrix || ENVS.map((e) => ({ environment: e, status: "empty" }) as any)).map(
                (row: MatrixRow) => (
                  <tr
                    key={row.environment}
                    className="border-b border-zinc-100 dark:border-zinc-800/60"
                  >
                    <td className="py-2 font-medium">{row.environment}</td>
                    <td className="py-2">
                      {row.deployed ? (
                        row.version || "—"
                      ) : (
                        <span className="text-zinc-500">
                          {t("notDeployed", L)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {row.shortSha || "—"}
                    </td>
                    <td className="py-2">{row.deployedBy || "—"}</td>
                    <td className="py-2">
                      {row.deployedAt ? fmtDate(row.deployedAt, L) : "—"}
                    </td>
                    <td className="py-2">
                      <StatusPill status={row.status} L={L} />
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Release comparison */}
      <Section
        title={t("releaseComparison", L)}
        icon={<GitCompareArrows size={16} className="text-emerald-500" />}
      >
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("compareFrom", L)}</span>
            <select
              value={cmpFrom}
              onChange={(e) => setCmpFrom(e.target.value)}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              {ENVS.map((e) => (
                <option key={e} value={e} className="dark:bg-zinc-900">
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("compareTo", L)}</span>
            <select
              value={cmpTo}
              onChange={(e) => setCmpTo(e.target.value)}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              {ENVS.map((e) => (
                <option key={e} value={e} className="dark:bg-zinc-900">
                  {e}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={runCompare}
            disabled={cmpFrom === cmpTo || cmpLoading}
            className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {cmpLoading ? t("loading", L) : t("compareRun", L)}
          </button>
        </div>

        {cmp && (
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-500">{cmp.from.environment}</span>
              <span className="font-mono text-xs text-emerald-500">
                {cmp.from.commitSha?.slice(0, 8)}
              </span>
              <span className="text-zinc-500">→ {cmp.to.environment}</span>
              <span className="font-mono text-xs text-emerald-500">
                {cmp.to.commitSha?.slice(0, 8) || "—"}
              </span>
              <span className="ms-auto flex items-center gap-2">
                <span className="text-zinc-500">{t("compareRisk", L)}:</span>
                <RiskBadge risk={cmp.risk} L={L} />
              </span>
            </div>
            {cmp.note && (
              <p className="text-zinc-500">{cmp.note}</p>
            )}
            {cmp.sameCommit && (
              <p className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-500">
                {t("compareSame", L)}
              </p>
            )}
            {cmp.sensitiveFiles && (
              <p className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-500">
                <AlertTriangle size={14} />
                {t("sensitiveTouched", L)}
              </p>
            )}
            {cmp.summary && (
              <p className="text-zinc-500">
                {cmp.summary.files} {t("changedFiles", L)} ·{" "}
                {cmp.summary.insertions} {t("insertions", L)} ·{" "}
                {cmp.summary.deletions} {t("deletions", L)}
              </p>
            )}
            {!!cmp.services?.length && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">{t("compareServices", L)}:</span>
                {cmp.services.map((s) => (
                  <span
                    key={s}
                    className="rounded bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
            {!!cmp.commits.length && (
              <div>
                <p className="mb-1 text-zinc-500">
                  {t("compareCommits", L)} ({cmp.commits.length})
                </p>
                <ul className="space-y-1">
                  {cmp.commits.slice(0, 50).map((c) => (
                    <li
                      key={c.sha}
                      className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1 text-xs"
                    >
                      <span className="font-mono text-emerald-500">
                        {c.shortSha}
                      </span>
                      <span>{c.message}</span>
                      <span className="text-zinc-500">· {c.author}</span>
                      <span className="text-zinc-500">
                        · {fmtDate(c.date, L)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Commit timeline with branch, issue/MR, CI, QA */}
      <Section
        title={t("commitHistory", L)}
        icon={<GitCommit size={16} className="text-emerald-500" />}
      >
        {!configured ? (
          <div className="rounded border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            {t("gitNotConfigured", L)}{" "}
            <Link href="/settings" className="text-emerald-500 hover:underline">
              {t("goToSettings", L)}
            </Link>
          </div>
        ) : commits.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noCommits", L)}</p>
        ) : (
          <ul className="space-y-2">
            {commits.map((c) => {
              const onEnvs = envsForCommit(c.sha);
              const open = expanded[c.sha];
              return (
                <li
                  key={c.sha}
                  className="rounded border border-zinc-200 dark:border-zinc-800 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-emerald-500">
                      {c.shortSha}
                    </span>
                    <span className="font-medium">{c.message}</span>
                    <span className="text-zinc-500">· {c.author}</span>
                    <span className="text-zinc-500">
                      · {fmtDate(c.date, L)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {c.branches.slice(0, 3).map((b) => (
                      <span
                        key={b}
                        className="rounded bg-sky-600/15 px-1.5 py-0.5 text-[10px] text-sky-500"
                      >
                        <GitBranch size={9} className="me-0.5 inline" />
                        {b}
                      </span>
                    ))}
                    {c.issueRefs.map((iss) => (
                      <span
                        key={iss}
                        className="rounded bg-violet-600/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-400"
                      >
                        {iss}
                      </span>
                    ))}
                    <CiBadge ci={c.ci} L={L} />
                    <QaBadge qa={c.qa} L={L} />
                    {onEnvs.map((e) => (
                      <span
                        key={e}
                        className="rounded bg-emerald-600/15 px-1.5 py-0.5 text-[10px] text-emerald-500"
                      >
                        {t("onEnvs", L)} {e}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() =>
                        setExpanded((s) => ({ ...s, [c.sha]: !s[c.sha] }))
                      }
                      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      {open ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      {c.changedFiles.length} {t("changedFiles", L)}
                    </button>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value)
                          deployCommit(c.sha, e.target.value);
                        e.target.value = "";
                      }}
                      className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-0.5 text-xs"
                    >
                      <option value="" className="dark:bg-zinc-900">
                        {t("deployToEnv", L)}
                      </option>
                      {ENVS.map((e) => (
                        <option
                          key={e}
                          value={e}
                          className="dark:bg-zinc-900"
                        >
                          {e}
                        </option>
                      ))}
                    </select>
                  </div>
                  {open && c.changedFiles.length > 0 && (
                    <ul className="mt-2 space-y-0.5 font-mono text-xs text-zinc-500">
                      {c.changedFiles.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Release log */}
      <Section
        title={t("releaseLog", L)}
        icon={<GitBranch size={16} className="text-emerald-500" />}
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <input
            placeholder={t("colVersion", L)}
            value={rel.version}
            onChange={(e) => setRel({ ...rel, version: e.target.value })}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <input
            placeholder={t("colCommit", L)}
            value={rel.commitSha}
            onChange={(e) => setRel({ ...rel, commitSha: e.target.value })}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
          />
          <input
            placeholder={t("colChangelog", L)}
            value={rel.changelog}
            onChange={(e) => setRel({ ...rel, changelog: e.target.value })}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <button
            onClick={createRelease}
            className="rounded bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-500"
          >
            {t("create", L)}
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          {t("autoChangelogHint", L)}
        </p>
        {!releases || releases.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noReleases", L)}</p>
        ) : (
          <ul className="space-y-2">
            {releases.map((r) => {
              const open = expanded["rel-" + r.id];
              return (
                <li
                  key={r.id}
                  className="rounded border border-zinc-200 dark:border-zinc-800 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.version}</span>
                    <span className="font-mono text-xs text-emerald-500">
                      {r.commitSha.slice(0, 8)}
                    </span>
                    <span className="text-zinc-500">
                      {fmtDate(r.date, L)}
                    </span>
                    <span className="text-zinc-500">
                      {r.deployedBy?.name || "—"}
                    </span>
                  </div>
                  {r.changelog && (
                    <button
                      onClick={() =>
                        setExpanded((s) => ({
                          ...s,
                          ["rel-" + r.id]: !s["rel-" + r.id],
                        }))
                      }
                      className="mt-2 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      {open ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      {t("colChangelog", L)}
                    </button>
                  )}
                  {open && r.changelog && (
                    <pre className="mt-2 whitespace-pre-wrap rounded bg-zinc-100 dark:bg-zinc-800/60 p-2 text-xs">
                      {r.changelog}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Diff view */}
      <Section
        title={t("diffView", L)}
        icon={<GitCommit size={16} className="text-emerald-500" />}
      >
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("refA", L)}</span>
            <input
              value={diffA}
              onChange={(e) => setDiffA(e.target.value)}
              placeholder="sha / tag"
              list="git-refs"
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("refB", L)}</span>
            <input
              value={diffB}
              onChange={(e) => setDiffB(e.target.value)}
              placeholder="sha / tag"
              list="git-refs"
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
            />
            <datalist id="git-refs">
              {tagList.map((tg) => (
                <option key={tg.name} value={tg.name} />
              ))}
              {commits.map((c) => (
                <option key={c.sha} value={c.shortSha} />
              ))}
            </datalist>
          </label>
          <button
            onClick={computeDiff}
            disabled={!diffA || !diffB}
            className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {t("computeDiff", L)}
          </button>
        </div>
        {diff && (
          <div className="mt-4 text-sm">
            <p className="text-zinc-500">
              {diff.summary.files} {t("changedFiles", L)} ·{" "}
              {diff.summary.insertions} {t("insertions", L)} ·{" "}
              {diff.summary.deletions} {t("deletions", L)}
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              {diff.files.map((f: any) => (
                <li key={f.file}>
                  <span className="me-2 text-emerald-500">{f.status}</span>
                  {f.file}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Deployment history with duration, log link, rollback target select */}
      <Section
        title="Deployments"
        icon={<RotateCcw size={16} className="text-emerald-500" />}
      >
        {!deployments || deployments.length === 0 ? (
          <EmptyState msg={t("notDeployed", L)} />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="py-2 text-start">{t("colEnvironment", L)}</th>
                <th className="py-2 text-start">{t("colCommit", L)}</th>
                <th className="py-2 text-start">{t("colVersion", L)}</th>
                <th className="py-2 text-start">{t("colState", L)}</th>
                <th className="py-2 text-start">{t("colStarted", L)}</th>
                <th className="py-2 text-start">{t("colDuration", L)}</th>
                <th className="py-2 text-start">{t("colLog", L)}</th>
                <th className="py-2 text-end">{t("rollbackTarget", L)}</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => {
                const targets = (deploymentsByEnv[d.environment] || []).filter(
                  (x) => x.id !== d.id && x.status !== "active"
                );
                return (
                  <tr
                    key={d.id}
                    className="border-b border-zinc-100 dark:border-zinc-800/60"
                  >
                    <td className="py-2">{d.environment}</td>
                    <td className="py-2 font-mono text-xs">
                      {d.commitSha.slice(0, 8)}
                    </td>
                    <td className="py-2">{d.version || "—"}</td>
                    <td className="py-2">
                      <span
                        className={
                          d.status === "active"
                            ? "rounded bg-emerald-600/15 px-1.5 py-0.5 text-[10px] text-emerald-500"
                            : "rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] text-zinc-500"
                        }
                      >
                        {d.status}
                        {d.rollbackOfId ? " (rollback)" : ""}
                      </span>
                    </td>
                    <td className="py-2 text-xs">
                      {d.startedAt
                        ? fmtDate(d.startedAt, L)
                        : fmtDate(d.deployedAt, L)}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {formatDuration(d.durationMs)}
                    </td>
                    <td className="py-2">
                      {d.logUrl ? (
                        <a
                          href={d.logUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-xs text-emerald-500 hover:underline"
                        >
                          <ExternalLink size={12} />
                          {t("logLink", L)}
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-500">—</span>
                      )}
                    </td>
                    <td className="py-2 text-end">
                      {d.status === "active" ? (
                        targets.length > 0 ? (
                          <select
                            defaultValue=""
                            onChange={(e) => {
                              if (e.target.value) rollback(e.target.value);
                              e.target.value = "";
                            }}
                            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-0.5 text-xs"
                          >
                            <option value="" className="dark:bg-zinc-900">
                              {t("rollbackHere", L)}…
                            </option>
                            {targets.slice(0, 20).map((tgt) => (
                              <option
                                key={tgt.id}
                                value={tgt.id}
                                className="dark:bg-zinc-900"
                              >
                                {tgt.commitSha.slice(0, 8)}{" "}
                                {tgt.version ? `(${tgt.version})` : ""} ·{" "}
                                {fmtDate(tgt.deployedAt, L)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-zinc-500">—</span>
                        )
                      ) : (
                        <button
                          onClick={() => rollback(d.id)}
                          className="inline-flex items-center gap-1 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <RotateCcw size={12} />
                          {t("rollbackHere", L)}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
