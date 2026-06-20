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
  ShieldCheck,
  ShieldX,
  ClipboardList,
  User,
  Tag,
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

const TABS = [
  { key: "reg", labelKey: "tabRegression" },
  { key: "cov", labelKey: "tabCoverage" },
  { key: "checklist", labelKey: "tabChecklist" },
  { key: "gates", labelKey: "tabGates" },
] as const;

type Tab = typeof TABS[number]["key"];

export default function Page() {
  const { lang } = useUI();
  const [tab, setTab] = useState<Tab>("reg");
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canEdit = me && (me.role === "ENGINEER" || me.role === "ADMIN");
  const isAdmin = me?.role === "ADMIN";

  return (
    <div>
      <PageHeader title={t("qaTracking", lang)} desc={t("qaTrackingDesc", lang)} />
      <div className="px-6 pt-4 flex flex-wrap gap-2">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`rounded px-3 py-1.5 text-sm border ${
              tab === tb.key
                ? "bg-indigo-600 text-white border-indigo-500"
                : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            {t(tb.labelKey, lang)}
          </button>
        ))}
      </div>
      {tab === "reg" && <Regression lang={lang} canEdit={!!canEdit} />}
      {tab === "cov" && <Coverage lang={lang} canEdit={!!canEdit} />}
      {tab === "checklist" && <ChecklistSection lang={lang} canEdit={!!canEdit} />}
      {tab === "gates" && <GatesSection lang={lang} isAdmin={!!isAdmin} />}
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
                ? "bg-indigo-600 text-white border-indigo-500"
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

/* ───────────────────────── Checklist ───────────────────────── */

type ChecklistItem = {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  priority: string;
  status: string;
  owner: string | null;
  reviewer: string | null;
  verifiedAt: string | null;
  notes: string | null;
};

type Checklist = {
  id: string;
  version: string;
  environment: string;
  title: string | null;
  createdAt: string;
  items: ChecklistItem[];
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: "text-red-400 bg-red-500/10 border-red-500/30",
  P1: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  P2: "text-zinc-400 bg-zinc-500/10 border-zinc-500/30",
};

function ChecklistSection({ lang, canEdit }: { lang: Lang; canEdit: boolean }) {
  const [envFilter, setEnvFilter] = useState("");
  const [newVersion, setNewVersion] = useState("");
  const [newEnv, setNewEnv] = useState("STAGING");
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const qs = envFilter ? `?environment=${envFilter}` : "";
  const { data, isLoading, error } = useSWR<Checklist[]>(
    `/api/qa/checklists${qs}`,
    fetcher
  );
  const reload = () => globalMutate(`/api/qa/checklists${qs}`);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const createChecklist = () =>
    run(async () => {
      if (!newVersion.trim()) throw new Error("Version is required");
      await api("/api/qa/checklists", "POST", {
        version: newVersion.trim(),
        environment: newEnv,
        title: newTitle.trim() || null,
      });
      setNewVersion("");
      setNewTitle("");
    });

  if (isLoading) return <EmptyState msg={t("loading", lang)} />;
  if (error) return <EmptyState msg={String(error.message || error)} />;

  return (
    <div className="p-6 space-y-4">
      {err && (
        <div className="rounded border border-red-700/40 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {err}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-end">
        <select className={inputCls} value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}>
          <option value="">{t("filterEnv", lang)}</option>
          {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        {canEdit && (
          <>
            <input
              className={`${inputCls} w-36`}
              placeholder={t("checklistVersion", lang)}
              value={newVersion}
              onChange={(e) => setNewVersion(e.target.value)}
            />
            <input
              className={`${inputCls} w-48`}
              placeholder={t("colTitle", lang)}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <select className={inputCls} value={newEnv} onChange={(e) => setNewEnv(e.target.value)}>
              {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <button
              className={btnCls}
              disabled={busy || !newVersion.trim()}
              onClick={createChecklist}
            >
              <Plus size={12} /> {t("checklistNew", lang)}
            </button>
          </>
        )}
      </div>

      {(!data || data.length === 0) ? (
        <div className="text-sm text-zinc-500 py-8 text-center">{t("checklistEmpty", lang)}</div>
      ) : (
        <div className="space-y-4">
          {data.map((cl) => (
            <ChecklistCard
              key={cl.id}
              checklist={cl}
              lang={lang}
              canEdit={canEdit}
              open={openId === cl.id}
              onToggle={() => setOpenId(openId === cl.id ? null : cl.id)}
              onReload={reload}
              onErr={setErr}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChecklistCard({
  checklist,
  lang,
  canEdit,
  open,
  onToggle,
  onReload,
  onErr,
}: {
  checklist: Checklist;
  lang: Lang;
  canEdit: boolean;
  open: boolean;
  onToggle: () => void;
  onReload: () => void;
  onErr: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addPriority, setAddPriority] = useState("P1");
  const [addKind, setAddKind] = useState("MANUAL");
  const [addOwner, setAddOwner] = useState("");
  const [addReviewer, setAddReviewer] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const p0Count = checklist.items.filter((i) => i.priority === "P0").length;
  const p0Incomplete = checklist.items.filter(
    (i) => i.priority === "P0" && i.status !== "PASSING"
  ).length;
  const passing = checklist.items.filter((i) => i.status === "PASSING").length;
  const total = checklist.items.length;

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

  const addItem = () =>
    run(async () => {
      if (!addTitle.trim()) throw new Error("Title is required");
      await api(`/api/qa/checklists/${checklist.id}/items`, "POST", {
        title: addTitle.trim(),
        description: addDesc.trim() || null,
        kind: addKind,
        priority: addPriority,
        owner: addOwner.trim() || null,
        reviewer: addReviewer.trim() || null,
      });
      setAddTitle("");
      setAddDesc("");
      setAddOwner("");
      setAddReviewer("");
      setShowAdd(false);
    });

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-sm text-left"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <ClipboardList size={16} className="text-emerald-500 shrink-0" />
          <div>
            <div className="font-semibold flex items-center gap-2">
              <Tag size={12} className="text-zinc-400" />
              {checklist.version}
              {checklist.title && (
                <span className="text-zinc-500 font-normal">· {checklist.title}</span>
              )}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">{checklist.environment}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {p0Count > 0 && p0Incomplete > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <AlertTriangle size={12} /> {p0Incomplete} P0
            </span>
          )}
          <span className="text-zinc-500">
            {passing}/{total} {t("checklistMarkPass", lang)}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
          {p0Incomplete > 0 && (
            <div className="flex items-center gap-2 rounded border border-red-700/40 bg-red-600/10 px-3 py-2 text-xs text-red-400">
              <AlertTriangle size={12} />
              {t("checklistP0Warning", lang)}
            </div>
          )}

          {checklist.items.length === 0 ? (
            <div className="text-sm text-zinc-500 text-center py-4">{t("checklistNoItems", lang)}</div>
          ) : (
            <div className="space-y-2">
              {checklist.items.map((item) => (
                <ChecklistItemRow
                  key={item.id}
                  item={item}
                  checklistId={checklist.id}
                  lang={lang}
                  canEdit={canEdit}
                  onReload={onReload}
                  onErr={onErr}
                />
              ))}
            </div>
          )}

          {canEdit && (
            <div className="border-t border-zinc-200 dark:border-zinc-800 pt-3">
              {!showAdd ? (
                <button className={btnCls} onClick={() => setShowAdd(true)}>
                  <Plus size={12} /> {t("checklistAddItem", lang)}
                </button>
              ) : (
                <div className="space-y-2">
                  <input
                    className={`${inputCls} w-full`}
                    placeholder={t("checklistItemTitle", lang)}
                    value={addTitle}
                    onChange={(e) => setAddTitle(e.target.value)}
                  />
                  <textarea
                    className={`${inputCls} w-full`}
                    rows={2}
                    placeholder={t("checklistItemDesc", lang)}
                    value={addDesc}
                    onChange={(e) => setAddDesc(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <select className={inputCls} value={addPriority} onChange={(e) => setAddPriority(e.target.value)}>
                      {["P0", "P1", "P2"].map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <select className={inputCls} value={addKind} onChange={(e) => setAddKind(e.target.value)}>
                      <option value="MANUAL">MANUAL</option>
                      <option value="AUTOMATED">AUTOMATED</option>
                    </select>
                    <input
                      className={`${inputCls} w-32`}
                      placeholder={t("checklistOwner", lang)}
                      value={addOwner}
                      onChange={(e) => setAddOwner(e.target.value)}
                    />
                    <input
                      className={`${inputCls} w-32`}
                      placeholder={t("checklistReviewer", lang)}
                      value={addReviewer}
                      onChange={(e) => setAddReviewer(e.target.value)}
                    />
                    <button className={btnCls} disabled={busy || !addTitle.trim()} onClick={addItem}>
                      <Check size={12} /> {t("save", lang)}
                    </button>
                    <button className={btnCls} onClick={() => { setShowAdd(false); setAddTitle(""); setAddDesc(""); }}>
                      <X size={12} /> {t("cancel", lang)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChecklistItemRow({
  item,
  checklistId,
  lang,
  canEdit,
  onReload,
  onErr,
}: {
  item: ChecklistItem;
  checklistId: string;
  lang: Lang;
  canEdit: boolean;
  onReload: () => void;
  onErr: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(item.owner || "");
  const [reviewer, setReviewer] = useState(item.reviewer || "");
  const [notes, setNotes] = useState(item.notes || "");

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

  const statusColor =
    item.status === "PASSING"
      ? "text-emerald-400"
      : item.status === "FAILING"
      ? "text-red-400"
      : "text-amber-400";

  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-xs ${PRIORITY_COLORS[item.priority]}`}>
          {item.priority}
        </span>
        <span className="rounded bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5">{item.kind}</span>
        <span className={`font-medium text-sm ${statusColor}`}>{item.title}</span>
        <span className={`ml-auto font-mono ${statusColor}`}>{item.status}</span>
      </div>

      {item.description && (
        <div className="mt-1 text-zinc-500">{item.description}</div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-zinc-500">
        {editing ? (
          <>
            <input
              className={`${inputCls} w-28`}
              placeholder={t("checklistOwner", lang)}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
            <input
              className={`${inputCls} w-28`}
              placeholder={t("checklistReviewer", lang)}
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
            />
            <textarea
              className={`${inputCls} w-full`}
              rows={2}
              placeholder={t("checklistNotes", lang)}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </>
        ) : (
          <>
            {item.owner && <span className="flex items-center gap-1"><User size={11} /> {item.owner}</span>}
            {item.reviewer && <span className="flex items-center gap-1"><User size={11} /> {item.reviewer}</span>}
            {item.notes && <span>{item.notes}</span>}
            {item.verifiedAt && <span>{fmtDate(item.verifiedAt, lang)}</span>}
          </>
        )}
      </div>

      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          {!editing ? (
            <>
              <button
                className={btnCls}
                disabled={busy}
                onClick={() =>
                  run(() =>
                    api(`/api/qa/checklists/${checklistId}/items/${item.id}`, "PATCH", { status: "PASSING" })
                  )
                }
              >
                <Check size={11} /> {t("checklistMarkPass", lang)}
              </button>
              <button
                className={btnCls}
                disabled={busy}
                onClick={() =>
                  run(() =>
                    api(`/api/qa/checklists/${checklistId}/items/${item.id}`, "PATCH", { status: "FAILING" })
                  )
                }
              >
                <X size={11} /> {t("checklistMarkFail", lang)}
              </button>
              <button className={btnCls} onClick={() => setEditing(true)}>
                <Pencil size={11} /> {t("edit", lang)}
              </button>
              <button
                className={`${btnCls} text-red-400 hover:text-red-300`}
                disabled={busy}
                onClick={() =>
                  run(() =>
                    api(`/api/qa/checklists/${checklistId}/items/${item.id}`, "DELETE")
                  )
                }
              >
                <Trash2 size={11} />
              </button>
            </>
          ) : (
            <>
              <button
                className={btnCls}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api(`/api/qa/checklists/${checklistId}/items/${item.id}`, "PATCH", {
                      owner: owner.trim() || null,
                      reviewer: reviewer.trim() || null,
                      notes: notes.trim() || null,
                    });
                    setEditing(false);
                  })
                }
              >
                <Check size={11} /> {t("save", lang)}
              </button>
              <button className={btnCls} onClick={() => setEditing(false)}>
                <X size={11} /> {t("cancel", lang)}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Quality Gates ───────────────────────── */

type QualityGateData = {
  id: string;
  environment: string;
  minPassRate: number;
  requireP0Checks: boolean;
  blockOnFailing: boolean;
  enabled: boolean;
};

function GatesSection({ lang, isAdmin }: { lang: Lang; isAdmin: boolean }) {
  const { data: gates, isLoading, error, mutate } = useSWR<QualityGateData[]>("/api/qa/gates", fetcher);
  const [err, setErr] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<Record<string, { allowed: boolean; reasons: string[] }>>({});
  const [addEnv, setAddEnv] = useState("STAGING");
  const [busy, setBusy] = useState(false);

  const existingEnvs = new Set((gates || []).map((g) => g.environment));
  const availableEnvs = ENVS.filter((e) => !existingEnvs.has(e));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const checkGate = async (env: string) => {
    try {
      const res = await api("/api/qa/gates/check", "POST", { environment: env });
      setCheckResults((r) => ({ ...r, [env]: res }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  if (isLoading) return <EmptyState msg={t("loading", lang)} />;
  if (error) return <EmptyState msg={String(error.message || error)} />;

  return (
    <div className="p-6 space-y-4">
      <div className="text-sm text-zinc-500">{t("gatesDesc", lang)}</div>

      {err && (
        <div className="rounded border border-red-700/40 bg-red-600/10 px-3 py-2 text-xs text-red-400">
          {err}
        </div>
      )}

      {(!gates || gates.length === 0) && (
        <div className="text-sm text-zinc-500 py-4 text-center">{t("gateNoGates", lang)}</div>
      )}

      <div className="space-y-3">
        {(gates || []).map((gate) => (
          <GateCard
            key={gate.id}
            gate={gate}
            lang={lang}
            isAdmin={isAdmin}
            checkResult={checkResults[gate.environment]}
            onCheck={() => checkGate(gate.environment)}
            onReload={() => mutate()}
            onErr={setErr}
          />
        ))}
      </div>

      {isAdmin && availableEnvs.length > 0 && (
        <div className="flex items-center gap-2 pt-2">
          <span className="text-sm text-zinc-500">{t("gateAddFor", lang)}</span>
          <select className={inputCls} value={addEnv} onChange={(e) => setAddEnv(e.target.value)}>
            {availableEnvs.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <button
            className={btnCls}
            disabled={busy}
            onClick={() =>
              run(() => api(`/api/qa/gates/${addEnv}`, "PUT", {
                minPassRate: 0.8,
                requireP0Checks: true,
                blockOnFailing: true,
                enabled: true,
              }))
            }
          >
            <Plus size={12} /> {t("gateAddFor", lang)} {addEnv}
          </button>
        </div>
      )}
    </div>
  );
}

function GateCard({
  gate,
  lang,
  isAdmin,
  checkResult,
  onCheck,
  onReload,
  onErr,
}: {
  gate: QualityGateData;
  lang: Lang;
  isAdmin: boolean;
  checkResult?: { allowed: boolean; reasons: string[] };
  onCheck: () => void;
  onReload: () => void;
  onErr: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    minPassRate: Math.round(gate.minPassRate * 100),
    requireP0Checks: gate.requireP0Checks,
    blockOnFailing: gate.blockOnFailing,
    enabled: gate.enabled,
  });

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
    <div className={`rounded-lg border p-4 ${gate.enabled ? "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900" : "border-zinc-300 dark:border-zinc-700 opacity-60 bg-zinc-50 dark:bg-zinc-900/50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {gate.enabled ? (
            <ShieldCheck size={18} className="text-emerald-400" />
          ) : (
            <ShieldX size={18} className="text-zinc-400" />
          )}
          <span className="font-semibold">{gate.environment}</span>
          {!gate.enabled && <span className="text-xs text-zinc-500">(disabled)</span>}
        </div>

        <div className="flex items-center gap-2">
          <button className={btnCls} onClick={onCheck}>
            {t("gateCheck", lang)}
          </button>
          {isAdmin && !editing && (
            <button className={btnCls} onClick={() => setEditing(true)}>
              <Pencil size={12} /> {t("edit", lang)}
            </button>
          )}
        </div>
      </div>

      {checkResult && (
        <div className={`mt-3 flex items-start gap-2 rounded border px-3 py-2 text-xs ${checkResult.allowed ? "border-emerald-700/40 bg-emerald-600/10 text-emerald-400" : "border-red-700/40 bg-red-600/10 text-red-400"}`}>
          {checkResult.allowed ? (
            <><ShieldCheck size={13} className="mt-0.5 shrink-0" /> {t("gateAllowed", lang)}</>
          ) : (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <AlertTriangle size={13} className="shrink-0" /> {t("gateBlocked", lang)}
              </div>
              <ul className="list-disc ml-4 space-y-0.5">
                {checkResult.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {!editing ? (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-zinc-500 sm:grid-cols-4">
          <div>{t("gateMinPassRate", lang)}: <span className="text-zinc-300">{Math.round(gate.minPassRate * 100)}%</span></div>
          <div>{t("gateRequireP0", lang)}: <span className="text-zinc-300">{gate.requireP0Checks ? "Yes" : "No"}</span></div>
          <div>{t("gateBlockOnFailing", lang)}: <span className="text-zinc-300">{gate.blockOnFailing ? "Yes" : "No"}</span></div>
          <div>{t("gateEnabled", lang)}: <span className="text-zinc-300">{gate.enabled ? "Yes" : "No"}</span></div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-zinc-500">{t("gateMinPassRate", lang)}</span>
              <input
                type="number"
                min={0}
                max={100}
                className={inputCls}
                value={form.minPassRate}
                onChange={(e) => setForm({ ...form, minPassRate: Number(e.target.value) })}
              />
            </label>
            <div className="flex flex-col gap-2 text-xs pt-4">
              {(["requireP0Checks", "blockOnFailing", "enabled"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.checked })}
                  />
                  <span className="text-zinc-400">
                    {k === "requireP0Checks"
                      ? t("gateRequireP0", lang)
                      : k === "blockOnFailing"
                      ? t("gateBlockOnFailing", lang)
                      : t("gateEnabled", lang)}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/api/qa/gates/${gate.environment}`, "PUT", {
                    minPassRate: form.minPassRate / 100,
                    requireP0Checks: form.requireP0Checks,
                    blockOnFailing: form.blockOnFailing,
                    enabled: form.enabled,
                  });
                  setEditing(false);
                })
              }
            >
              <Check size={12} /> {t("gateSave", lang)}
            </button>
            <button className={btnCls} onClick={() => setEditing(false)}>
              <X size={12} /> {t("cancel", lang)}
            </button>
            <button
              className={`${btnCls} text-red-400 hover:text-red-300 ml-auto`}
              disabled={busy}
              onClick={() => run(() => api(`/api/qa/gates/${gate.environment}`, "DELETE"))}
            >
              <Trash2 size={12} /> {t("gateDelete", lang)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
