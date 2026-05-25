"use client";
import { useMemo, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  AlertTriangle,
  Image as ImageIcon,
  Video,
  FileText,
  Link2,
  Check,
  X,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

const MODULES = [
  "LOGIN","PROJECT_MANAGEMENT","QUICK_REPORT","DECISION_ENGINE","GTM_STRATEGY",
  "PITCH_DECK","PITCH_TO_VC","FIND_EXPERTS","AI_RESEARCH_ASSISTANT","ASYNC_PROCESSING",
  "WEBSOCKET","STORAGE","SEARCH","EXTERNAL_INTEGRATIONS","AI_INTEGRATIONS",
  "ACCESS_CONTROL","DEPLOYMENT","OVERALL_READINESS",
];
const ENVS = ["DEV", "STAGING", "DEMO", "OPERATIONAL", "PROD"];
const EV_TYPES = ["SCREENSHOT", "VIDEO", "TEST_OUTPUT", "LOG_LINK"];
const COV_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "DONE"];

type Evidence = { id: string; type: string; url: string; label: string | null };
type RegItem = {
  id: string;
  module: string;
  title: string;
  testSteps: string | null;
  environment: string;
  status: string;
  effectiveStatus: "PASSING" | "FAILING" | "STALE";
  isStale: boolean;
  lastVerifiedAt: string | null;
  staleAfterDays: number;
  verifiedBy: { id: string; name: string } | null;
  evidence: Evidence[];
};
type CovItem = {
  id: string;
  title: string;
  area: string;
  owner: string | null;
  status: string;
  deadline: string | null;
  notes: string | null;
  blockers: string | null;
};

function humanize(m: string) {
  return m
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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

function StatusPill({ s, lang }: { s: string; lang: Lang }) {
  const map: Record<string, [string, string]> = {
    PASSING: ["bg-emerald-600/20 text-emerald-400 border-emerald-700/40", "stPassing"],
    FAILING: ["bg-red-600/20 text-red-400 border-red-700/40", "stFailing"],
    STALE: ["bg-amber-500/20 text-amber-300 border-amber-500/50 font-semibold", "stStale"],
  };
  const [cls, key] = map[s] || map.STALE;
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${cls}`}>
      {s === "STALE" && <AlertTriangle size={12} />}
      {t(key, lang)}
    </span>
  );
}

function EvIcon({ type }: { type: string }) {
  const p = { size: 13, className: "shrink-0" };
  if (type === "SCREENSHOT") return <ImageIcon {...p} />;
  if (type === "VIDEO") return <Video {...p} />;
  if (type === "TEST_OUTPUT") return <FileText {...p} />;
  return <Link2 {...p} />;
}

const inputCls =
  "rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm";
const btnCls =
  "inline-flex items-center gap-1 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40";

export default function Page() {
  const { lang } = useUI();
  const [tab, setTab] = useState<"reg" | "cov">("reg");
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canEdit =
    me && (me.role === "ENGINEER" || me.role === "ADMIN");

  return (
    <div>
      <PageHeader title={t("qaTracking", lang)} desc={t("qaTrackingDesc", lang)} />
      <div className="px-6 pt-4 flex gap-2">
        {(["reg", "cov"] as const).map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`rounded px-3 py-1.5 text-sm border ${
              tab === tb
                ? "bg-[#183661] text-white border-[#183661]"
                : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            {t(tb === "reg" ? "tabRegression" : "tabCoverage", lang)}
          </button>
        ))}
      </div>
      {tab === "reg" ? (
        <Regression lang={lang} canEdit={!!canEdit} />
      ) : (
        <Coverage lang={lang} canEdit={!!canEdit} />
      )}
    </div>
  );
}

/* ───────────────────────── Regression ───────────────────────── */

function Regression({ lang, canEdit }: { lang: Lang; canEdit: boolean }) {
  const { data, error, isLoading } = useSWR<RegItem[]>(
    "/api/qa/regression",
    fetcher
  );
  const [fStatus, setFStatus] = useState("");
  const [fModule, setFModule] = useState("");
  const [fEnv, setFEnv] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = () => globalMutate("/api/qa/regression");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter(
      (i) =>
        (!fStatus || i.effectiveStatus === fStatus) &&
        (!fModule || i.module === fModule) &&
        (!fEnv || i.environment === fEnv)
    );
  }, [data, fStatus, fModule, fEnv]);

  const staleCount = data?.filter((i) => i.isStale).length ?? 0;

  if (isLoading) return <EmptyState msg={t("loading", lang)} />;
  if (error) return <EmptyState msg={String(error.message || error)} />;
  if (!data || data.length === 0)
    return <EmptyState msg={t("noData", lang)} />;

  return (
    <div className="p-6 space-y-4">
      {staleCount > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            {staleCount === 1
              ? t("staleBannerOne", lang)
              : `${staleCount} ${t("staleBannerMany", lang)}`}
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-400">
          {t("allFresh", lang)}
        </div>
      )}

      {err && (
        <div className="rounded border border-red-700/40 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {err}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <select className={inputCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">{t("filterStatus", lang)}</option>
          {["PASSING", "FAILING", "STALE"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select className={inputCls} value={fModule} onChange={(e) => setFModule(e.target.value)}>
          <option value="">{t("filterModule", lang)}</option>
          {MODULES.map((m) => (
            <option key={m} value={m}>{humanize(m)}</option>
          ))}
        </select>
        <select className={inputCls} value={fEnv} onChange={(e) => setFEnv(e.target.value)}>
          <option value="">{t("filterEnv", lang)}</option>
          {ENVS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div className="space-y-3">
        {filtered.map((item) => (
          <RegRow
            key={item.id}
            item={item}
            lang={lang}
            canEdit={canEdit}
            onReload={reload}
            onErr={setErr}
          />
        ))}
        {filtered.length === 0 && (
          <div className="text-sm text-zinc-500 py-6 text-center">—</div>
        )}
      </div>
    </div>
  );
}

function RegRow({
  item,
  lang,
  canEdit,
  onReload,
  onErr,
}: {
  item: RegItem;
  lang: Lang;
  canEdit: boolean;
  onReload: () => void;
  onErr: (s: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState(item.testSteps || "");
  const [env, setEnv] = useState(item.environment);
  const [stale, setStale] = useState(item.staleAfterDays);
  const [evType, setEvType] = useState("SCREENSHOT");
  const [evUrl, setEvUrl] = useState("");
  const [evLabel, setEvLabel] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onErr(null);
    try {
      await fn();
      onReload();
    } catch (e) {
      onErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const border =
    item.effectiveStatus === "STALE"
      ? "border-amber-500/50"
      : "border-zinc-200 dark:border-zinc-800";

  return (
    <div className={`rounded-lg border ${border} bg-white dark:bg-zinc-900 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{item.title}</div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {humanize(item.module)} · {item.environment}
          </div>
        </div>
        <StatusPill s={item.effectiveStatus} lang={lang} />
      </div>

      <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-zinc-500 sm:grid-cols-2">
        <div>
          {t("colLastVerified", lang)}:{" "}
          {item.lastVerifiedAt ? (
            <span className="text-zinc-700 dark:text-zinc-300">
              {fmtDate(item.lastVerifiedAt, lang)}
            </span>
          ) : (
            <span className="text-amber-400">{t("neverVerified", lang)}</span>
          )}
        </div>
        <div>
          {t("colVerifiedBy", lang)}:{" "}
          <span className="text-zinc-700 dark:text-zinc-300">
            {item.verifiedBy?.name || "—"}
          </span>
        </div>
        <div>
          {t("colStaleAfter", lang)}: {item.staleAfterDays} {t("days", lang)}
        </div>
      </div>

      {!editing && item.testSteps && (
        <div className="mt-3 text-xs">
          <div className="text-zinc-500 mb-0.5">{t("colTestSteps", lang)}</div>
          <pre className="whitespace-pre-wrap font-sans text-zinc-700 dark:text-zinc-300">
            {item.testSteps}
          </pre>
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-2">
          <textarea
            className={`${inputCls} w-full`}
            rows={3}
            value={steps}
            placeholder={t("colTestSteps", lang)}
            onChange={(e) => setSteps(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 items-center">
            <select className={inputCls} value={env} onChange={(e) => setEnv(e.target.value)}>
              {ENVS.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
            <label className="text-xs text-zinc-500">
              {t("colStaleAfter", lang)}:{" "}
              <input
                type="number"
                min={1}
                className={`${inputCls} w-20`}
                value={stale}
                onChange={(e) => setStale(Number(e.target.value))}
              />
            </label>
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/api/qa/regression/${item.id}`, "PATCH", {
                    testSteps: steps || null,
                    environment: env,
                    staleAfterDays: stale,
                  });
                  setEditing(false);
                })
              }
            >
              <Check size={12} /> {t("save", lang)}
            </button>
            <button className={btnCls} onClick={() => setEditing(false)}>
              <X size={12} /> {t("cancel", lang)}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 text-xs">
        <div className="text-zinc-500 mb-1">{t("colEvidence", lang)}</div>
        {item.evidence.length === 0 ? (
          <div className="text-zinc-500">{t("noEvidence", lang)}</div>
        ) : (
          <ul className="space-y-1">
            {item.evidence.map((ev) => (
              <li key={ev.id} className="flex items-center gap-2">
                <EvIcon type={ev.type} />
                <a
                  href={ev.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-500 hover:underline break-all"
                >
                  {ev.label || ev.url}
                </a>
                <span className="text-zinc-500">[{ev.type}]</span>
                {canEdit && (
                  <button
                    className="text-zinc-500 hover:text-red-400"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api(
                          `/api/qa/regression/${item.id}/evidence/${ev.id}`,
                          "DELETE"
                        )
                      )
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canEdit && (
        <div className="mt-4 space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-3">
          <div className="flex flex-wrap gap-2">
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/qa/regression/${item.id}/verify`, "POST", {
                    result: "PASSING",
                  })
                )
              }
            >
              <Check size={12} /> {t("markVerified", lang)}
            </button>
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/qa/regression/${item.id}/verify`, "POST", {
                    result: "FAILING",
                  })
                )
              }
            >
              <X size={12} /> {t("markFailing", lang)}
            </button>
            {!editing && (
              <button className={btnCls} onClick={() => setEditing(true)}>
                <Pencil size={12} /> {t("edit", lang)}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={inputCls}
              value={evType}
              onChange={(e) => setEvType(e.target.value)}
            >
              {EV_TYPES.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
            <input
              className={`${inputCls} flex-1 min-w-[160px]`}
              placeholder={t("url", lang)}
              value={evUrl}
              onChange={(e) => setEvUrl(e.target.value)}
            />
            <input
              className={`${inputCls} w-32`}
              placeholder={t("label", lang)}
              value={evLabel}
              onChange={(e) => setEvLabel(e.target.value)}
            />
            <button
              className={btnCls}
              disabled={busy || !evUrl.trim()}
              onClick={() =>
                run(async () => {
                  await api(`/api/qa/regression/${item.id}/evidence`, "POST", {
                    type: evType,
                    url: evUrl.trim(),
                    label: evLabel.trim() || null,
                  });
                  setEvUrl("");
                  setEvLabel("");
                })
              }
            >
              <Plus size={12} /> {t("addEvidence", lang)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Coverage ───────────────────────── */

function isOverdue(deadline: string | null) {
  if (!deadline) return false;
  return new Date(deadline).getTime() < new Date("2026-05-19T00:00:00Z").getTime();
}

function Coverage({ lang, canEdit }: { lang: Lang; canEdit: boolean }) {
  const { data, error, isLoading } = useSWR<CovItem[]>(
    "/api/qa/coverage",
    fetcher
  );
  const [view, setView] = useState<"kanban" | "table">("kanban");
  const [err, setErr] = useState<string | null>(null);
  const reload = () => globalMutate("/api/qa/coverage");

  if (isLoading) return <EmptyState msg={t("loading", lang)} />;
  if (error) return <EmptyState msg={String(error.message || error)} />;
  if (!data || data.length === 0) return <EmptyState msg={t("noData", lang)} />;

  return (
    <div className="p-6 space-y-4">
      <div className="flex gap-2">
        {(["kanban", "table"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded px-3 py-1 text-xs border ${
              view === v
                ? "bg-[#183661] text-white border-[#183661]"
                : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            {t(v === "kanban" ? "kanbanView" : "tableView", lang)}
          </button>
        ))}
      </div>

      {err && (
        <div className="rounded border border-red-700/40 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {err}
        </div>
      )}

      {view === "kanban" ? (
        <div className="grid gap-4 md:grid-cols-4">
          {COV_STATUSES.map((st) => (
            <div key={st} className="space-y-2">
              <div className="text-xs font-semibold text-zinc-500 uppercase">
                {t(
                  st === "NOT_STARTED"
                    ? "stNotStarted"
                    : st === "IN_PROGRESS"
                    ? "stInProgress"
                    : st === "BLOCKED"
                    ? "stBlocked"
                    : "stDone",
                  lang
                )}{" "}
                ({data.filter((c) => c.status === st).length})
              </div>
              {data
                .filter((c) => c.status === st)
                .map((c) => (
                  <CovCard
                    key={c.id}
                    item={c}
                    lang={lang}
                    canEdit={canEdit}
                    onReload={reload}
                    onErr={setErr}
                  />
                ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500 text-xs">
              <tr>
                {["colTitle", "colArea", "colOwner", "colStatus", "colDeadline", "colBlockers", "colNotes"].map(
                  (k) => (
                    <th key={k} className="px-3 py-2 text-start font-medium">
                      {t(k, lang)}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-3 py-2">{c.title}</td>
                  <td className="px-3 py-2">{c.area}</td>
                  <td className="px-3 py-2">{c.owner || t("unassigned", lang)}</td>
                  <td className="px-3 py-2">
                    <CovStatusEdit
                      item={c}
                      canEdit={canEdit}
                      onReload={reload}
                      onErr={setErr}
                    />
                  </td>
                  <td className="px-3 py-2">
                    {c.deadline ? (
                      <span className={isOverdue(c.deadline) ? "text-red-400" : ""}>
                        {fmtDate(c.deadline, lang)}
                        {isOverdue(c.deadline) && ` (${t("overdue", lang)})`}
                      </span>
                    ) : (
                      <span className="text-zinc-500">{t("noDeadline", lang)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {c.blockers || "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {c.notes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CovStatusEdit({
  item,
  canEdit,
  onReload,
  onErr,
}: {
  item: CovItem;
  canEdit: boolean;
  onReload: () => void;
  onErr: (s: string | null) => void;
}) {
  if (!canEdit) return <span className="text-xs">{item.status}</span>;
  return (
    <select
      className={`${inputCls} text-xs`}
      value={item.status}
      onChange={async (e) => {
        onErr(null);
        try {
          await api(`/api/qa/coverage/${item.id}`, "PATCH", {
            status: e.target.value,
          });
          onReload();
        } catch (err) {
          onErr(err instanceof Error ? err.message : "Error");
        }
      }}
    >
      {COV_STATUSES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

function CovCard({
  item,
  lang,
  canEdit,
  onReload,
  onErr,
}: {
  item: CovItem;
  lang: Lang;
  canEdit: boolean;
  onReload: () => void;
  onErr: (s: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(item.owner || "");
  const [deadline, setDeadline] = useState(
    item.deadline ? item.deadline.slice(0, 10) : ""
  );
  const [notes, setNotes] = useState(item.notes || "");
  const [blockers, setBlockers] = useState(item.blockers || "");
  const overdue = isOverdue(item.deadline);

  const idx = COV_STATUSES.indexOf(item.status);
  const next = COV_STATUSES[idx + 1];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onErr(null);
    try {
      await fn();
      onReload();
    } catch (e) {
      onErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-lg border bg-white dark:bg-zinc-900 p-3 text-xs ${
        overdue ? "border-red-700/50" : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {item.title}
      </div>
      <div className="text-zinc-500 mt-0.5">{item.area}</div>

      {!editing ? (
        <div className="mt-2 space-y-1 text-zinc-500">
          <div>
            {t("colOwner", lang)}: {item.owner || t("unassigned", lang)}
          </div>
          <div>
            {t("colDeadline", lang)}:{" "}
            {item.deadline ? (
              <span className={overdue ? "text-red-400 font-medium" : ""}>
                {fmtDate(item.deadline, lang)}
                {overdue && ` · ${t("overdue", lang)}`}
              </span>
            ) : (
              t("noDeadline", lang)
            )}
          </div>
          {item.blockers && (
            <div className="text-amber-400">
              {t("colBlockers", lang)}: {item.blockers}
            </div>
          )}
          {item.notes && (
            <div>
              {t("colNotes", lang)}: {item.notes}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <input
            className={`${inputCls} w-full`}
            placeholder={t("colOwner", lang)}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
          <input
            type="date"
            className={`${inputCls} w-full`}
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
          <textarea
            className={`${inputCls} w-full`}
            rows={2}
            placeholder={t("colBlockers", lang)}
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
          />
          <textarea
            className={`${inputCls} w-full`}
            rows={2}
            placeholder={t("colNotes", lang)}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/api/qa/coverage/${item.id}`, "PATCH", {
                    owner: owner.trim() || null,
                    deadline: deadline
                      ? new Date(deadline + "T00:00:00.000Z").toISOString()
                      : null,
                    notes: notes.trim() || null,
                    blockers: blockers.trim() || null,
                  });
                  setEditing(false);
                })
              }
            >
              <Check size={12} /> {t("save", lang)}
            </button>
            <button className={btnCls} onClick={() => setEditing(false)}>
              <X size={12} /> {t("cancel", lang)}
            </button>
          </div>
        </div>
      )}

      {canEdit && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {next && (
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/qa/coverage/${item.id}`, "PATCH", { status: next })
                )
              }
            >
              {t("moveStatus", lang)}{" "}
              {t(
                next === "IN_PROGRESS"
                  ? "stInProgress"
                  : next === "BLOCKED"
                  ? "stBlocked"
                  : "stDone",
                lang
              )}
            </button>
          )}
          <button className={btnCls} onClick={() => setEditing(true)}>
            <Pencil size={12} /> {t("edit", lang)}
          </button>
        </div>
      )}
    </div>
  );
}
