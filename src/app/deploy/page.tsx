"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import { CheckCircle2, AlertTriangle, Clock, Activity, XCircle } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";
const ENVS = ["DEV", "PROD"] as const;
const STRATEGIES = ["blue_green", "rolling", "recreate"] as const;

interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  message: string;
}
interface Migration {
  file: string;
  kind: string;
  destructive: boolean;
  reversible: boolean;
  reasons: string[];
}
interface Plan {
  env: string;
  commitSha: string;
  shortSha: string;
  service: string | null;
  diffSummary: { files: number; insertions: number; deletions: number } | null;
  lastTest: { found: boolean; total?: number; passed?: number; failed?: number; skipped?: number };
  currentLive: { commitSha: string; version: string | null; deployedAt: string } | null;
  migrations: Migration[];
  estimatedSec: number;
  refuseReasons: string[];
  requiresApproval: boolean;
}
interface DeployRun {
  id: string;
  environment: string;
  commitSha: string;
  service: string | null;
  strategy: string;
  state: string;
  rolledBack: boolean;
  deploymentId: string | null;
  startedAt: string;
  finishedAt: string | null;
  healthStatus: string;
  healthPort: number | null;
}

interface HealthCheck {
  id: string;
  url: string;
  httpStatus: number | null;
  durationMs: number | null;
  ok: boolean;
  checkedAt: string;
  error: string | null;
}

interface HealthData {
  deployRunId: string;
  healthStatus: string;
  summary: { total: number; passed: number; failed: number };
  checks: HealthCheck[];
}

const HEALTH_CFG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  pending:  { label: "Pending",  cls: "text-zinc-400",  icon: <Clock size={11} /> },
  watching: { label: "Watching", cls: "text-amber-400", icon: <Activity size={11} /> },
  healthy:  { label: "Healthy",  cls: "text-emerald-400", icon: <CheckCircle2 size={11} /> },
  degraded: { label: "Degraded", cls: "text-red-400",   icon: <AlertTriangle size={11} /> },
  error:    { label: "Error",    cls: "text-zinc-500",  icon: <XCircle size={11} /> },
};

function HealthBadge({ status, runId }: { status: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const cfg = HEALTH_CFG[status] ?? HEALTH_CFG.pending;
  const { data } = useSWR<HealthData>(
    open ? `/api/deploy/runs/${runId}/health` : null,
    fetcher,
    { refreshInterval: status === "watching" ? 5000 : 0 }
  );

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 text-xs ${cfg.cls} hover:underline`}
        title="View health checks"
      >
        {cfg.icon} {cfg.label}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 50,
            minWidth: "340px",
            background: "var(--bg-card, #1c1c2e)",
            border: "1px solid var(--border, #2a2a3e)",
            borderRadius: "8px",
            padding: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700 }}>Post-deploy checks</span>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #888)", fontSize: "14px" }}>✕</button>
          </div>
          {!data ? (
            <div style={{ fontSize: "11px", color: "var(--text-muted, #888)" }}>Loading…</div>
          ) : data.checks.length === 0 ? (
            <div style={{ fontSize: "11px", color: "var(--text-muted, #888)" }}>No checks recorded yet.</div>
          ) : (
            <>
              <div style={{ fontSize: "11px", color: "var(--text-muted, #888)", marginBottom: "6px" }}>
                {data.summary.passed}/{data.summary.total} passed
              </div>
              <div style={{ maxHeight: "200px", overflowY: "auto" }}>
                {data.checks.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "4px 0",
                      borderBottom: "1px solid var(--border, #2a2a3e)",
                      fontSize: "11px",
                    }}
                  >
                    <span style={{ color: c.ok ? "#34d399" : "#f87171", flexShrink: 0 }}>
                      {c.ok ? "✓" : "✗"}
                    </span>
                    <span style={{ color: c.httpStatus ? "#e2e8f0" : "#888" }}>
                      {c.httpStatus ?? "ERR"}
                    </span>
                    <span style={{ color: "#888" }}>{c.durationMs}ms</span>
                    <span style={{ color: "#888", marginLeft: "auto", flexShrink: 0 }}>
                      {new Date(c.checkedAt).toLocaleTimeString()}
                    </span>
                    {c.error && (
                      <span style={{ color: "#f87171", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "120px" }} title={c.error}>
                        {c.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const { lang } = useUI();
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const isAdmin = (me?.role as Role) === "ADMIN";

  const { data: git } = useSWR<{ configured: boolean; commits: Commit[] }>(
    "/api/git/commits?limit=30",
    fetcher
  );
  const { data: runs, mutate: refreshRuns } = useSWR<DeployRun[]>(
    "/api/deploy/runs",
    fetcher,
    { refreshInterval: 4000 }
  );
  const { data: cfg, mutate: refreshCfg } = useSWR<any>("/api/deploy/config", fetcher);

  const [env, setEnv] = useState<(typeof ENVS)[number]>("DEV");
  const [commit, setCommit] = useState("");
  const [service, setService] = useState("app");
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>("blue_green");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [approveDestructive, setApproveDestructive] = useState(false);
  const [maintenanceWindow, setMaintenanceWindow] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [banner, setBanner] = useState<{ kind: "ok" | "fail"; msg: string } | null>(null);
  const [confirmDeploy, setConfirmDeploy] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const gitConfigured = git ? git.configured !== false : true;

  async function loadPlan() {
    setPlanErr(null);
    setPlan(null);
    const chosen = commit || git?.commits?.[0]?.sha;
    if (!chosen) return;
    const qs = new URLSearchParams({ env, commit: chosen });
    if (service) qs.set("service", service);
    const res = await fetch(`/api/deploy/plan?${qs}`);
    const body = await res.json();
    if (!res.ok) {
      setPlanErr(body.error || "plan failed");
      return;
    }
    setPlan(body);
    setApproveDestructive(false);
    setMaintenanceWindow(false);
    setShowModal(true);
  }

  function streamRun(runId: string) {
    setActiveRunId(runId);
    setLogLines([]);
    setBanner(null);
    esRef.current?.close();
    const es = new EventSource(`/api/deploy/runs/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.logDelta) {
          setLogLines((prev) => [
            ...prev,
            ...d.logDelta.split("\n").filter(Boolean),
          ]);
        }
        if (["SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"].includes(d.state)) {
          es.close();
          refreshRuns();
          if (d.state === "SUCCEEDED")
            setBanner({ kind: "ok", msg: t("dpSucceeded", lang) });
          else setBanner({ kind: "fail", msg: t("dpFailedRolled", lang) });
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => es.close();
  }

  useEffect(() => {
    if (logBoxRef.current)
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logLines]);

  async function doDeploy() {
    if (!plan) return;
    const res = await fetch("/api/deploy/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        env,
        commit: plan.commitSha,
        service: service || null,
        strategy,
        approveDestructive,
        maintenanceWindow,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBanner({
        kind: "fail",
        msg: (body.reasons || [body.error]).join(" • "),
      });
      setShowModal(false);
      return;
    }
    setShowModal(false);
    streamRun(body.deployRunId);
  }

  async function doRollback(id: string) {
    const res = await fetch(`/api/deploy/runs/${id}/rollback`, { method: "POST" });
    const body = await res.json();
    setBanner(
      res.ok
        ? { kind: "ok", msg: `Rolled back → ${body.restoredCommit?.slice(0, 8)}` }
        : { kind: "fail", msg: body.error || "rollback failed" }
    );
    refreshRuns();
  }

  async function doCancel(id: string) {
    const res = await fetch(`/api/deploy/runs/${id}/cancel`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setBanner({ kind: "fail", msg: body.error || "cancel failed" });
    refreshRuns();
  }

  const runningForEnv = (runs || []).find((r) => r.environment === env && r.state === "RUNNING");

  const hasDestructive = !!plan?.migrations.some((m) => m.destructive);
  const canDeploy =
    !!plan &&
    plan.refuseReasons.length === 0 &&
    (!hasDestructive || (approveDestructive && maintenanceWindow));

  return (
    <div>
      <PageHeader title={t("dpTitle", lang)} desc={t("dpDesc", lang)} />

      {!gitConfigured ? (
        <div className="m-6 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-sm text-zinc-500">
          {t("dpGitNotConfigured", lang)}{" "}
          <Link href="/deployments" className="text-emerald-500 underline">
            {t("dpDeploymentsSettings", lang)}
          </Link>
          .
        </div>
      ) : (
        <div className="p-6 space-y-6">
          {banner && (
            <div
              className={`rounded-md px-4 py-3 text-sm ${
                banner.kind === "ok"
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-600/40"
                  : "bg-red-500/15 text-red-400 border border-red-600/40"
              }`}
            >
              {banner.msg}
            </div>
          )}

          {runningForEnv && (
            <div className="rounded-md px-4 py-3 text-sm bg-amber-500/10 text-amber-400 border border-amber-600/40 flex items-center gap-2">
              <span>⚠</span>
              <span>
                A deploy is currently running for {env}. Starting another will be blocked.{" "}
                <button className="underline" onClick={() => streamRun(runningForEnv.id)}>
                  View run {runningForEnv.id.slice(0, 8)}
                </button>
              </span>
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 grid gap-4 md:grid-cols-4">
            <label className="text-sm">
              <span className="block mb-1 text-zinc-500">{t("dpEnvironment", lang)}</span>
              <select
                className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5"
                value={env}
                onChange={(e) => setEnv(e.target.value as any)}
              >
                {ENVS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="block mb-1 text-zinc-500">{t("dpCommit", lang)}</span>
              <select
                className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5"
                value={commit}
                onChange={(e) => setCommit(e.target.value)}
              >
                <option value="">{t("dpDeployLatest", lang)}</option>
                {git?.commits?.map((c) => (
                  <option key={c.sha} value={c.sha}>
                    {c.shortSha} — {c.message.slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-zinc-500">{t("dpService", lang)}</span>
              <select
                className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5"
                value={service}
                onChange={(e) => setService(e.target.value)}
              >
                <option value="app">app — main application</option>
                <option value="nginx">nginx — reverse proxy</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-zinc-500">{t("dpStrategy", lang)}</span>
              <select
                className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as any)}
              >
                {STRATEGIES.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <div className="md:col-span-3 flex items-end">
              <button
                onClick={loadPlan}
                className="bg-indigo-600 hover:bg-indigo-500 text-white rounded px-4 py-2 text-sm"
              >
                {t("dpReview", lang)}
              </button>
            </div>
          </div>
          {planErr && <div className="text-sm text-red-400">{planErr}</div>}

          {activeRunId && (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
              <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">
                {t("dpLiveLog", lang)}
              </div>
              <div
                ref={logBoxRef}
                className="font-mono text-xs p-3 max-h-80 overflow-auto bg-zinc-950 text-zinc-300"
              >
                {logLines.length === 0 ? (
                  <span className="text-zinc-600">{t("loading", lang)}</span>
                ) : (
                  logLines.map((l, i) => <div key={i}>{l}</div>)
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">
              {t("dpHistory", lang)}
            </div>
            {!runs || runs.length === 0 ? (
              <EmptyState msg={t("dpNoneLive", lang)} />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-200 dark:border-zinc-800">
                    <th className="text-start px-4 py-2">{t("dpEnvironment", lang)}</th>
                    <th className="text-start px-4 py-2">{t("dpService", lang)}</th>
                    <th className="text-start px-4 py-2">{t("dpCommit", lang)}</th>
                    <th className="text-start px-4 py-2">{t("dpState", lang)}</th>
                    <th className="text-start px-4 py-2">Health</th>
                    <th className="text-start px-4 py-2">{t("dpStarted", lang)}</th>
                    <th className="text-start px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="px-4 py-2">{r.environment}</td>
                      <td className="px-4 py-2">{r.service ?? "app"}</td>
                      <td className="px-4 py-2 font-mono">
                        {r.commitSha.slice(0, 8)}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={
                            r.state === "SUCCEEDED"
                              ? "text-emerald-400"
                              : r.state === "ROLLED_BACK" || r.state === "FAILED"
                                ? "text-red-400"
                                : "text-amber-400"
                          }
                        >
                          {r.state}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <HealthBadge status={r.healthStatus} runId={r.id} />
                      </td>
                      <td className="px-4 py-2">{fmtDate(r.startedAt, lang)}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-3">
                          <button
                            className="text-emerald-500 hover:underline"
                            onClick={() => streamRun(r.id)}
                          >
                            {t("dpViewLog", lang)}
                          </button>
                          {isAdmin && r.state === "SUCCEEDED" && (
                            <button
                              className="text-red-400 hover:underline"
                              onClick={() => doRollback(r.id)}
                            >
                              {t("dpRollback", lang)}
                            </button>
                          )}
                          {isAdmin && (r.state === "RUNNING" || r.state === "QUEUED") && (
                            <button
                              className="rounded border border-red-600/50 bg-red-500/10 px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/20"
                              onClick={() => doCancel(r.id)}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {cfg && isAdmin && (
            <ConfigEditor cfg={cfg} onSaved={refreshCfg} lang={lang} />
          )}
        </div>
      )}

      {showModal && plan && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 max-w-2xl w-full max-h-[90vh] overflow-auto">
            <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 font-semibold">
              {t("dpConfirmTitle", lang)} — {plan.shortSha} → {plan.env}
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div>
                <div className="text-zinc-500">{t("dpDiffSummary", lang)}</div>
                {plan.diffSummary ? (
                  <div>
                    {plan.diffSummary.files} files, +
                    {plan.diffSummary.insertions} / -{plan.diffSummary.deletions}
                  </div>
                ) : (
                  <div className="text-zinc-500">—</div>
                )}
              </div>
              <div>
                <div className="text-zinc-500">{t("dpLastTest", lang)}</div>
                {plan.lastTest.found ? (
                  <div>
                    {plan.lastTest.passed}/{plan.lastTest.total} passed,{" "}
                    {plan.lastTest.failed} failed
                  </div>
                ) : (
                  <div className="text-amber-400">{t("dpNoTest", lang)}</div>
                )}
              </div>
              <div>
                <div className="text-zinc-500">{t("dpCurrentLive", lang)}</div>
                {plan.currentLive ? (
                  <div className="font-mono">
                    {plan.currentLive.commitSha.slice(0, 8)} (
                    {plan.currentLive.version || "?"})
                  </div>
                ) : (
                  <div className="text-zinc-500">{t("dpNoneLive", lang)}</div>
                )}
              </div>
              <div>
                <div className="text-zinc-500">{t("dpMigrations", lang)}</div>
                {plan.migrations.length === 0 ? (
                  <div className="text-zinc-500">{t("dpNoMigrations", lang)}</div>
                ) : (
                  <ul className="space-y-1">
                    {plan.migrations.map((m) => (
                      <li
                        key={m.file}
                        className={
                          m.destructive ? "text-red-400" : "text-emerald-400"
                        }
                      >
                        [
                        {m.destructive
                          ? t("dpDestructive", lang)
                          : t("dpAdditive", lang)}
                        ] {m.file}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {hasDestructive && (
                <div className="space-y-2 rounded border border-red-600/40 bg-red-500/10 p-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={approveDestructive}
                      onChange={(e) => setApproveDestructive(e.target.checked)}
                    />
                    {t("dpApproveDestructive", lang)}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={maintenanceWindow}
                      onChange={(e) => setMaintenanceWindow(e.target.checked)}
                    />
                    {t("dpMaintenanceWindow", lang)}
                  </label>
                </div>
              )}
              <div>
                <span className="text-zinc-500">{t("dpEstTime", lang)}: </span>
                {plan.estimatedSec}
                {t("dpSeconds", lang)}
              </div>
              {plan.refuseReasons.length > 0 && (
                <div className="rounded border border-red-600/40 bg-red-500/10 p-3 text-red-400">
                  <div className="font-medium">{t("dpRefused", lang)}</div>
                  <ul className="list-disc ms-5">
                    {plan.refuseReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-3">
              <button
                className="px-4 py-2 text-sm border border-zinc-300 dark:border-zinc-700 rounded"
                onClick={() => setShowModal(false)}
              >
                {t("dpCancel", lang)}
              </button>
              <button
                disabled={!canDeploy}
                className="px-4 py-2 text-sm rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => setConfirmDeploy(true)}
              >
                {t("dpDeployNow", lang)}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDeploy}
        title={`Deploy to ${env}?`}
        message={`This will start a ${strategy} deploy to ${env}. Health checks and optional auto-rollback are active. Type the environment name to confirm.`}
        confirmWord={env}
        confirmLabel="Deploy"
        onConfirm={() => { setConfirmDeploy(false); doDeploy(); }}
        onCancel={() => setConfirmDeploy(false)}
      />
    </div>
  );
}

function ConfigEditor({
  cfg,
  onSaved,
  lang,
}: {
  cfg: any;
  onSaved: () => void;
  lang: any;
}) {
  const [form, setForm] = useState(cfg);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(cfg), [cfg]);

  async function save() {
    const res = await fetch("/api/deploy/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        proxyListenPort: Number(form.proxyListenPort),
        healthConsecutive: Number(form.healthConsecutive),
        healthIntervalMs: Number(form.healthIntervalMs),
        drainSec: Number(form.drainSec),
        autoRollback: !!form.autoRollback,
        statefulServices:
          typeof form.statefulServices === "string"
            ? form.statefulServices
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : form.statefulServices,
      }),
    });
    if (res.ok) {
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2000);
    }
  }

  const fld = (k: string, label: string) => (
    <label className="text-sm">
      <span className="block mb-1 text-zinc-500">{label}</span>
      <input
        className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5"
        value={Array.isArray(form[k]) ? form[k].join(", ") : form[k] ?? ""}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">
        {t("dpConfig", lang)}
      </div>
      <div className="p-4 grid gap-4 md:grid-cols-3">
        <label className="text-sm">
          <span className="block mb-1 text-zinc-500">
            {t("dpProxyMode", lang)}
          </span>
          <select
            className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5"
            value={form.proxyMode}
            onChange={(e) => setForm({ ...form, proxyMode: e.target.value })}
          >
            <option value="managed">managed</option>
            <option value="nginx">nginx</option>
            <option value="traefik">traefik</option>
          </select>
        </label>
        {fld("proxyListenPort", t("dpProxyPort", lang))}
        {fld("healthPath", t("dpHealthPath", lang))}
        {fld("healthConsecutive", t("dpHealthConsecutive", lang))}
        {fld("healthIntervalMs", t("dpHealthInterval", lang))}
        {fld("drainSec", t("dpDrainSec", lang))}
        <div className="md:col-span-3">
          {fld("statefulServices", t("dpStateful", lang))}
        </div>
        <div className="md:col-span-3">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--primary)]"
              checked={!!form.autoRollback}
              onChange={(e) => setForm({ ...form, autoRollback: e.target.checked })}
            />
            <span className="text-sm">
              <span className="font-medium text-[var(--text-main)]">{t("dpAutoRollback", lang)}</span>
              <span className="block text-xs text-[var(--text-muted)] mt-0.5">{t("dpAutoRollbackDesc", lang)}</span>
            </span>
          </label>
        </div>
      </div>
      <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
        <button
          onClick={save}
          className="bg-indigo-600 hover:bg-indigo-500 text-white rounded px-4 py-2 text-sm"
        >
          {t("dpSave", lang)}
        </button>
        {saved && (
          <span className="text-emerald-400 text-sm">{t("dpSaved", lang)}</span>
        )}
      </div>
    </div>
  );
}
