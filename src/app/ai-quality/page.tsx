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
  Microscope,
  FileCode2,
  GitFork,
  Plus,
  Pencil,
  Check,
  X,
  Trash2,
  Archive,
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

      <ModelBenchmarks lang={lang} />
      <PromptTracking lang={lang} canEngineer={canEngineer} />
      <FallbackPolicies lang={lang} canEngineer={canEngineer} />
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
            className="inline-flex items-center gap-1 rounded bg-indigo-600 text-white px-2 py-1 text-xs disabled:opacity-50"
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
  const [fetchingPricing, setFetchingPricing] = useState<Record<string, boolean>>({});
  const [pricingMsg, setPricingMsg] = useState<Record<string, string>>({});
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

  const fetchPricing = async (providerKey: string) => {
    const p = cfg.providers?.[providerKey] || {};
    const model = p.model?.trim();
    if (!model) {
      setPricingMsg((m) => ({ ...m, [providerKey]: "Enter a model name first" }));
      return;
    }
    setFetchingPricing((s) => ({ ...s, [providerKey]: true }));
    setPricingMsg((m) => ({ ...m, [providerKey]: "" }));
    try {
      const params = new URLSearchParams({ provider: providerKey, model });
      if (p.baseUrl?.trim()) params.set("baseUrl", p.baseUrl.trim());
      if (p.apiKey?.trim()) params.set("apiKey", p.apiKey.trim());
      const res = await fetch(`/api/ai-quality/model-pricing?${params}`);
      const data = await res.json();
      if (!res.ok) {
        setPricingMsg((m) => ({ ...m, [providerKey]: data.error ?? "Not found" }));
        return;
      }
      setForm((prev: any) => {
        const base = prev ?? providers ?? { active: "custom", providers: {} };
        return {
          ...base,
          providers: {
            ...base.providers,
            [providerKey]: {
              ...(base.providers?.[providerKey] || {}),
              pricePer1kIn: String(data.pricePer1kIn),
              pricePer1kOut: String(data.pricePer1kOut),
            },
          },
        };
      });
      setPricingMsg((m) => ({
        ...m,
        [providerKey]: `Fetched: $${data.pricePer1kIn}/1K in · $${data.pricePer1kOut}/1K out${data.contextLength ? ` · ctx ${data.contextLength.toLocaleString()}` : ""}`,
      }));
    } catch (e) {
      setPricingMsg((m) => ({ ...m, [providerKey]: e instanceof Error ? e.message : "Error" }));
    } finally {
      setFetchingPricing((s) => ({ ...s, [providerKey]: false }));
    }
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
            const fetching = fetchingPricing[k];
            const msg = pricingMsg[k];
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
                      onChange={(e) => setEntry(k, "baseUrl", e.target.value)}
                      placeholder="https://api.example.com/v1"
                      className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    {t("aiqModel", lang)}
                    <input
                      value={p.model || ""}
                      onChange={(e) => setEntry(k, "model", e.target.value)}
                      placeholder="e.g. openai/gpt-4o"
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
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-500">
                        {t("aiqPriceIn", lang)} / {t("aiqPriceOut", lang)}
                      </span>
                      <button
                        onClick={() => fetchPricing(k)}
                        disabled={fetching || !p.model}
                        className="inline-flex items-center gap-1 rounded border border-zinc-300 dark:border-zinc-600 px-2 py-0.5 text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                      >
                        {fetching ? (
                          <span className="animate-pulse">fetching…</span>
                        ) : (
                          <>
                            <span>⚡</span> Auto-fill
                          </>
                        )}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={p.pricePer1kIn ?? ""}
                        onChange={(e) => setEntry(k, "pricePer1kIn", e.target.value)}
                        placeholder="$ / 1K in"
                        className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                      />
                      <input
                        value={p.pricePer1kOut ?? ""}
                        onChange={(e) => setEntry(k, "pricePer1kOut", e.target.value)}
                        placeholder="$ / 1K out"
                        className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
                      />
                    </div>
                    {msg && (
                      <span className={`text-[11px] ${msg.startsWith("Fetched") ? "text-emerald-500" : "text-red-400"}`}>
                        {msg}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              className="rounded bg-indigo-600 text-white px-3 py-1.5 text-xs"
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

/* ─────────────────── Model Quality Benchmarks ─────────────────── */

function ModelBenchmarks({ lang }: { lang: Lang }) {
  const [days, setDays] = useState(30);
  const { data } = useSWR(`/api/ai-quality/benchmarks?days=${days}`, fetcher);
  const models: any[] = data?.models ?? [];

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const ms = (v: number | null) => (v == null ? "—" : `${Math.round(v)} ms`);
  const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(5)}`);
  const rat = (v: number | null) => (v == null ? "—" : v.toFixed(2));

  return (
    <Card
      title={t("aiqBenchmarks", lang)}
      desc={t("aiqBenchmarksDesc", lang)}
      icon={<Microscope size={16} className="text-sky-400" />}
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
      {models.length === 0 ? (
        <EmptyState msg={t("aiqNoBenchmarks", lang)} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="px-2 py-2">{t("aiqBenchModel", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchSamples", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchRating", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchLatency", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchP95", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchCost", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchHalluc", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchError", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchFailure", lang)}</th>
                <th className="px-2 py-2 text-end">{t("aiqBenchMatch", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m: any) => {
                const failColor = m.failureRate > 0.2 ? "text-red-400" : m.failureRate > 0.05 ? "text-amber-400" : "text-emerald-400";
                return (
                  <tr key={m.model} className="border-b border-zinc-100 dark:border-zinc-800/60">
                    <td className="px-2 py-2 font-mono">{m.model}</td>
                    <td className="px-2 py-2 text-end">{m.sampleCount}</td>
                    <td className="px-2 py-2 text-end">{rat(m.avgRating)}</td>
                    <td className="px-2 py-2 text-end">{ms(m.avgLatencyMs)}</td>
                    <td className="px-2 py-2 text-end">{ms(m.p95LatencyMs)}</td>
                    <td className="px-2 py-2 text-end">{usd(m.avgCostUsd)}</td>
                    <td className="px-2 py-2 text-end text-amber-400">{pct(m.hallucinationRate)}</td>
                    <td className="px-2 py-2 text-end text-red-400">{pct(m.errorRate)}</td>
                    <td className={`px-2 py-2 text-end font-semibold ${failColor}`}>{pct(m.failureRate)}</td>
                    <td className="px-2 py-2 text-end">{m.avgMatchScore == null ? "—" : m.avgMatchScore.toFixed(3)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ─────────────────── Prompt / Version Tracking ─────────────────── */

function PromptTracking({ lang, canEngineer }: { lang: Lang; canEngineer: boolean }) {
  const [moduleF, setModuleF] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ module: "", name: "", template: "", variables: "", notes: "", deployedAt: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const qs = new URLSearchParams();
  if (moduleF) qs.set("module", moduleF);
  if (showArchived) qs.set("archived", "true");
  const key = `/api/ai-quality/prompts?${qs.toString()}`;
  const { data, mutate: reload } = useSWR(key, fetcher);
  const rows: any[] = data ?? [];

  const save = async () => {
    if (!form.module || !form.name || !form.template) {
      setErr("module, name, and template are required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await fetch("/api/ai-quality/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          variables: form.variables ? form.variables.split(",").map((v) => v.trim()).filter(Boolean) : [],
          deployedAt: form.deployedAt || null,
        }),
      });
      setShowForm(false);
      setForm({ module: "", name: "", template: "", variables: "", notes: "", deployedAt: "" });
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const archiveRow = async (id: string, archive: boolean) => {
    await fetch(`/api/ai-quality/prompts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archive }),
    });
    reload();
  };

  // Group by module+name for display
  const grouped = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.module}::${r.name}`;
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return Array.from(map.entries()).map(([k, versions]) => ({ key: k, versions: versions.sort((a, b) => b.version - a.version) }));
  }, [rows]);

  return (
    <Card
      title={t("aiqPrompts", lang)}
      desc={t("aiqPromptsDesc", lang)}
      icon={<FileCode2 size={16} className="text-violet-400" />}
    >
      <div className="flex flex-wrap gap-2 mb-4 items-center text-xs">
        <input
          className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
          placeholder={t("aiqPromptModule", lang)}
          value={moduleF}
          onChange={(e) => setModuleF(e.target.value)}
        />
        <label className="flex items-center gap-1 text-zinc-500 cursor-pointer">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t("aiqPromptShowArchived", lang)}
        </label>
        {canEngineer && (
          <button
            className="inline-flex items-center gap-1 rounded bg-indigo-600 text-white px-3 py-1 hover:bg-indigo-500"
            onClick={() => setShowForm((s) => !s)}
          >
            <Plus size={12} /> {t("aiqPromptNew", lang)}
          </button>
        )}
      </div>

      {err && <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">{err}</div>}

      {showForm && (
        <div className="mb-4 rounded border border-zinc-200 dark:border-zinc-800 p-4 space-y-2 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" placeholder={t("aiqPromptModule", lang)} value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })} />
            <input className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" placeholder={t("aiqPromptName", lang)} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" placeholder={t("aiqPromptVariables", lang)} value={form.variables} onChange={(e) => setForm({ ...form, variables: e.target.value })} />
            <input type="datetime-local" className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" value={form.deployedAt} onChange={(e) => setForm({ ...form, deployedAt: e.target.value })} />
          </div>
          <textarea rows={4} className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 font-mono" placeholder={t("aiqPromptTemplate", lang)} value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })} />
          <input className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" placeholder={t("aiqPromptNotes", lang)} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <div className="flex gap-2">
            <button disabled={busy} onClick={save} className="rounded bg-indigo-600 text-white px-3 py-1 hover:bg-indigo-500 disabled:opacity-50">{t("aiqSave", lang)}</button>
            <button onClick={() => setShowForm(false)} className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">{t("cancel", lang) || "Cancel"}</button>
          </div>
        </div>
      )}

      {grouped.length === 0 ? (
        <EmptyState msg={t("aiqPromptNoData", lang)} />
      ) : (
        <div className="space-y-3">
          {grouped.map(({ key: gk, versions }) => {
            const latest = versions[0];
            const isOpen = open === gk;
            return (
              <div key={gk} className="rounded border border-zinc-200 dark:border-zinc-800">
                <button className="w-full flex items-center justify-between px-4 py-3 text-left text-xs" onClick={() => setOpen(isOpen ? null : gk)}>
                  <div>
                    <span className="font-medium">{latest.module}</span>
                    <span className="text-zinc-500"> / {latest.name}</span>
                    {latest.deployedAt && <span className="ml-2 text-emerald-500">deployed {fmtDate(latest.deployedAt, lang)}</span>}
                  </div>
                  <span className="text-zinc-500">{versions.length} version{versions.length !== 1 ? "s" : ""}</span>
                </button>
                {isOpen && (
                  <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                    {versions.map((v: any) => (
                      <div key={v.id} className={`rounded border p-3 text-xs space-y-1 ${v.archivedAt ? "opacity-50 border-zinc-400 dark:border-zinc-700" : "border-zinc-200 dark:border-zinc-800"}`}>
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-violet-500/15 text-violet-500 px-1.5 py-0.5">{t("aiqPromptVer", lang)}{v.version}</span>
                          {v.archivedAt && <span className="text-zinc-500">(archived)</span>}
                          {v.deployedAt && <span className="text-emerald-500">{fmtDate(v.deployedAt, lang)}</span>}
                          {canEngineer && (
                            <button
                              className="ml-auto flex items-center gap-1 text-zinc-500 hover:text-zinc-300"
                              onClick={() => archiveRow(v.id, !v.archivedAt)}
                            >
                              <Archive size={12} /> {v.archivedAt ? "Unarchive" : t("aiqPromptArchive", lang)}
                            </button>
                          )}
                        </div>
                        {v.variables?.length > 0 && (
                          <div className="text-zinc-500">vars: {v.variables.join(", ")}</div>
                        )}
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 dark:bg-zinc-950/40 p-2 font-mono text-[11px]">{v.template}</pre>
                        {v.notes && <div className="text-zinc-500">{v.notes}</div>}
                        {v.testResults && (
                          <div className="text-zinc-500">
                            {t("aiqPromptTestResults", lang)}: passed={v.testResults.passed} failed={v.testResults.failed}
                            {v.testResults.avgScore != null && ` · avgScore=${v.testResults.avgScore}`}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ─────────────────── Fallback Model Policies ─────────────────── */

const FALLBACK_KINDS = ["CHEAP_MODEL", "HIGH_QUALITY_MODEL", "LOCAL", "DETERMINISTIC"] as const;
const AI_MODULES_ALL = [
  "quick_report", "decision_engine", "gtm_strategy", "pitch_deck",
  "pitch_to_vc", "find_experts", "ai_research_assistant",
];

function FallbackPolicies({ lang, canEngineer }: { lang: Lang; canEngineer: boolean }) {
  const { data, mutate: reload } = useSWR("/api/ai-quality/fallback", fetcher);
  const rows: any[] = data ?? [];
  const [editId, setEditId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addModule, setAddModule] = useState(AI_MODULES_ALL[0]);
  const [err, setErr] = useState<string | null>(null);

  const existingModules = new Set(rows.map((r) => r.module));
  const availableModules = AI_MODULES_ALL.filter((m) => !existingModules.has(m));

  const deletePolicy = async (module: string) => {
    await fetch(`/api/ai-quality/fallback/${module}`, { method: "DELETE" });
    reload();
  };

  return (
    <Card
      title={t("aiqFallback", lang)}
      desc={t("aiqFallbackDesc", lang)}
      icon={<GitFork size={16} className="text-amber-400" />}
    >
      {err && <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">{err}</div>}

      {rows.length === 0 && !showAdd && (
        <p className="text-sm text-zinc-500 mb-4">{t("aiqFallbackNoData", lang)}</p>
      )}

      <div className="space-y-3">
        {rows.map((row: any) =>
          editId === row.module ? (
            <FallbackForm
              key={row.module}
              module={row.module}
              initial={row}
              lang={lang}
              onSave={() => { setEditId(null); reload(); }}
              onCancel={() => setEditId(null)}
              onErr={setErr}
            />
          ) : (
            <div key={row.module} className={`rounded border p-3 text-xs ${row.enabled ? "border-zinc-200 dark:border-zinc-800" : "border-zinc-300 dark:border-zinc-700 opacity-60"}`}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">{row.module}</span>
                  {!row.enabled && <span className="ml-2 text-zinc-500">(disabled)</span>}
                </div>
                {canEngineer && (
                  <div className="flex gap-2">
                    <button className="text-zinc-500 hover:text-zinc-300" onClick={() => setEditId(row.module)}><Pencil size={12} /></button>
                    <button className="text-red-400 hover:text-red-300" onClick={() => deletePolicy(row.module)}><Trash2 size={12} /></button>
                  </div>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-zinc-500 sm:grid-cols-3">
                <div>{t("aiqFallbackPrimary", lang)}: <span className="text-zinc-300 font-mono">{row.primaryModel}</span></div>
                <div>{t("aiqFallbackModel", lang)}: <span className="text-zinc-300 font-mono">{row.fallbackModel}</span></div>
                <div>{t("aiqFallbackKind", lang)}: <span className="text-zinc-300">{row.fallbackKind}</span></div>
                <div>
                  {t("aiqFallbackTriggers", lang)}: <span className="text-zinc-300">
                    {[row.triggerOnError && "error", row.triggerOnTimeout && "timeout", row.triggerOnHighCost && "high-cost", row.triggerOnLowQuality && "low-quality"].filter(Boolean).join(", ") || "none"}
                  </span>
                </div>
                {row.timeoutMs && <div>timeout: <span className="text-zinc-300">{row.timeoutMs} ms</span></div>}
                {row.costThresholdUsd && <div>cost &gt; <span className="text-zinc-300">${row.costThresholdUsd}</span></div>}
                {row.qualityThreshold && <div>quality &lt; <span className="text-zinc-300">{row.qualityThreshold}</span></div>}
              </div>
              {row.notes && <div className="mt-1 text-zinc-500">{row.notes}</div>}
            </div>
          )
        )}

        {showAdd && (
          <FallbackForm
            module={addModule}
            initial={null}
            lang={lang}
            onSave={() => { setShowAdd(false); reload(); }}
            onCancel={() => setShowAdd(false)}
            onErr={setErr}
          />
        )}
      </div>

      {canEngineer && !showAdd && availableModules.length > 0 && (
        <div className="mt-4 flex items-center gap-2 text-xs">
          <span className="text-zinc-500">{t("aiqFallbackAddFor", lang)}</span>
          <select
            className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
            value={addModule}
            onChange={(e) => setAddModule(e.target.value)}
          >
            {availableModules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button
            className="inline-flex items-center gap-1 rounded bg-indigo-600 text-white px-3 py-1 hover:bg-indigo-500"
            onClick={() => setShowAdd(true)}
          >
            <Plus size={12} /> Add
          </button>
        </div>
      )}
    </Card>
  );
}

function FallbackForm({
  module,
  initial,
  lang,
  onSave,
  onCancel,
  onErr,
}: {
  module: string;
  initial: any;
  lang: Lang;
  onSave: () => void;
  onCancel: () => void;
  onErr: (s: string | null) => void;
}) {
  const [form, setForm] = useState({
    primaryModel: initial?.primaryModel ?? "",
    fallbackModel: initial?.fallbackModel ?? "",
    fallbackKind: initial?.fallbackKind ?? "CHEAP_MODEL",
    triggerOnError: initial?.triggerOnError ?? true,
    triggerOnTimeout: initial?.triggerOnTimeout ?? false,
    triggerOnHighCost: initial?.triggerOnHighCost ?? false,
    triggerOnLowQuality: initial?.triggerOnLowQuality ?? false,
    maxRetries: initial?.maxRetries ?? 1,
    timeoutMs: initial?.timeoutMs ?? "",
    costThresholdUsd: initial?.costThresholdUsd ?? "",
    qualityThreshold: initial?.qualityThreshold ?? "",
    enabled: initial?.enabled ?? true,
    notes: initial?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!form.primaryModel || !form.fallbackModel) {
      onErr("primaryModel and fallbackModel are required");
      return;
    }
    setBusy(true);
    onErr(null);
    try {
      await fetch(`/api/ai-quality/fallback/${module}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          maxRetries: Number(form.maxRetries),
          timeoutMs: form.timeoutMs ? Number(form.timeoutMs) : null,
          costThresholdUsd: form.costThresholdUsd ? Number(form.costThresholdUsd) : null,
          qualityThreshold: form.qualityThreshold ? Number(form.qualityThreshold) : null,
        }),
      });
      onSave();
    } catch (e) {
      onErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-indigo-500/40 bg-indigo-600/5 p-4 space-y-3 text-xs">
      <div className="font-semibold text-sm">{module}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          {t("aiqFallbackPrimary", lang)}
          <input className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 font-mono" value={form.primaryModel} onChange={(e) => setForm({ ...form, primaryModel: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          {t("aiqFallbackModel", lang)}
          <input className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 font-mono" value={form.fallbackModel} onChange={(e) => setForm({ ...form, fallbackModel: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          {t("aiqFallbackKind", lang)}
          <select className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" value={form.fallbackKind} onChange={(e) => setForm({ ...form, fallbackKind: e.target.value })}>
            {FALLBACK_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {t("aiqFallbackMaxRetries", lang)}
          <input type="number" min={1} max={5} className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          {t("aiqFallbackTimeout", lang)}
          <input type="number" className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          {t("aiqFallbackCostThresh", lang)}
          <input type="number" step="0.001" className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" value={form.costThresholdUsd} onChange={(e) => setForm({ ...form, costThresholdUsd: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1">
          {t("aiqFallbackQualThresh", lang)}
          <input type="number" step="0.01" min="0" max="1" className="bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" value={form.qualityThreshold} onChange={(e) => setForm({ ...form, qualityThreshold: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap gap-4">
        {[
          ["triggerOnError", "on error"],
          ["triggerOnTimeout", "on timeout"],
          ["triggerOnHighCost", "on high cost"],
          ["triggerOnLowQuality", "on low quality"],
          ["enabled", "enabled"],
        ].map(([k, label]) => (
          <label key={k} className="flex items-center gap-1 cursor-pointer text-zinc-400">
            <input type="checkbox" checked={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
      </div>
      <input className="w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1" placeholder={t("aiqPromptNotes", lang)} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      <div className="flex gap-2">
        <button disabled={busy} onClick={save} className="rounded bg-indigo-600 text-white px-3 py-1 hover:bg-indigo-500 disabled:opacity-50 inline-flex items-center gap-1"><Check size={12} /> {t("aiqSave", lang)}</button>
        <button onClick={onCancel} className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 inline-flex items-center gap-1"><X size={12} /></button>
      </div>
    </div>
  );
}
