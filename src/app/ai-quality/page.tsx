"use client";
import { useState, useMemo } from "react";
import useSWR, { mutate } from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import {
  Sparkles,
  ClipboardList,
  GitCompare,
  History,
  BarChart3,
  Settings as SettingsIcon,
  Play,
  Star,
} from "lucide-react";

const MODULES = [
  "quick_report",
  "decision_engine",
  "gtm_strategy",
  "pitch_deck",
  "pitch_to_vc",
  "find_experts",
  "ai_research_assistant",
];
const FLAGS = ["NONE", "HALLUCINATION", "REFUSAL", "ERROR"] as const;

function flagClass(f: string) {
  if (f === "HALLUCINATION") return "text-amber-500";
  if (f === "REFUSAL") return "text-sky-500";
  if (f === "ERROR") return "text-red-500";
  return "text-zinc-400";
}
function fmtUsd(v: number | null | undefined) {
  return v == null ? "—" : `$${v.toFixed(4)}`;
}
function fmtMs(v: number | null | undefined) {
  return v == null ? "—" : `${v} ms`;
}

function Card({
  title,
  desc,
  icon,
  children,
}: {
  title: string;
  desc?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="m-6 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 flex items-center gap-2">
        {icon}
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {desc && <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stars({
  value,
  onRate,
  lang,
}: {
  value: number | null;
  onRate?: (n: number) => void;
  lang: Lang;
}) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      title={t("aiqRating", lang)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onRate}
          onClick={() => onRate?.(n)}
          className={onRate ? "cursor-pointer" : "cursor-default"}
        >
          <Star
            size={14}
            className={
              value != null && n <= value
                ? "fill-amber-400 text-amber-400"
                : "text-zinc-400"
            }
          />
        </button>
      ))}
    </span>
  );
}

function SampleRow({
  s,
  canReview,
  lang,
  onChanged,
}: {
  s: any;
  canReview: boolean;
  lang: Lang;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const patch = async (body: any) => {
    await fetch(`/api/ai-quality/samples/${s.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    onChanged();
  };
  return (
    <>
      <tr className="border-t border-zinc-200 dark:border-zinc-800 align-top">
        <td className="px-2 py-2 text-xs text-zinc-500 whitespace-nowrap">
          {fmtDate(s.createdAt, lang)}
        </td>
        <td className="px-2 py-2 text-xs">
          {s.model}
          {s.modelVersion && (
            <span className="text-zinc-500"> @ {s.modelVersion}</span>
          )}
        </td>
        <td className="px-2 py-2 text-xs max-w-[20rem]">
          <div className={open ? "" : "line-clamp-2"}>{s.inputText}</div>
        </td>
        <td className="px-2 py-2 text-xs max-w-[24rem]">
          <div className={open ? "" : "line-clamp-2"}>{s.outputText}</div>
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-1 text-emerald-600 dark:text-emerald-400 text-[11px]"
          >
            {open ? t("aiqCollapse", lang) : t("aiqExpand", lang)}
          </button>
        </td>
        <td className="px-2 py-2 text-xs whitespace-nowrap">
          {fmtUsd(s.costUsd)}
        </td>
        <td className="px-2 py-2 text-xs whitespace-nowrap">
          {fmtMs(s.latencyMs)}
        </td>
        <td className="px-2 py-2">
          <Stars
            value={s.humanRating}
            lang={lang}
            onRate={canReview ? (n) => patch({ rating: n }) : undefined}
          />
        </td>
        <td className="px-2 py-2 text-xs">
          {canReview ? (
            <select
              value={s.flag}
              onChange={(e) => patch({ flag: e.target.value })}
              className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-1 py-0.5 text-xs"
            >
              {FLAGS.map((f) => (
                <option key={f} value={f}>
                  {t(`aiqFlag${f}`, lang)}
                </option>
              ))}
            </select>
          ) : (
            <span className={flagClass(s.flag)}>
              {t(`aiqFlag${s.flag}`, lang)}
            </span>
          )}
        </td>
        <td className="px-2 py-2 text-xs">
          {s.reviewStatus === "REVIEWED" ? (
            <span className="text-emerald-500">
              {t("aiqStatusREVIEWED", lang)}
            </span>
          ) : (
            <span className="text-zinc-500">
              {t("aiqStatusPENDING", lang)}
            </span>
          )}
        </td>
      </tr>
      {open && s.notes && (
        <tr className="bg-zinc-50 dark:bg-zinc-950/40">
          <td colSpan={9} className="px-3 py-2 text-xs text-zinc-500">
            {t("aiqNotes", lang)}: {s.notes}
          </td>
        </tr>
      )}
    </>
  );
}

function SampleTable({
  rows,
  canReview,
  lang,
  onChanged,
}: {
  rows: any[];
  canReview: boolean;
  lang: Lang;
  onChanged: () => void;
}) {
  if (!rows || rows.length === 0)
    return <EmptyState msg={t("aiqNoSamples", lang)} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="px-2 py-1">{t("colStatus", lang)}</th>
            <th className="px-2 py-1">{t("aiqModel", lang)}</th>
            <th className="px-2 py-1">{t("aiqInput", lang)}</th>
            <th className="px-2 py-1">{t("aiqOutput", lang)}</th>
            <th className="px-2 py-1">{t("aiqCost", lang)}</th>
            <th className="px-2 py-1">{t("aiqLatency", lang)}</th>
            <th className="px-2 py-1">{t("aiqRating", lang)}</th>
            <th className="px-2 py-1">{t("aiqFlag", lang)}</th>
            <th className="px-2 py-1">{t("aiqReview", lang)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <SampleRow
              key={s.id}
              s={s}
              canReview={canReview}
              lang={lang}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Page() {
  const { lang } = useUI();
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canReview =
    me?.role === "REVIEWER" ||
    me?.role === "ENGINEER" ||
    me?.role === "ADMIN";
  const canEngineer = me?.role === "ENGINEER" || me?.role === "ADMIN";

  const [moduleF, setModuleF] = useState("");
  const [flagF, setFlagF] = useState("");
  const [reviewF, setReviewF] = useState("");
  const [days, setDays] = useState(30);

  const sampleQs = new URLSearchParams();
  if (moduleF) sampleQs.set("module", moduleF);
  if (flagF) sampleQs.set("flag", flagF);
  if (reviewF) sampleQs.set("reviewStatus", reviewF);
  const samplesKey = `/api/ai-quality/samples?${sampleQs.toString()}`;

  const { data: samplesData } = useSWR(samplesKey, fetcher);
  const { data: queueData } = useSWR("/api/ai-quality/queue", fetcher);
  const { data: casesData } = useSWR(
    "/api/ai-quality/regression/cases",
    fetcher
  );
  const { data: statsData } = useSWR(
    `/api/ai-quality/stats?days=${days}`,
    fetcher
  );
  const { data: providers } = useSWR("/api/ai-quality/providers", fetcher);

  const refreshAll = () => {
    mutate(samplesKey);
    mutate("/api/ai-quality/queue");
    mutate(`/api/ai-quality/stats?days=${days}`);
  };

  const samples: any[] = samplesData?.rows ?? [];
  const queue: any[] = queueData?.rows ?? [];
  const cases: any[] = casesData?.cases ?? [];
  const perModule: any[] = useMemo(
    () => statsData?.perModule ?? [],
    [statsData]
  );

  const ratingChart = useMemo(
    () =>
      perModule.map((m) => ({
        module: m.module,
        rating: m.avgHumanRating ?? 0,
      })),
    [perModule]
  );
  const flagChart = useMemo(
    () =>
      perModule.map((m) => ({
        module: m.module,
        hallucination: Math.round(m.hallucinationRate * 1000) / 10,
        refusal: Math.round(m.refusalRate * 1000) / 10,
        error: Math.round(m.errorRate * 1000) / 10,
      })),
    [perModule]
  );
  const costChart = useMemo(
    () =>
      perModule.map((m) => ({
        module: m.module,
        cost: m.avgCostPerOutput ?? 0,
      })),
    [perModule]
  );

  const noProvider =
    providers &&
    (!providers.providers ||
      !Object.values(providers.providers).some(
        (p: any) => p && p.baseUrl && p.model
      ));

  return (
    <div>
      <PageHeader title={t("aiqTitle", lang)} desc={t("aiqDesc", lang)} />

      <Card
        title={t("aiqSampleLog", lang)}
        icon={<Sparkles size={16} className="text-emerald-500" />}
      >
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          <select
            value={moduleF}
            onChange={(e) => setModuleF(e.target.value)}
            className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          >
            <option value="">{t("aiqAllModules", lang)}</option>
            {MODULES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={flagF}
            onChange={(e) => setFlagF(e.target.value)}
            className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          >
            <option value="">{t("aiqFlag", lang)}: —</option>
            {FLAGS.map((f) => (
              <option key={f} value={f}>
                {t(`aiqFlag${f}`, lang)}
              </option>
            ))}
          </select>
          <select
            value={reviewF}
            onChange={(e) => setReviewF(e.target.value)}
            className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          >
            <option value="">{t("aiqReview", lang)}: —</option>
            <option value="PENDING">{t("aiqStatusPENDING", lang)}</option>
            <option value="REVIEWED">{t("aiqStatusREVIEWED", lang)}</option>
          </select>
        </div>
        <SampleTable
          rows={samples}
          canReview={canReview}
          lang={lang}
          onChanged={refreshAll}
        />
      </Card>

      <Card
        title={t("aiqQueue", lang)}
        desc={t("aiqQueueDesc", lang)}
        icon={<ClipboardList size={16} className="text-amber-500" />}
      >
        {queue.length === 0 ? (
          <EmptyState msg={t("aiqQueueEmpty", lang)} />
        ) : (
          <SampleTable
            rows={queue}
            canReview={canReview}
            lang={lang}
            onChanged={refreshAll}
          />
        )}
      </Card>

      <Card
        title={t("aiqRegression", lang)}
        desc={t("aiqRegressionDesc", lang)}
        icon={<GitCompare size={16} className="text-sky-500" />}
      >
        {noProvider && (
          <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {t("aiqNoProvider", lang)}
          </div>
        )}
        {cases.length === 0 ? (
          <EmptyState msg={t("aiqNoCases", lang)} />
        ) : (
          <div className="space-y-4">
            {cases.map((c) => (
              <RegressionCase
                key={c.id}
                c={c}
                canEngineer={canEngineer}
                lang={lang}
              />
            ))}
          </div>
        )}
      </Card>

      <Card
        title={t("aiqModelVersions", lang)}
        desc={t("aiqModelVersionsDesc", lang)}
        icon={<History size={16} className="text-violet-500" />}
      >
        {perModule.length === 0 ? (
          <EmptyState msg={t("aiqNoSamples", lang)} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="px-2 py-1">{t("aiqModule", lang)}</th>
                  <th className="px-2 py-1">{t("aiqVersion", lang)}</th>
                  <th className="px-2 py-1">{t("aiqAvgRating", lang)}</th>
                </tr>
              </thead>
              <tbody>
                {perModule.map((m) => (
                  <tr
                    key={m.module}
                    className="border-t border-zinc-200 dark:border-zinc-800"
                  >
                    <td className="px-2 py-2">{m.module}</td>
                    <td className="px-2 py-2">
                      {m.modelVersions.length > 1 && (
                        <span className="me-2 rounded bg-violet-500/15 text-violet-500 px-1.5 py-0.5">
                          {t("aiqShift", lang)}
                        </span>
                      )}
                      {m.modelVersions
                        .map((v: any) => `${v.key} (${v.count})`)
                        .join("  ·  ")}
                    </td>
                    <td className="px-2 py-2">
                      {m.avgHumanRating ?? "—"}{" "}
                      <span className="text-zinc-500">
                        ({m.ratedCount} {t("aiqRated", lang)})
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={t("aiqCharts", lang)}
        icon={<BarChart3 size={16} className="text-emerald-500" />}
      >
        <div className="flex items-center gap-2 mb-4 text-xs">
          <span className="text-zinc-500">{t("aiqWindowDays", lang)}</span>
          <input
            type="number"
            value={days}
            min={1}
            max={365}
            onChange={(e) => setDays(Number(e.target.value) || 30)}
            className="w-20 bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          />
        </div>
        {perModule.length === 0 ? (
          <EmptyState msg={t("aiqNoSamples", lang)} />
        ) : (
          <div className="grid gap-8 lg:grid-cols-3">
            <div>
              <div className="text-xs text-zinc-500 mb-2">
                {t("aiqAvgRating", lang)}
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={ratingChart}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="module" tick={{ fontSize: 9 }} hide />
                  <YAxis domain={[0, 5]} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="rating" fill="#10b981" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-2">
                {t("aiqFlagRates", lang)} (%)
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={flagChart}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="module" tick={{ fontSize: 9 }} hide />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="hallucination" fill="#f59e0b" />
                  <Bar dataKey="refusal" fill="#0ea5e9" />
                  <Bar dataKey="error" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-2">
                {t("aiqCostPerOut", lang)} ($)
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={costChart}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="module" tick={{ fontSize: 9 }} hide />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="cost" fill="#8b5cf6" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Card>

      <ProviderConfig
        providers={providers}
        canEngineer={canEngineer}
        lang={lang}
      />
    </div>
  );
}

function RegressionCase({
  c,
  canEngineer,
  lang,
}: {
  c: any;
  canEngineer: boolean;
  lang: Lang;
}) {
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const latest = c.runs?.[0];
  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/ai-quality/regression/cases/${c.id}/run`,
        { method: "POST" }
      );
      const j = await r.json();
      if (!r.ok) setErr(j.error || "Run failed");
      else mutate("/api/ai-quality/regression/cases");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs">
          <span className="font-medium">{c.module}</span>
          <span className="text-zinc-500">
            {" "}
            · {fmtDate(c.createdAt, lang)}
          </span>
        </div>
        {canEngineer && (
          <button
            onClick={run}
            disabled={running}
            className="inline-flex items-center gap-1 rounded bg-[#183661] text-white px-2 py-1 text-xs disabled:opacity-50"
          >
            <Play size={12} />
            {running ? t("aiqRunning", lang) : t("aiqRerun", lang)}
          </button>
        )}
      </div>
      {err && (
        <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          {err}
        </div>
      )}
      <div className="mt-2 text-xs text-zinc-500">{c.inputText}</div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-[11px] text-zinc-500 mb-1">
            {t("aiqBaseline", lang)}
            {c.baselineModel ? ` · ${c.baselineModel}` : ""}
          </div>
          <div className="text-xs whitespace-pre-wrap rounded bg-zinc-50 dark:bg-zinc-950/40 p-2">
            {c.baselineOutput || "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-zinc-500 mb-1">
            {t("aiqLatestRun", lang)}
            {latest
              ? ` · ${latest.model} · ${fmtDate(latest.createdAt, lang)}`
              : ""}
          </div>
          {latest ? (
            <>
              <div className="text-xs whitespace-pre-wrap rounded bg-zinc-50 dark:bg-zinc-950/40 p-2">
                {latest.output}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {t("aiqMatchScore", lang)}:{" "}
                <span className="text-emerald-500 font-medium">
                  {latest.matchScore == null
                    ? "—"
                    : latest.matchScore.toFixed(4)}
                </span>{" "}
                · {fmtUsd(latest.costUsd)} · {fmtMs(latest.latencyMs)}
              </div>
            </>
          ) : (
            <div className="text-xs text-zinc-500">
              {t("aiqNoRun", lang)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderConfig({
  providers,
  canEngineer,
  lang,
}: {
  providers: any;
  canEngineer: boolean;
  lang: Lang;
}) {
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const cfg = form ?? providers ?? { active: "custom", providers: {} };

  const setEntry = (key: string, field: string, value: string) => {
    setForm({
      ...cfg,
      providers: {
        ...cfg.providers,
        [key]: { ...(cfg.providers?.[key] || {}), [field]: value },
      },
    });
  };

  const save = async () => {
    const clean: any = { active: cfg.active, providers: {} };
    for (const k of ["openrouter", "gemini", "custom"]) {
      const p = cfg.providers?.[k];
      if (p && p.baseUrl && p.model) {
        const e: any = {
          baseUrl: p.baseUrl,
          model: p.model,
          apiKey: p.apiKey || providers?.providers?.[k]?.apiKey || "",
        };
        if (p.pricePer1kIn) e.pricePer1kIn = Number(p.pricePer1kIn);
        if (p.pricePer1kOut) e.pricePer1kOut = Number(p.pricePer1kOut);
        if (e.apiKey) clean.providers[k] = e;
      }
    }
    const r = await fetch("/api/ai-quality/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(clean),
    });
    if (r.ok) {
      setSaved(true);
      setForm(null);
      mutate("/api/ai-quality/providers");
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <Card
      title={t("aiqProviders", lang)}
      desc={t("aiqProvidersDesc", lang)}
      icon={<SettingsIcon size={16} className="text-zinc-500" />}
    >
      {!canEngineer ? (
        <EmptyState msg={t("aiqProvidersDesc", lang)} />
      ) : (
        <div className="space-y-5">
          <div className="text-xs flex items-center gap-2">
            <span className="text-zinc-500">
              {t("aiqActiveProvider", lang)}
            </span>
            <select
              value={cfg.active || "custom"}
              onChange={(e) => setForm({ ...cfg, active: e.target.value })}
              className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
            >
              <option value="custom">custom</option>
              <option value="openrouter">openrouter</option>
              <option value="gemini">gemini</option>
            </select>
          </div>
          {["openrouter", "gemini", "custom"].map((k) => {
            const p = cfg.providers?.[k] || {};
            return (
              <div
                key={k}
                className="rounded border border-zinc-200 dark:border-zinc-800 p-3"
              >
                <div className="text-xs font-medium mb-2">{k}</div>
                <div className="grid gap-2 sm:grid-cols-2 text-xs">
                  <label className="flex flex-col gap-1">
                    {t("aiqBaseUrl", lang)}
                    <input
                      value={p.baseUrl || ""}
                      onChange={(e) =>
                        setEntry(k, "baseUrl", e.target.value)
                      }
                      placeholder="https://api.example.com/v1"
                      className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    {t("aiqModel", lang)}
                    <input
                      value={p.model || ""}
                      onChange={(e) => setEntry(k, "model", e.target.value)}
                      className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    {t("aiqApiKey", lang)}
                    <input
                      value={p.apiKey || ""}
                      onChange={(e) => setEntry(k, "apiKey", e.target.value)}
                      placeholder={t("aiqUnchanged", lang)}
                      className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1">
                      {t("aiqPriceIn", lang)}
                      <input
                        value={p.pricePer1kIn ?? ""}
                        onChange={(e) =>
                          setEntry(k, "pricePer1kIn", e.target.value)
                        }
                        className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      {t("aiqPriceOut", lang)}
                      <input
                        value={p.pricePer1kOut ?? ""}
                        onChange={(e) =>
                          setEntry(k, "pricePer1kOut", e.target.value)
                        }
                        className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                      />
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              className="rounded bg-[#183661] text-white px-3 py-1.5 text-xs"
            >
              {t("aiqSave", lang)}
            </button>
            {saved && (
              <span className="text-emerald-500 text-xs">
                {t("aiqSaved", lang)}
              </span>
            )}
            <span className="text-zinc-500 text-[11px]">
              {t("aiqUnchanged", lang)}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
