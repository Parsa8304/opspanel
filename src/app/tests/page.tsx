"use client";
import { useState, useMemo } from "react";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  BarChart,
  Bar,
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
  Activity,
  Upload,
  GitBranch,
  Workflow,
  Zap,
  Gauge,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
} from "lucide-react";

type Lang = "en" | "fa";

const TYPES = ["UNIT", "INTEGRATION", "API", "FRONTEND", "WORKER", "E2E"] as const;
const STATUSES = ["PASSED", "FAILED", "SKIPPED"] as const;

async function api(url: string, method: string, body?: unknown, raw?: boolean) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: raw
      ? { "Content-Type": "application/xml" }
      : { "Content-Type": "application/json" },
    body: raw ? (body as string) : body ? JSON.stringify(body) : undefined,
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
    <section className="mx-6 my-6 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 text-sm font-semibold">
        <div className="flex items-center gap-2">
          {icon}
          {title}
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function rateColor(rate: number | null): string {
  if (rate === null) return "#52525b";
  // green (120) -> red (0)
  const hue = Math.round(120 * rate);
  return `hsl(${hue} 70% 42%)`;
}

export default function Page() {
  const { lang } = useUI();
  const L = lang as Lang;

  const [filters, setFilters] = useState({
    type: "",
    status: "",
    commit: "",
    from: "",
    to: "",
  });
  const [applied, setApplied] = useState(filters);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [caseFilter, setCaseFilter] = useState({ type: "", status: "" });
  const [expandedCase, setExpandedCase] = useState<Record<string, boolean>>({});
  const [xml, setXml] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [covModule, setCovModule] = useState("");
  const [covForm, setCovForm] = useState({ module: "", linesPct: "", commitSha: "" });
  const [ciForm, setCiForm] = useState<any>(null);

  const qs = new URLSearchParams();
  if (applied.type) qs.set("type", applied.type);
  if (applied.status) qs.set("status", applied.status);
  if (applied.commit) qs.set("commit", applied.commit);
  if (applied.from) qs.set("from", applied.from);
  if (applied.to) qs.set("to", applied.to);
  const qStr = qs.toString();

  const { data: runsRes, mutate: mutRuns } = useSWR(
    `/api/tests/runs${qStr ? "?" + qStr : ""}`,
    fetcher
  );
  const { data: flowRes, mutate: mutFlow } = useSWR(
    "/api/tests/flow",
    fetcher
  );
  const { data: flakyRes, mutate: mutFlaky } = useSWR(
    "/api/tests/flaky",
    fetcher
  );
  const { data: covRes, mutate: mutCov } = useSWR(
    `/api/tests/coverage${covModule ? "?module=" + encodeURIComponent(covModule) : ""}`,
    fetcher
  );
  const { data: ciCfg, mutate: mutCi } = useSWR(
    "/api/tests/ci/config",
    fetcher
  );
  const { data: runDetail } = useSWR(
    openRun ? `/api/tests/runs/${openRun}` : null,
    fetcher
  );

  const runs = runsRes?.runs || [];
  const daily = runsRes?.daily || [];
  const flow = flowRes?.nodes || [];
  const flaky = flakyRes?.flaky || [];
  const covPoints = covRes?.points || [];
  const covModules: string[] = covRes?.modules || [];

  const ciForm2 = ciForm ?? ciCfg ?? { type: "none" };

  // Pivot coverage into recharts series keyed by date, one line per module.
  const covChart = useMemo(() => {
    const byDate = new Map<string, any>();
    for (const p of covPoints) {
      const d = new Date(p.createdAt).toISOString().slice(0, 10);
      const row = byDate.get(d) || { date: d };
      row[p.module] = p.linesPct;
      byDate.set(d, row);
    }
    return Array.from(byDate.values()).sort((a, b) =>
      a.date < b.date ? -1 : 1
    );
  }, [covPoints]);
  const covSeries = useMemo(() => {
    const seen: string[] = [];
    for (const p of covPoints as any[])
      if (!seen.includes(p.module)) seen.push(p.module);
    return seen;
  }, [covPoints]);

  const doIngest = async () => {
    setErr("");
    setMsg("");
    try {
      const res = await api("/api/tests/ingest", "POST", xml, true);
      setMsg(
        `${t("ingested", L)}: ${res.total} (${res.passed}/${res.failed}/${res.skipped})`
      );
      setXml("");
      mutRuns();
      mutFlow();
      mutFlaky();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const onFile = (f: File | null) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setXml(String(r.result || ""));
    r.readAsText(f);
  };

  const pullCi = async () => {
    setErr("");
    setMsg("");
    try {
      const res = await api("/api/tests/ci/pull", "POST");
      setMsg(`${t("ingested", L)}: ${res.total}`);
      mutRuns();
      mutFlow();
      mutFlaky();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveCi = async () => {
    setErr("");
    try {
      await api("/api/tests/ci/config", "PUT", {
        type: ciForm2.type || "none",
        url: ciForm2.url || null,
        token: ciForm2.token || null,
      });
      setCiForm(null);
      mutCi();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const recordCoverage = async () => {
    setErr("");
    try {
      await api("/api/tests/coverage", "POST", {
        module: covForm.module,
        linesPct: parseFloat(covForm.linesPct),
        commitSha: covForm.commitSha || null,
      });
      setCovForm({ module: "", linesPct: "", commitSha: "" });
      mutCov();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const filteredCases = (runDetail?.cases || []).filter(
    (c: any) =>
      (!caseFilter.type || c.type === caseFilter.type) &&
      (!caseFilter.status || c.status === caseFilter.status)
  );

  const noRuns = runs.length === 0;

  return (
    <div className="pb-10">
      <PageHeader title={t("testLogs", L)} desc={t("testLogsDesc", L)} />

      {err && (
        <div className="mx-6 mt-4 rounded border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-500">
          {err}
        </div>
      )}
      {msg && (
        <div className="mx-6 mt-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-500">
          {msg}
        </div>
      )}

      {/* Filters */}
      <Section
        title={t("applyFilters", L)}
        icon={<GitBranch size={16} className="text-emerald-500" />}
      >
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("type", L)}</span>
            <select
              value={filters.type}
              onChange={(e) =>
                setFilters({ ...filters, type: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="" className="dark:bg-zinc-900">
                {t("filterType", L)}
              </option>
              {TYPES.map((x) => (
                <option key={x} value={x} className="dark:bg-zinc-900">
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("colStatus", L)}</span>
            <select
              value={filters.status}
              onChange={(e) =>
                setFilters({ ...filters, status: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="" className="dark:bg-zinc-900">
                {t("filterStatus", L)}
              </option>
              {STATUSES.map((x) => (
                <option key={x} value={x} className="dark:bg-zinc-900">
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("commitRange", L)}</span>
            <input
              value={filters.commit}
              onChange={(e) =>
                setFilters({ ...filters, commit: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("fromDate", L)}</span>
            <input
              type="date"
              value={filters.from}
              onChange={(e) =>
                setFilters({ ...filters, from: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("toDate", L)}</span>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <div className="flex items-end">
            <button
              onClick={() => setApplied({ ...filters })}
              className="rounded bg-[#183661] px-3 py-1.5 text-white hover:bg-[#1e478e]"
            >
              {t("applyFilters", L)}
            </button>
          </div>
        </div>
      </Section>

      {/* Runs over time */}
      <Section
        title={t("runsOverTime", L)}
        icon={<Activity size={16} className="text-emerald-500" />}
      >
        {daily.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noRuns", L)}</p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer>
              <BarChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="passed" stackId="a" fill="#10b981" />
                <Bar dataKey="failed" stackId="a" fill="#ef4444" />
                <Bar dataKey="skipped" stackId="a" fill="#a1a1aa" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Section>

      {/* Runs table or run detail */}
      {openRun && runDetail ? (
        <Section
          title={`${t("runDetail", L)} · ${runDetail.commitSha?.slice(0, 8) || runDetail.source}`}
          icon={<Activity size={16} className="text-emerald-500" />}
          right={
            <button
              onClick={() => setOpenRun(null)}
              className="text-xs text-emerald-500 hover:underline"
            >
              {t("backToRuns", L)}
            </button>
          }
        >
          <div className="mb-3 flex flex-wrap gap-3 text-sm">
            <select
              value={caseFilter.type}
              onChange={(e) =>
                setCaseFilter({ ...caseFilter, type: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="" className="dark:bg-zinc-900">
                {t("filterType", L)}
              </option>
              {TYPES.map((x) => (
                <option key={x} value={x} className="dark:bg-zinc-900">
                  {x}
                </option>
              ))}
            </select>
            <select
              value={caseFilter.status}
              onChange={(e) =>
                setCaseFilter({ ...caseFilter, status: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="" className="dark:bg-zinc-900">
                {t("filterStatus", L)}
              </option>
              {STATUSES.map((x) => (
                <option key={x} value={x} className="dark:bg-zinc-900">
                  {x}
                </option>
              ))}
            </select>
          </div>
          {filteredCases.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("noTestCases", L)}</p>
          ) : (
            <ul className="space-y-1">
              {filteredCases.map((c: any) => {
                const open = expandedCase[c.id];
                const color =
                  c.status === "PASSED"
                    ? "text-emerald-500"
                    : c.status === "FAILED"
                    ? "text-red-500"
                    : "text-zinc-400";
                return (
                  <li
                    key={c.id}
                    className="rounded border border-zinc-200 dark:border-zinc-800 p-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-mono text-xs ${color}`}>
                        {c.status}
                      </span>
                      <span className="rounded bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 text-xs">
                        {c.type}
                      </span>
                      {c.classname && (
                        <span className="text-zinc-500 text-xs">
                          {c.classname}
                        </span>
                      )}
                      <span className="font-medium">{c.name}</span>
                      <span className="text-zinc-500 text-xs">
                        {c.durationMs} ms
                      </span>
                      {c.status === "FAILED" &&
                        (c.failureMessage || c.failureTrace) && (
                          <button
                            onClick={() =>
                              setExpandedCase((s) => ({
                                ...s,
                                [c.id]: !s[c.id],
                              }))
                            }
                            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                          >
                            {open ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronRight size={14} />
                            )}
                            {open ? t("hideTrace", L) : t("showTrace", L)}
                          </button>
                        )}
                    </div>
                    {open && (
                      <div className="mt-2">
                        {c.failureMessage && (
                          <p className="text-xs text-red-400">
                            {c.failureMessage}
                          </p>
                        )}
                        {c.failureTrace && (
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 dark:bg-zinc-800/60 p-2 font-mono text-xs">
                            {c.failureTrace}
                          </pre>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      ) : (
        <Section
          title={t("testRunsTable", L)}
          icon={<Activity size={16} className="text-emerald-500" />}
        >
          {noRuns ? (
            <p className="text-sm text-zinc-500">{t("noRuns", L)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-200 dark:border-zinc-800">
                    <th className="py-2 text-start">{t("colCommit", L)}</th>
                    <th className="py-2 text-start">{t("colSource", L)}</th>
                    <th className="py-2 text-start">{t("colTotal", L)}</th>
                    <th className="py-2 text-start">{t("colPassed", L)}</th>
                    <th className="py-2 text-start">{t("colFailed", L)}</th>
                    <th className="py-2 text-start">{t("colSkipped", L)}</th>
                    <th className="py-2 text-start">{t("colDuration", L)}</th>
                    <th className="py-2 text-start">{t("colStarted", L)}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r: any) => (
                    <tr
                      key={r.id}
                      onClick={() => {
                        setOpenRun(r.id);
                        setCaseFilter({ type: "", status: "" });
                      }}
                      className="cursor-pointer border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                    >
                      <td className="py-2 font-mono text-xs">
                        {r.commitSha ? r.commitSha.slice(0, 8) : "—"}
                      </td>
                      <td className="py-2">{r.source}</td>
                      <td className="py-2">{r.total}</td>
                      <td className="py-2 text-emerald-500">{r.passed}</td>
                      <td className="py-2 text-red-500">{r.failed}</td>
                      <td className="py-2 text-zinc-400">{r.skipped}</td>
                      <td className="py-2">{r.durationMs} ms</td>
                      <td className="py-2">{fmtDate(r.startedAt, L)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* Test flow */}
      <Section
        title={t("testFlow", L)}
        icon={<Workflow size={16} className="text-emerald-500" />}
      >
        {flow.every((n: any) => n.total === 0) ? (
          <p className="text-sm text-zinc-500">{t("noFlowData", L)}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {flow.map((n: any, i: number) => (
              <div key={n.type} className="flex items-center gap-3">
                <div
                  className="min-w-[140px] rounded-lg border p-3 text-center"
                  style={{
                    borderColor: rateColor(n.passRate),
                    background:
                      n.total > 0
                        ? `${rateColor(n.passRate)}22`
                        : "transparent",
                  }}
                >
                  <div className="text-xs font-semibold text-zinc-500">
                    {n.type}
                  </div>
                  <div
                    className="my-1 text-2xl font-bold"
                    style={{ color: rateColor(n.passRate) }}
                  >
                    {n.passRate === null
                      ? "—"
                      : `${Math.round(n.passRate * 100)}%`}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {n.passed}/{n.total} · {t("passRate", L)}
                  </div>
                </div>
                {i < flow.length - 1 && (
                  <span className="text-zinc-500">›</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Flaky tests */}
      <Section
        title={t("flakyTests", L)}
        icon={<Zap size={16} className="text-emerald-500" />}
      >
        {flaky.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noFlaky", L)}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="py-2 text-start">{t("colCase", L)}</th>
                  <th className="py-2 text-start">{t("colPassed", L)}</th>
                  <th className="py-2 text-start">{t("colFailed", L)}</th>
                  <th className="py-2 text-start">{t("colFlakiness", L)}</th>
                  <th className="py-2 text-start">{t("colLastStatus", L)}</th>
                </tr>
              </thead>
              <tbody>
                {flaky.map((f: any) => (
                  <tr
                    key={f.name}
                    className="border-b border-zinc-100 dark:border-zinc-800/60"
                  >
                    <td className="py-2 font-mono text-xs">{f.name}</td>
                    <td className="py-2 text-emerald-500">{f.passCount}</td>
                    <td className="py-2 text-red-500">{f.failCount}</td>
                    <td className="py-2">
                      {(f.flakiness * 100).toFixed(0)}%
                    </td>
                    <td className="py-2">{f.lastStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Coverage */}
      <Section
        title={t("coverageTrend", L)}
        icon={<Gauge size={16} className="text-emerald-500" />}
        right={
          <select
            value={covModule}
            onChange={(e) => setCovModule(e.target.value)}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs"
          >
            <option value="" className="dark:bg-zinc-900">
              {t("filterModule", L)}
            </option>
            {covModules.map((m) => (
              <option key={m} value={m} className="dark:bg-zinc-900">
                {m}
              </option>
            ))}
          </select>
        }
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <input
            placeholder={t("colModule", L)}
            value={covForm.module}
            onChange={(e) =>
              setCovForm({ ...covForm, module: e.target.value })
            }
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <input
            placeholder="%"
            type="number"
            value={covForm.linesPct}
            onChange={(e) =>
              setCovForm({ ...covForm, linesPct: e.target.value })
            }
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <input
            placeholder={t("colCommit", L)}
            value={covForm.commitSha}
            onChange={(e) =>
              setCovForm({ ...covForm, commitSha: e.target.value })
            }
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
          />
          <button
            onClick={recordCoverage}
            className="rounded bg-[#183661] px-3 py-1 text-white hover:bg-[#1e478e]"
          >
            {t("recordCoverage", L)}
          </button>
        </div>
        {covChart.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noCoverage", L)}</p>
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer>
              <LineChart data={covChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip
                  contentStyle={{
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {covSeries.map((m, i) => (
                  <Line
                    key={m}
                    type="monotone"
                    dataKey={m}
                    stroke={`hsl(${(i * 67) % 360} 65% 50%)`}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Section>

      {/* CI config */}
      <Section
        title={t("ciConfig", L)}
        icon={<SettingsIcon size={16} className="text-emerald-500" />}
      >
        <div className="grid gap-3 sm:grid-cols-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("ciType", L)}</span>
            <select
              value={ciForm2.type || "none"}
              onChange={(e) =>
                setCiForm({ ...ciForm2, type: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="none" className="dark:bg-zinc-900">
                none
              </option>
              <option value="junit_url" className="dark:bg-zinc-900">
                junit_url
              </option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("ciUrl", L)}</span>
            <input
              value={ciForm2.url || ""}
              onChange={(e) =>
                setCiForm({ ...ciForm2, url: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("token", L)}</span>
            <input
              value={ciForm2.token || ""}
              onChange={(e) =>
                setCiForm({ ...ciForm2, token: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            onClick={saveCi}
            className="rounded bg-[#183661] px-3 py-1.5 text-sm text-white hover:bg-[#1e478e]"
          >
            {t("saveCiConfig", L)}
          </button>
          <button
            onClick={pullCi}
            className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {t("pullNow", L)}
          </button>
        </div>
      </Section>

      {/* Ingest */}
      <Section
        title={t("ingestJunit", L)}
        icon={<Upload size={16} className="text-emerald-500" />}
      >
        <p className="mb-2 text-xs text-zinc-500">{t("ingestHint", L)}</p>
        <input
          type="file"
          accept=".xml,text/xml,application/xml"
          onChange={(e) => onFile(e.target.files?.[0] || null)}
          className="mb-3 block text-sm"
        />
        <textarea
          value={xml}
          onChange={(e) => setXml(e.target.value)}
          rows={8}
          placeholder="<testsuites>…</testsuites>"
          className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 font-mono text-xs"
        />
        <button
          onClick={doIngest}
          disabled={!xml.trim()}
          className="mt-3 rounded bg-[#183661] px-3 py-1.5 text-sm text-white hover:bg-[#1e478e] disabled:opacity-50"
        >
          {t("ingest", L)}
        </button>
      </Section>
    </div>
  );
}
