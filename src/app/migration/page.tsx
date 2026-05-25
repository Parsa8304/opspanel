"use client";
import { useState } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";
const STRATEGIES = ["snapshot", "replicate", "dump_restore"] as const;

interface Host {
  name: string;
  address: string;
}
interface PlanRow {
  id: string;
  sourceHostName: string;
  targetHostName: string;
  service: string;
  volumes: string[];
  strategy: string;
  status: string;
  expectedDowntime: string | null;
  preflight: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] } | null;
  restorePoint: string | null;
  log: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  planned:     "bg-slate-100 text-slate-700 dark:bg-slate-800/50 dark:text-slate-300",
  preflight:   "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  completed:   "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  committed:   "bg-emerald-200 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200",
  failed:      "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  rolled_back: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
};

export default function Page() {
  const { lang } = useUI();
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canRun = ["ADMIN", "ENGINEER"].includes((me?.role as Role) ?? "READONLY");

  const { data: plans, mutate } = useSWR<PlanRow[]>("/api/migration/plans", fetcher, {
    refreshInterval: 4000,
  });
  const { data: hosts } = useSWR<Host[]>("/api/migration/hosts", fetcher);

  const [form, setForm] = useState({
    sourceHostName: "",
    targetHostName: "",
    service: "",
    volumes: "",
    strategy: "replicate" as (typeof STRATEGIES)[number],
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);

  async function call(url: string, body?: unknown) {
    setBusy(url);
    setNotice(null);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNotice(t("migOk", lang));
      await mutate();
      return j;
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title={t("migTitle", lang)} />

      {notice && (
        <div className="mb-4 rounded border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 px-3 py-2 text-sm">
          {notice}
        </div>
      )}

      {canRun && (
        <div className="mb-6 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
          <h2 className="mb-3 text-sm font-semibold">{t("migNewPlan", lang)}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs">
              {t("migSourceHost", lang)}
              <select
                className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
                value={form.sourceHostName}
                onChange={(e) => setForm({ ...form, sourceHostName: e.target.value })}
              >
                <option value="">—</option>
                {(hosts ?? []).map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name} ({h.address})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              {t("migTargetHost", lang)}
              <select
                className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
                value={form.targetHostName}
                onChange={(e) => setForm({ ...form, targetHostName: e.target.value })}
              >
                <option value="">—</option>
                {(hosts ?? []).map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name} ({h.address})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              {t("migService", lang)}
              <input
                className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
                value={form.service}
                onChange={(e) => setForm({ ...form, service: e.target.value })}
                placeholder="container name"
              />
            </label>
            <label className="text-xs">
              {t("migVolumes", lang)}
              <input
                className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
                value={form.volumes}
                onChange={(e) => setForm({ ...form, volumes: e.target.value })}
                placeholder="vol1, vol2"
              />
            </label>
            <label className="text-xs">
              {t("migStrategy", lang)}
              <select
                className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
                value={form.strategy}
                onChange={(e) =>
                  setForm({ ...form, strategy: e.target.value as (typeof STRATEGIES)[number] })
                }
              >
                {STRATEGIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`migStrat_${s}`, lang)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">{t("migSnapshotWarn", lang)}</p>
          <button
            className="mt-3 rounded bg-[#183661] hover:bg-[#1e478e] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={
              !!busy ||
              !form.sourceHostName ||
              !form.targetHostName ||
              !form.service
            }
            onClick={() =>
              call("/api/migration/plans", {
                ...form,
                volumes: form.volumes
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          >
            {t("migCreatePlan", lang)}
          </button>
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold">{t("migPlans", lang)}</h2>
      {!plans || plans.length === 0 ? (
        <EmptyState msg={t("migNoPlans", lang)} />
      ) : (
        <div className="space-y-3">
          {plans.map((p) => (
            <div key={p.id} className="rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{p.service}</span>
                <span className="text-xs text-slate-500">
                  {p.sourceHostName} → {p.targetHostName}
                </span>
                <span className="rounded bg-slate-100 dark:bg-zinc-800 px-2 py-0.5 text-xs">
                  {t(`migStrat_${p.strategy}`, lang)}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    STATUS_TONE[p.status] ?? "bg-slate-100 text-slate-700"
                  }`}
                >
                  {t(`migStatus_${p.status}`, lang)}
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  {fmtDate(p.createdAt, lang)}
                </span>
              </div>

              {p.volumes.length > 0 && (
                <div className="mt-2 text-xs text-slate-500">
                  {t("migVolumes", lang)}: {p.volumes.join(", ")}
                </div>
              )}

              {p.preflight && (
                <div className="mt-2 space-y-0.5 text-xs">
                  {p.preflight.checks.map((c) => (
                    <div key={c.name} className={c.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}>
                      {c.ok ? "✓" : "✗"} {c.name}: {c.detail}
                    </div>
                  ))}
                </div>
              )}

              {canRun && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {["planned", "failed"].includes(p.status) && (
                    <button
                      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                      disabled={!!busy}
                      onClick={() => call(`/api/migration/plans/${p.id}/preflight`)}
                    >
                      {t("migPreflight", lang)}
                    </button>
                  )}
                  {p.status === "preflight" && (
                    <button
                      className="rounded bg-[#183661] hover:bg-[#1e478e] px-2 py-1 text-xs text-white disabled:opacity-50"
                      disabled={!!busy}
                      onClick={() => call(`/api/migration/plans/${p.id}/run`)}
                    >
                      {t("migRun", lang)}
                    </button>
                  )}
                  {p.status === "completed" && (
                    <>
                      <button
                        className="rounded bg-emerald-700 px-2 py-1 text-xs text-white disabled:opacity-50"
                        disabled={!!busy}
                        onClick={() => call(`/api/migration/plans/${p.id}/commit`)}
                      >
                        {t("migCommit", lang)}
                      </button>
                      <button
                        className="rounded border border-orange-300 dark:border-orange-700 px-2 py-1 text-xs text-orange-700 dark:text-orange-400 disabled:opacity-50"
                        disabled={!!busy}
                        onClick={() => call(`/api/migration/plans/${p.id}/rollback`)}
                      >
                        {t("migRollback", lang)}
                      </button>
                    </>
                  )}
                  {p.log && (
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => setOpenLog(openLog === p.id ? null : p.id)}
                    >
                      {t("migViewLog", lang)}
                    </button>
                  )}
                </div>
              )}

              {openLog === p.id && (
                <pre className="mt-3 max-h-72 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                  {p.log}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
