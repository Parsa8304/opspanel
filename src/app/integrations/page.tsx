"use client";
import { useState } from "react";
import useSWR from "swr";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

const WINDOWS = ["24h", "7d", "30d"] as const;
type Win = (typeof WINDOWS)[number];

interface Stat {
  count: number;
  successRate: number | null;
  errorRate: number | null;
  avgLatency: number | null;
  p95Latency: number | null;
  totalCost: number | null;
  lastSuccessAt: string | null;
  lastCallAt: string | null;
}
interface Quota {
  monthlyQuota: number | null;
  callsThisMonth: number;
  quotaUsedPct: number | null;
  rateLimitPerMin: number | null;
  callsLastMinute: number;
  rateHeadroom: number | null;
}
interface Integ {
  key: string;
  name: string;
  category: string;
  enabled: boolean;
  configured: boolean;
  config: Record<string, any>;
  credentialExpiresAt: string | null;
  credentialExpiry: { days: number | null; warn: boolean; expired: boolean };
  stats: Record<Win, Stat>;
  quota: Quota;
  lastSuccessAt: string | null;
  lastCallAt: string | null;
}

const pct = (v: number | null) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%`;
const ms = (v: number | null) => (v == null ? "—" : `${Math.round(v)} ms`);
const usd = (v: number | null) =>
  v == null ? "—" : `$${v.toFixed(4)}`;

function statusDot(i: Integ) {
  // grey: never called / not configured. green: last call success & recent. red: last call failed.
  if (!i.configured || !i.lastCallAt)
    return { cls: "bg-zinc-500", label: "noCallsYet" };
  const recent =
    Date.now() - new Date(i.lastCallAt).getTime() < 24 * 3600_000;
  const lastSuccess = i.stats["24h"].lastCallAt
    ? i.stats["24h"].lastCallAt === i.stats["24h"].lastSuccessAt
    : false;
  if (lastSuccess && recent)
    return { cls: "bg-emerald-500", label: "testOk" };
  return { cls: "bg-red-500", label: "testFailed" };
}

export default function Page() {
  const { lang } = useUI();
  const { data, mutate, isLoading } = useSWR<{ integrations: Integ[] }>(
    "/api/integrations",
    fetcher,
    { refreshInterval: 30000 }
  );
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canEdit =
    me?.role === "ENGINEER" || me?.role === "ADMIN";
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        title={t("integrationsHealth", lang)}
        desc={t("integrationsHealthDesc", lang)}
      />
      {isLoading && <EmptyState msg={t("loading", lang)} />}
      {data && data.integrations.length === 0 && (
        <EmptyState msg={t("noData", lang)} />
      )}
      {data && data.integrations.length > 0 && (
        <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-4">
          {data.integrations.map((i) => (
            <Card
              key={i.key}
              i={i}
              lang={lang}
              canEdit={canEdit}
              onChanged={() => mutate()}
              onConfigure={() => setOpenKey(i.key)}
            />
          ))}
        </div>
      )}
      {openKey && (
        <ConfigDrawer
          intKey={openKey}
          lang={lang}
          canEdit={canEdit}
          onClose={() => setOpenKey(null)}
          onSaved={() => {
            mutate();
          }}
        />
      )}
    </div>
  );
}

function Card({
  i,
  lang,
  canEdit,
  onChanged,
  onConfigure,
}: {
  i: Integ;
  lang: Lang;
  canEdit: boolean;
  onChanged: () => void;
  onConfigure: () => void;
}) {
  const [win, setWin] = useState<Win>("24h");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const s = i.stats[win];
  const dot = statusDot(i);
  const exp = i.credentialExpiry;

  const toggleEnabled = async () => {
    if (!canEdit) return;
    await fetch(`/api/integrations/${i.key}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !i.enabled }),
    });
    onChanged();
  };

  const runTest = async () => {
    setTesting(true);
    setTestMsg(null);
    const r = await fetch(`/api/integrations/${i.key}/test`, {
      method: "POST",
    });
    const j = await r.json().catch(() => ({}));
    if (j.tested && j.result) {
      setTestMsg(
        (j.result.ok ? t("testOk", lang) : t("testFailed", lang)) +
          ` · ${ms(j.result.latencyMs)}` +
          (j.result.statusCode ? ` · HTTP ${j.result.statusCode}` : "") +
          (j.result.error ? ` · ${j.result.error}` : "")
      );
    } else {
      setTestMsg(t("testNotConfigured", lang));
    }
    setTesting(false);
    onChanged();
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${dot.cls}`}
            title={t(dot.label, lang)}
          />
          <div>
            <div className="font-semibold text-sm">{i.name}</div>
            <span className="text-[11px] rounded px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
              {i.category === "AI_PROVIDER"
                ? t("catAiProvider", lang)
                : t("catDataSource", lang)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled={!canEdit}
            onClick={toggleEnabled}
            className={`text-[11px] rounded px-2 py-1 border ${
              i.enabled
                ? "border-[#183661] text-white bg-[#183661]"
                : "border-zinc-300 dark:border-zinc-700 text-zinc-500"
            } disabled:opacity-50`}
          >
            {i.enabled ? t("enabled", lang) : t("disabled", lang)}
          </button>
          <button
            onClick={onConfigure}
            className="text-[11px] rounded px-2 py-1 border border-zinc-300 dark:border-zinc-700"
          >
            {t("configure", lang)}
          </button>
        </div>
      </div>

      {!i.configured && (
        <div className="text-xs text-amber-600 dark:text-amber-500">
          {t("notConfigured", lang)}
        </div>
      )}

      <div className="text-xs text-zinc-500">
        {t("lastSuccess", lang)}:{" "}
        <span className="text-zinc-700 dark:text-zinc-300">
          {i.lastSuccessAt ? fmtDate(i.lastSuccessAt, lang) : t("neverLabel", lang)}
        </span>
      </div>

      {/* window tabs */}
      <div className="flex gap-1">
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWin(w)}
            className={`text-[11px] rounded px-2 py-0.5 ${
              win === w
                ? "bg-[#183661] text-white"
                : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
            }`}
          >
            {w}
          </button>
        ))}
      </div>

      {s.count === 0 ? (
        <div className="text-xs text-zinc-500 border border-dashed border-zinc-300 dark:border-zinc-700 rounded p-3 text-center">
          {t("noCallsYet", lang)}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <Metric label={t("successRate", lang)} value={pct(s.successRate)} />
          <Metric label={t("errorRate", lang)} value={pct(s.errorRate)} />
          <Metric label={t("avgLatency", lang)} value={ms(s.avgLatency)} />
          <Metric label={t("p95Latency", lang)} value={ms(s.p95Latency)} />
          <Metric
            label={t("callsLabel", lang)}
            value={String(s.count)}
          />
          <Metric label={t("apiCost", lang)} value={usd(s.totalCost)} />
        </div>
      )}

      {/* quota + rate */}
      <div className="space-y-1 text-xs">
        <div className="flex justify-between text-zinc-500">
          <span>{t("quotaLabel", lang)}</span>
          <span>
            {i.quota.monthlyQuota == null
              ? t("noQuota", lang)
              : `${i.quota.callsThisMonth} / ${i.quota.monthlyQuota}`}
          </span>
        </div>
        {i.quota.monthlyQuota != null && (
          <div className="h-1.5 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-[#183661]"
              style={{
                width: `${Math.min(i.quota.quotaUsedPct ?? 0, 100)}%`,
              }}
            />
          </div>
        )}
        <div className="flex justify-between text-zinc-500">
          <span>{t("rateHeadroom", lang)}</span>
          <span>
            {i.quota.rateLimitPerMin == null
              ? t("noRateLimit", lang)
              : `${i.quota.rateHeadroom} / ${i.quota.rateLimitPerMin} /min`}
          </span>
        </div>
      </div>

      {/* credential expiry */}
      <div className="text-xs">
        {i.credentialExpiresAt == null ? (
          <span className="text-zinc-500">{t("noExpiry", lang)}</span>
        ) : exp.expired ? (
          <span className="text-red-500">
            {t("credentialExpiry", lang)}: {t("expired", lang)} (
            {fmtDate(i.credentialExpiresAt, lang)})
          </span>
        ) : (
          <span className={exp.warn ? "text-amber-600 dark:text-amber-500" : "text-zinc-500"}>
            {t("credentialExpiry", lang)}: {t("expiresIn", lang)} {exp.days}{" "}
            {t("days", lang)} ({fmtDate(i.credentialExpiresAt, lang)})
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          disabled={!canEdit || testing || !i.enabled || !i.configured}
          onClick={runTest}
          className="text-xs rounded px-3 py-1.5 bg-[#183661] text-white disabled:opacity-50"
        >
          {testing ? t("testing", lang) : t("testConnection", lang)}
        </button>
        {testMsg && (
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
            {testMsg}
          </span>
        )}
      </div>

      <Detail intKey={i.key} lang={lang} canEdit={canEdit} onChanged={onChanged} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-zinc-50 dark:bg-zinc-800/50 p-2">
      <div className="text-zinc-500 text-[10px]">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function Detail({
  intKey,
  lang,
  canEdit,
  onChanged,
}: {
  intKey: string;
  lang: Lang;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data, mutate } = useSWR<any>(
    open ? `/api/integrations/${intKey}` : null,
    fetcher
  );
  const [title, setTitle] = useState("");
  const [sev, setSev] = useState("minor");

  const chartData =
    data?.recentCalls
      ?.filter((c: any) => typeof c.latencyMs === "number")
      .slice()
      .reverse()
      .map((c: any, idx: number) => ({
        i: idx,
        latency: c.latencyMs,
      })) ?? [];

  const addIncident = async () => {
    if (!title.trim()) return;
    await fetch(`/api/integrations/${intKey}/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, severity: sev }),
    });
    setTitle("");
    mutate();
    onChanged();
  };
  const resolve = async (id: string, resolveIt: boolean) => {
    await fetch(`/api/integrations/${intKey}/incidents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolve: resolveIt }),
    });
    mutate();
  };

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        {open ? "▾ " : "▸ "}
        {t("details", lang)}
      </button>
      {open && data && (
        <div className="mt-3 space-y-4">
          {chartData.length > 1 ? (
            <div>
              <div className="text-xs text-zinc-500 mb-1">
                {t("latencyTrend", lang)}
              </div>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={chartData}>
                  <XAxis dataKey="i" hide />
                  <YAxis width={36} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="latency"
                    stroke="#10b981"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">{t("noCallsYet", lang)}</div>
          )}

          <div>
            <div className="text-xs font-medium mb-1">
              {t("recentCalls", lang)}
            </div>
            {data.recentCalls.length === 0 ? (
              <div className="text-xs text-zinc-500">
                {t("noCallsYet", lang)}
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto text-xs space-y-1">
                {data.recentCalls.slice(0, 20).map((c: any) => (
                  <div
                    key={c.id}
                    className="flex justify-between gap-2 border-b border-zinc-100 dark:border-zinc-800 py-0.5"
                  >
                    <span
                      className={
                        c.success ? "text-emerald-600" : "text-red-500"
                      }
                    >
                      {c.success ? "✓" : "✗"}{" "}
                      {c.statusCode ? `HTTP ${c.statusCode}` : c.error || "—"}
                    </span>
                    <span className="text-zinc-500">
                      {ms(c.latencyMs)} · {fmtDate(c.createdAt, lang)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-medium mb-1">
              {t("incidents", lang)}
            </div>
            {data.incidents.length === 0 ? (
              <div className="text-xs text-zinc-500">
                {t("noIncidents", lang)}
              </div>
            ) : (
              <div className="space-y-1 text-xs">
                {data.incidents.map((inc: any) => (
                  <div
                    key={inc.id}
                    className="flex justify-between items-center gap-2 border-b border-zinc-100 dark:border-zinc-800 py-1"
                  >
                    <div>
                      <span
                        className={`mr-1 ${
                          inc.severity === "critical"
                            ? "text-red-500"
                            : inc.severity === "major"
                            ? "text-amber-600"
                            : "text-zinc-500"
                        }`}
                      >
                        [{t(
                          inc.severity === "critical"
                            ? "sevCritical"
                            : inc.severity === "major"
                            ? "sevMajor"
                            : "sevMinor",
                          lang
                        )}]
                      </span>
                      {inc.title}
                      <span className="text-zinc-500 ml-2">
                        {inc.resolvedAt
                          ? t("resolved", lang)
                          : t("ongoing", lang)}{" "}
                        · {fmtDate(inc.startedAt, lang)}
                      </span>
                    </div>
                    {canEdit && !inc.resolvedAt && (
                      <button
                        onClick={() => resolve(inc.id, true)}
                        className="rounded px-2 py-0.5 border border-zinc-300 dark:border-zinc-700"
                      >
                        {t("resolve", lang)}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canEdit && (
              <div className="flex gap-2 mt-2">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("addIncident", lang)}
                  className="flex-1 text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
                />
                <select
                  value={sev}
                  onChange={(e) => setSev(e.target.value)}
                  className="text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1"
                >
                  <option value="minor">{t("sevMinor", lang)}</option>
                  <option value="major">{t("sevMajor", lang)}</option>
                  <option value="critical">{t("sevCritical", lang)}</option>
                </select>
                <button
                  onClick={addIncident}
                  className="text-xs rounded px-3 py-1 bg-[#183661] text-white"
                >
                  {t("add", lang)}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigDrawer({
  intKey,
  lang,
  canEdit,
  onClose,
  onSaved,
}: {
  intKey: string;
  lang: Lang;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, mutate } = useSWR<any>(
    `/api/integrations/${intKey}`,
    fetcher
  );
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const cfg = data?.config ?? {};
  const val = (k: string, fallback = "") =>
    form[k] !== undefined ? form[k] : fallback;
  const set = (k: string, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    const config: Record<string, any> = {};
    if (form.baseUrl !== undefined) config.baseUrl = form.baseUrl;
    if (form.healthPath !== undefined) config.healthPath = form.healthPath;
    if (form.authHeader) config.authHeader = form.authHeader; // only send if typed
    if (form.apiKey) config.apiKey = form.apiKey;
    if (form.monthlyQuota !== undefined)
      config.monthlyQuota = form.monthlyQuota === "" ? null : Number(form.monthlyQuota);
    if (form.rateLimitPerMin !== undefined)
      config.rateLimitPerMin =
        form.rateLimitPerMin === "" ? null : Number(form.rateLimitPerMin);
    const body: any = { config };
    if (form.credentialExpiresAt !== undefined)
      body.credentialExpiresAt = form.credentialExpiresAt || null;
    await fetch(`/api/integrations/${intKey}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    setForm({});
    mutate();
    onSaved();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex justify-end z-50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md h-full bg-white dark:bg-zinc-900 border-s border-zinc-200 dark:border-zinc-800 p-5 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold">
            {t("configEditor", lang)} · {data?.name ?? intKey}
          </h2>
          <button onClick={onClose} className="text-zinc-500">
            ✕
          </button>
        </div>
        {!data ? (
          <div className="text-sm text-zinc-500">{t("loading", lang)}</div>
        ) : (
          <div className="space-y-3 text-sm">
            <Field
              label={t("baseUrl", lang)}
              value={val("baseUrl", cfg.baseUrl ?? "")}
              onChange={(v) => set("baseUrl", v)}
              disabled={!canEdit}
              placeholder="https://api.example.com"
            />
            <Field
              label={t("healthPath", lang)}
              value={val("healthPath", cfg.healthPath ?? "")}
              onChange={(v) => set("healthPath", v)}
              disabled={!canEdit}
              placeholder="/health"
            />
            <Field
              label={t("authHeader", lang)}
              value={val("authHeader", cfg.authHeader ?? "")}
              onChange={(v) => set("authHeader", v)}
              disabled={!canEdit}
              placeholder={cfg.authHeader || "Bearer …"}
            />
            <Field
              label={t("apiKey", lang)}
              value={val("apiKey", cfg.apiKey ?? "")}
              onChange={(v) => set("apiKey", v)}
              disabled={!canEdit}
              placeholder={cfg.apiKey || "••••"}
            />
            <Field
              label={t("monthlyQuotaField", lang)}
              value={val(
                "monthlyQuota",
                cfg.monthlyQuota != null ? String(cfg.monthlyQuota) : ""
              )}
              onChange={(v) => set("monthlyQuota", v)}
              disabled={!canEdit}
              type="number"
            />
            <Field
              label={t("rateLimitField", lang)}
              value={val(
                "rateLimitPerMin",
                cfg.rateLimitPerMin != null ? String(cfg.rateLimitPerMin) : ""
              )}
              onChange={(v) => set("rateLimitPerMin", v)}
              disabled={!canEdit}
              type="number"
            />
            <Field
              label={t("credentialExpiresAt", lang)}
              value={val(
                "credentialExpiresAt",
                data.credentialExpiresAt
                  ? new Date(data.credentialExpiresAt)
                      .toISOString()
                      .slice(0, 10)
                  : ""
              )}
              onChange={(v) => set("credentialExpiresAt", v)}
              disabled={!canEdit}
              type="date"
            />
            {canEdit ? (
              <button
                onClick={save}
                disabled={saving}
                className="w-full rounded bg-[#183661] text-white py-2 disabled:opacity-50"
              >
                {saving ? t("loading", lang) : t("save", lang)}
              </button>
            ) : (
              <div className="text-xs text-amber-600">
                {t("forbiddenAction", lang)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm disabled:opacity-60"
      />
    </label>
  );
}
