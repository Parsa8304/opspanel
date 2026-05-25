"use client";
import { useState, useMemo } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
  Legend,
} from "recharts";
import {
  Gauge,
  Play,
  Hammer,
  Server,
  DollarSign,
  Settings as SettingsIcon,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
} from "lucide-react";

type Lang = "en" | "fa";

function fmtBytes(n: number | null | undefined) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function StatTile({
  label,
  value,
  prev,
  lang,
  /** lower value is better (regression = went up) */
  lowerBetter = true,
  fmt = (v: number) => String(v),
}: {
  label: string;
  value: number | null | undefined;
  prev?: number | null;
  lang: Lang;
  lowerBetter?: boolean;
  fmt?: (v: number) => string;
}) {
  let delta: { up: boolean; bad: boolean; txt: string } | null = null;
  if (value != null && prev != null && prev !== value) {
    const up = value > prev;
    const bad = lowerBetter ? up : !up;
    delta = {
      up,
      bad,
      txt: `${up ? "+" : ""}${fmt(Math.round((value - prev) * 100) / 100)}`,
    };
  }
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">
        {value == null ? (
          <span className="text-sm text-zinc-400">
            {t("benchNotMeasured", lang)}
          </span>
        ) : (
          fmt(value)
        )}
      </div>
      {delta && (
        <div
          className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${
            delta.bad
              ? "text-red-500"
              : "text-emerald-500"
          }`}
        >
          {delta.up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {delta.txt}{" "}
          {delta.bad ? t("benchRegression", lang) : t("benchImproved", lang)}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const { lang } = useUI();
  const [tab, setTab] = useState<"code" | "api" | "ai" | "config">("code");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [aiDays, setAiDays] = useState(30);

  const { data: me } = useSWR("/api/auth/me", fetcher);
  const isEng =
    me?.role === "ENGINEER" || me?.role === "ADMIN";

  const { data: codeRes, mutate: mutCode } = useSWR(
    "/api/benchmarks/code?limit=200",
    fetcher
  );
  const { data: apiRes, mutate: mutApi } = useSWR(
    "/api/benchmarks/api",
    fetcher
  );
  const { data: aiRes } = useSWR(
    `/api/benchmarks/ai?days=${aiDays}`,
    fetcher
  );
  const { data: cfg, mutate: mutCfg } = useSWR(
    "/api/benchmarks/config",
    fetcher
  );

  const codeRows: any[] = codeRes?.rows || [];
  const codeChart = useMemo(
    () =>
      codeRows.map((r) => ({
        t: new Date(r.createdAt).getTime(),
        label: fmtDate(r.createdAt, lang),
        loc: r.loc,
        cyclomatic: r.cyclomatic,
        duplicationPct: r.duplicationPct,
        lintWarnings: r.lintWarnings,
        typeErrors: r.typeErrors,
        buildTimeMs: r.buildTimeMs,
        bundleKB: r.bundleBytes != null ? Math.round(r.bundleBytes / 1024) : null,
      })),
    [codeRows, lang]
  );
  const lastCode = codeRows[codeRows.length - 1];
  const prevCode = codeRows[codeRows.length - 2];
  const lastBuild = [...codeRows].reverse().find((r) => r.buildTimeMs != null);
  const prevBuild = [...codeRows]
    .reverse()
    .filter((r) => r.buildTimeMs != null)[1];

  const apiRows: any[] = apiRes?.rows || [];
  const apiEndpoints: string[] = apiRes?.endpoints || [];
  const apiByEndpoint = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of apiRows) {
      const list = m.get(r.endpoint) || [];
      list.push(r);
      m.set(r.endpoint, list);
    }
    return m;
  }, [apiRows]);

  const aiAgg: any[] = aiRes?.agg || [];
  const aiRows: any[] = aiRes?.rows || [];
  const aiChart = useMemo(() => {
    const byDay = new Map<string, any>();
    for (const r of aiRows) {
      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      const e = byDay.get(day) || { day, costUsd: 0 };
      e.costUsd += r.costUsd;
      byDay.set(day, e);
    }
    return Array.from(byDay.values())
      .map((e) => ({ ...e, costUsd: Math.round(e.costUsd * 1e6) / 1e6 }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [aiRows]);

  async function post(url: string, body?: any) {
    setMsg(null);
    setBusy(url);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `${t("benchFailed", lang)}`);
      setMsg(t("benchDone", lang));
      return j;
    } catch (e: any) {
      setMsg(e?.message || t("benchFailed", lang));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const tabs: { key: typeof tab; label: string; icon: any }[] = [
    { key: "code", label: t("benchTabCode", lang), icon: Gauge },
    { key: "api", label: t("benchTabApi", lang), icon: Server },
    { key: "ai", label: t("benchTabAi", lang), icon: DollarSign },
    { key: "config", label: t("benchTabConfig", lang), icon: SettingsIcon },
  ];

  return (
    <div>
      <PageHeader title={t("benchTitle", lang)} desc={t("benchDesc", lang)} />

      <div className="px-6 pt-4 flex flex-wrap items-center gap-2">
        {tabs.map((tb) => {
          const Icon = tb.icon;
          return (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm border ${
                tab === tb.key
                  ? "bg-[#183661] text-white border-[#183661]"
                  : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              <Icon size={14} />
              {tb.label}
            </button>
          );
        })}
        {msg && (
          <span className="text-xs text-zinc-500 ms-auto">{msg}</span>
        )}
      </div>

      {/* CODE QUALITY */}
      {tab === "code" && (
        <div className="p-6 space-y-6">
          {isEng && (
            <div className="flex flex-wrap gap-2">
              <button
                disabled={!!busy}
                onClick={async () => {
                  await post("/api/benchmarks/code/analyze");
                  mutCode();
                }}
                className="inline-flex items-center gap-2 rounded bg-[#183661] text-white px-3 py-1.5 text-sm disabled:opacity-50"
              >
                <Play size={14} />
                {busy === "/api/benchmarks/code/analyze"
                  ? t("benchRunning", lang)
                  : t("benchRunAnalysis", lang)}
              </button>
              <button
                disabled={!!busy}
                onClick={async () => {
                  await post("/api/benchmarks/build");
                  mutCode();
                }}
                className="inline-flex items-center gap-2 rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50"
              >
                <Hammer size={14} />
                {busy === "/api/benchmarks/build"
                  ? t("benchRunning", lang)
                  : t("benchRunBuild", lang)}
              </button>
            </div>
          )}

          {codeRows.length === 0 ? (
            <EmptyState msg={t("benchNoCode", lang)} />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatTile
                  label={t("benchLoc", lang)}
                  value={lastCode?.loc}
                  prev={prevCode?.loc}
                  lang={lang}
                  lowerBetter={false}
                  fmt={(v) => v.toLocaleString()}
                />
                <StatTile
                  label={t("benchCyclomatic", lang)}
                  value={lastCode?.cyclomatic}
                  prev={prevCode?.cyclomatic}
                  lang={lang}
                />
                <StatTile
                  label={t("benchDuplication", lang)}
                  value={lastCode?.duplicationPct}
                  prev={prevCode?.duplicationPct}
                  lang={lang}
                  fmt={(v) => `${v}%`}
                />
                <StatTile
                  label={t("benchLint", lang)}
                  value={lastCode?.lintWarnings}
                  prev={prevCode?.lintWarnings}
                  lang={lang}
                />
                <StatTile
                  label={t("benchTypeErrors", lang)}
                  value={lastCode?.typeErrors}
                  prev={prevCode?.typeErrors}
                  lang={lang}
                />
                <StatTile
                  label={t("benchBuildTime", lang)}
                  value={lastBuild?.buildTimeMs}
                  prev={prevBuild?.buildTimeMs}
                  lang={lang}
                  fmt={(v) => `${v.toLocaleString()} ms`}
                />
                <StatTile
                  label={t("benchBundle", lang)}
                  value={lastBuild?.bundleBytes}
                  prev={prevBuild?.bundleBytes}
                  lang={lang}
                  fmt={(v) => fmtBytes(v)}
                />
              </div>

              <p className="text-xs text-zinc-500">
                {t("benchApproxNote", lang)}
              </p>

              <div>
                <h3 className="text-sm font-medium mb-2">
                  {t("benchCodeTrend", lang)}
                </h3>
                <div className="h-72 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <ResponsiveContainer>
                    <LineChart data={codeChart}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="loc"
                        name={t("benchLoc", lang)}
                        stroke="#10b981"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="cyclomatic"
                        name={t("benchCyclomatic", lang)}
                        stroke="#6366f1"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="duplicationPct"
                        name={t("benchDuplication", lang)}
                        stroke="#f59e0b"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="lintWarnings"
                        name={t("benchLint", lang)}
                        stroke="#ef4444"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="typeErrors"
                        name={t("benchTypeErrors", lang)}
                        stroke="#ec4899"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium mb-2">
                  {t("benchBuildTrend", lang)}
                </h3>
                <div className="h-64 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <ResponsiveContainer>
                    <LineChart data={codeChart.filter((c) => c.buildTimeMs != null)}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis yAxisId="l" tick={{ fontSize: 10 }} />
                      <YAxis
                        yAxisId="r"
                        orientation="right"
                        tick={{ fontSize: 10 }}
                      />
                      <Tooltip />
                      <Legend />
                      <Line
                        yAxisId="l"
                        type="monotone"
                        dataKey="buildTimeMs"
                        name={t("benchBuildTime", lang)}
                        stroke="#10b981"
                        dot={false}
                      />
                      <Line
                        yAxisId="r"
                        type="monotone"
                        dataKey="bundleKB"
                        name={`${t("benchBundle", lang)} (KB)`}
                        stroke="#6366f1"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* API LATENCY */}
      {tab === "api" && (
        <div className="p-6 space-y-6">
          {isEng && (
            <button
              disabled={!!busy}
              onClick={async () => {
                await post("/api/benchmarks/api/run", { n: 20 });
                mutApi();
              }}
              className="inline-flex items-center gap-2 rounded bg-[#183661] text-white px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <Play size={14} />
              {busy === "/api/benchmarks/api/run"
                ? t("benchRunning", lang)
                : t("benchRunApi", lang)}
            </button>
          )}

          {apiRows.length === 0 ? (
            <EmptyState msg={t("benchNoApi", lang)} />
          ) : (
            apiEndpoints.map((ep) => {
              const rows = (apiByEndpoint.get(ep) || []).map((r) => ({
                label: fmtDate(r.createdAt, lang),
                p50Ms: r.p50Ms,
                p95Ms: r.p95Ms,
                p99Ms: r.p99Ms,
              }));
              const latest = (apiByEndpoint.get(ep) || []).slice(-1)[0];
              return (
                <div
                  key={ep}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium break-all">{ep}</h3>
                    <span className="text-xs text-zinc-500">
                      p50 {latest?.p50Ms}ms · p95 {latest?.p95Ms}ms · p99{" "}
                      {latest?.p99Ms}ms
                    </span>
                  </div>
                  <div className="h-56">
                    <ResponsiveContainer>
                      <LineChart data={rows}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="p50Ms"
                          stroke="#10b981"
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="p95Ms"
                          stroke="#f59e0b"
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="p99Ms"
                          stroke="#ef4444"
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <table className="w-full text-xs mt-3">
                    <thead className="text-zinc-500 text-start">
                      <tr>
                        <th className="text-start py-1">{t("colDate", lang)}</th>
                        <th className="text-start py-1">p50</th>
                        <th className="text-start py-1">p95</th>
                        <th className="text-start py-1">p99</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(apiByEndpoint.get(ep) || [])
                        .slice(-8)
                        .reverse()
                        .map((r) => (
                          <tr
                            key={r.id}
                            className="border-t border-zinc-100 dark:border-zinc-800"
                          >
                            <td className="py-1">
                              {fmtDate(r.createdAt, lang)}
                            </td>
                            <td className="py-1">{r.p50Ms}</td>
                            <td className="py-1">{r.p95Ms}</td>
                            <td className="py-1">{r.p99Ms}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* AI COST */}
      {tab === "ai" && (
        <div className="p-6 space-y-6">
          <div className="flex items-center gap-2 text-sm">
            <label className="text-zinc-500">
              {t("benchWindowDays", lang)}
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={aiDays}
              onChange={(e) =>
                setAiDays(Math.max(1, Number(e.target.value) || 30))
              }
              className="w-20 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </div>

          {aiAgg.length === 0 ? (
            <EmptyState msg={t("benchNoAi", lang)} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-500">
                    <tr>
                      <th className="text-start p-2">
                        {t("benchAiModule", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiRuns", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiTokensIn", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiTokensOut", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiCost", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiCostPerRun", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiAvgLat", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiP95Lat", lang)}
                      </th>
                      <th className="text-start p-2">
                        {t("benchAiModels", lang)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiAgg.map((a) => (
                      <tr
                        key={a.module}
                        className="border-t border-zinc-100 dark:border-zinc-800"
                      >
                        <td className="p-2 font-medium">{a.module}</td>
                        <td className="p-2">{a.runs}</td>
                        <td className="p-2">
                          {a.tokensIn.toLocaleString()}
                        </td>
                        <td className="p-2">
                          {a.tokensOut.toLocaleString()}
                        </td>
                        <td className="p-2">${a.costUsd}</td>
                        <td className="p-2">${a.costPerRun}</td>
                        <td className="p-2">
                          {a.avgLatencyMs == null
                            ? "—"
                            : `${a.avgLatencyMs} ms`}
                        </td>
                        <td className="p-2">
                          {a.p95LatencyMs == null
                            ? "—"
                            : `${a.p95LatencyMs} ms`}
                        </td>
                        <td className="p-2 text-xs text-zinc-500">
                          {a.models.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="text-sm font-medium mb-2">
                  {t("benchAiCostTrend", lang)}
                </h3>
                <div className="h-64 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <ResponsiveContainer>
                    <LineChart data={aiChart}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="costUsd"
                        name={t("benchAiCost", lang)}
                        stroke="#10b981"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* CONFIG */}
      {tab === "config" && (
        <div className="p-6 max-w-2xl">
          {!cfg ? (
            <EmptyState msg={t("loading", lang)} />
          ) : (
            <ConfigEditor
              cfg={cfg}
              lang={lang}
              isEng={isEng}
              onSave={async (next) => {
                setMsg(null);
                const r = await fetch("/api/benchmarks/config", {
                  method: "PUT",
                  credentials: "include",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(next),
                });
                if (r.ok) {
                  setMsg(t("savedCfg", lang));
                  mutCfg();
                } else {
                  const j = await r.json().catch(() => ({}));
                  setMsg(j?.error || t("benchFailed", lang));
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ConfigEditor({
  cfg,
  lang,
  isEng,
  onSave,
}: {
  cfg: any;
  lang: Lang;
  isEng: boolean;
  onSave: (next: any) => Promise<void>;
}) {
  const [targetDir, setTargetDir] = useState(cfg.targetDir || "");
  const [buildCmd, setBuildCmd] = useState(cfg.buildCmd || "");
  const [endpoints, setEndpoints] = useState<{ name: string; url: string }[]>(
    cfg.endpoints || []
  );

  if (!isEng) {
    return (
      <div className="space-y-3 text-sm">
        <div className="text-xs text-zinc-500">
          {t("forbiddenAction", lang)}
        </div>
        <div>
          <span className="text-zinc-500">{t("benchTargetDir", lang)}:</span>{" "}
          {cfg.targetDir}
        </div>
        <div>
          <span className="text-zinc-500">{t("benchBuildCmd", lang)}:</span>{" "}
          {cfg.buildCmd}
        </div>
        <div>
          <span className="text-zinc-500">{t("benchEndpoints", lang)}:</span>
          <ul className="list-disc ms-5">
            {(cfg.endpoints || []).map((e: any, i: number) => (
              <li key={i}>
                {e.name} — {e.url}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <div>
        <label className="block text-xs text-zinc-500 mb-1">
          {t("benchTargetDir", lang)}
        </label>
        <input
          value={targetDir}
          onChange={(e) => setTargetDir(e.target.value)}
          className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-500 mb-1">
          {t("benchBuildCmd", lang)}
        </label>
        <input
          value={buildCmd}
          onChange={(e) => setBuildCmd(e.target.value)}
          className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2"
        />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-zinc-500">
            {t("benchEndpoints", lang)}
          </label>
          <button
            onClick={() =>
              setEndpoints([...endpoints, { name: "", url: "" }])
            }
            className="inline-flex items-center gap-1 text-xs text-emerald-500"
          >
            <Plus size={12} />
            {t("benchAddEndpoint", lang)}
          </button>
        </div>
        <div className="space-y-2">
          {endpoints.map((ep, i) => (
            <div key={i} className="flex gap-2">
              <input
                placeholder={t("benchEpName", lang)}
                value={ep.name}
                onChange={(e) => {
                  const next = [...endpoints];
                  next[i] = { ...next[i], name: e.target.value };
                  setEndpoints(next);
                }}
                className="w-1/3 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5"
              />
              <input
                placeholder={t("benchEpUrl", lang)}
                value={ep.url}
                onChange={(e) => {
                  const next = [...endpoints];
                  next[i] = { ...next[i], url: e.target.value };
                  setEndpoints(next);
                }}
                className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5"
              />
              <button
                onClick={() =>
                  setEndpoints(endpoints.filter((_, j) => j !== i))
                }
                className="text-red-500"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <button
        onClick={() =>
          onSave({
            targetDir,
            buildCmd,
            endpoints: endpoints.filter((e) => e.name && e.url),
          })
        }
        className="rounded bg-[#183661] text-white px-4 py-2"
      >
        {t("saveCfg", lang)}
      </button>
    </div>
  );
}
