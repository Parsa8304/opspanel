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

const card =
  "rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4";
const inp =
  "rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm";
const btn =
  "rounded bg-[#183661] text-white px-3 py-1 text-sm hover:bg-[#1e478e] disabled:opacity-50";
const tabBtn = (active: boolean) =>
  `px-3 py-1.5 text-sm rounded ${
    active
      ? "bg-[#183661] text-white"
      : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
  }`;

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toFixed(n < 1 ? 4 : 2)}`;

export default function Page() {
  const { lang } = useUI();
  const [tab, setTab] = useState<
    "dashboard" | "trends" | "recon" | "manage"
  >("dashboard");

  return (
    <div>
      <PageHeader title={t("blTitle", lang)} desc={t("blDesc", lang)} />
      <div className="px-6 pt-4 flex gap-2 flex-wrap">
        <button
          className={tabBtn(tab === "dashboard")}
          onClick={() => setTab("dashboard")}
        >
          {t("blTotalSpend", lang)}
        </button>
        <button
          className={tabBtn(tab === "trends")}
          onClick={() => setTab("trends")}
        >
          {t("blTrends", lang)}
        </button>
        <button
          className={tabBtn(tab === "recon")}
          onClick={() => setTab("recon")}
        >
          {t("blRecon", lang)}
        </button>
        <button
          className={tabBtn(tab === "manage")}
          onClick={() => setTab("manage")}
        >
          {t("blConfig", lang)}
        </button>
      </div>
      <div className="p-6 space-y-6">
        {tab === "dashboard" && <Dashboard lang={lang} />}
        {tab === "trends" && <Trends lang={lang} />}
        {tab === "recon" && <Recon lang={lang} />}
        {tab === "manage" && <Manage lang={lang} />}
      </div>
    </div>
  );
}

function rangeFrom(days: number) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}
function monthStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function Dashboard({ lang }: { lang: any }) {
  const [groupBy, setGroupBy] = useState("provider");
  const { data: today } = useSWR(
    `/api/billing/summary?from=${rangeFrom(1)}&groupBy=${groupBy}`,
    fetcher
  );
  const { data: d7 } = useSWR(
    `/api/billing/summary?from=${rangeFrom(7)}&groupBy=${groupBy}`,
    fetcher
  );
  const { data: d30 } = useSWR(
    `/api/billing/summary?from=${rangeFrom(30)}&groupBy=${groupBy}`,
    fetcher
  );
  const { data: mtd } = useSWR(
    `/api/billing/summary?from=${monthStart()}&groupBy=${groupBy}`,
    fetcher
  );
  const { data: budgets } = useSWR("/api/billing/budgets", fetcher);
  const { data: top } = useSWR("/api/billing/top?limit=8", fetcher);
  const { data: anom } = useSWR("/api/billing/anomalies", fetcher);

  const providers = useMemo(() => {
    const set = new Set<string>(["openrouter"]);
    (d30?.rows || []).forEach(
      (r: any) => groupBy === "provider" && set.add(r.key)
    );
    (budgets?.budgets || []).forEach((b: any) => set.add(b.provider));
    return Array.from(set);
  }, [d30, budgets, groupBy]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat lang={lang} label={t("blToday", lang)} d={today} />
        <Stat lang={lang} label={t("bl7d", lang)} d={d7} />
        <Stat lang={lang} label={t("bl30d", lang)} d={d30} />
        <Stat lang={lang} label={t("blMtd", lang)} d={mtd} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {providers.map((p) => (
          <BalanceWidget key={p} lang={lang} provider={p} />
        ))}
      </div>

      <div className={card}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm">{t("blTotalSpend", lang)}</h3>
          <select
            className={inp}
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
          >
            {["provider", "model", "module", "user", "project"].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        {!d30?.rows?.length ? (
          <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-zinc-500 text-start">
              <tr>
                <th className="text-start py-1">{groupBy}</th>
                <th className="text-end">{t("blCost", lang)}</th>
                <th className="text-end">{t("blByok", lang)}</th>
                <th className="text-end">{t("blRequests", lang)}</th>
                <th className="text-end">{t("blFree", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {d30.rows.map((r: any) => (
                <tr
                  key={r.key}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-1">{r.key}</td>
                  <td className="text-end">{usd(r.cost)}</td>
                  <td className="text-end">{usd(r.byokCost)}</td>
                  <td className="text-end">{r.requests}</td>
                  <td className="text-end">{r.freeRequests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={card}>
        <h3 className="font-semibold text-sm mb-3">{t("blBudgets", lang)}</h3>
        {!budgets?.budgets?.length ? (
          <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
        ) : (
          <div className="space-y-3">
            {budgets.budgets.map((b: any) => (
              <BudgetBar key={b.id} b={b} lang={lang} />
            ))}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className={card}>
          <h3 className="font-semibold text-sm mb-3">
            {t("blTopConsumers", lang)}
          </h3>
          {!top ? (
            <p className="text-sm text-zinc-500">{t("loading", lang)}</p>
          ) : (
            <div className="space-y-3 text-sm">
              {(["modules", "users", "projects"] as const).map((k) => (
                <div key={k}>
                  <div className="text-zinc-500 uppercase text-xs mb-1">
                    {k}
                  </div>
                  {(top[k] || []).length === 0 ? (
                    <div className="text-zinc-500">{t("blNone", lang)}</div>
                  ) : (
                    (top[k] || []).map((r: any) => (
                      <div
                        key={r.key}
                        className="flex justify-between border-t border-zinc-100 dark:border-zinc-800 py-0.5"
                      >
                        <span>{r.key}</span>
                        <span>{usd(r.cost)}</span>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={card}>
          <h3 className="font-semibold text-sm mb-3">
            {t("blAnomalies", lang)}
          </h3>
          {!anom?.anomalies?.length ? (
            <p className="text-sm text-zinc-500">
              {t("blNoAnomalies", lang)}
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {anom.anomalies.map((a: any) => (
                  <tr
                    key={a.date}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="py-1">{a.date}</td>
                    <td className="text-end text-amber-600">
                      {usd(a.cost)}
                    </td>
                    <td className="text-end text-zinc-500">
                      &gt; {usd(a.threshold)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Drilldown lang={lang} />
    </div>
  );
}

function Stat({ lang, label, d }: { lang: any; label: string; d: any }) {
  return (
    <div className={card}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">
        {d ? usd(d.total) : "…"}
      </div>
      {d && (
        <div className="text-xs text-zinc-500 mt-1">
          {t("blDirect", lang)} {usd(d.directTotal)} · {t("blByok", lang)}{" "}
          {usd(d.byokTotal)} · {d.requests} {t("blRequests", lang)}
        </div>
      )}
    </div>
  );
}

function BalanceWidget({
  lang,
  provider,
}: {
  lang: any;
  provider: string;
}) {
  const { data } = useSWR(
    `/api/billing/balance?provider=${provider}`,
    fetcher
  );
  return (
    <div className={card}>
      <div className="flex justify-between items-center">
        <h3 className="font-semibold text-sm">
          {t("blBalance", lang)} — {provider}
        </h3>
      </div>
      {!data ? (
        <p className="text-sm text-zinc-500 mt-2">{t("loading", lang)}</p>
      ) : data.ok ? (
        <>
          <div className="text-2xl font-semibold mt-1">
            {usd(data.balance)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {t("blLastPolled", lang)}: {fmtDate(data.at, lang)}{" "}
            {data.cached ? "(cached)" : ""}
          </div>
        </>
      ) : (
        <p className="text-sm text-amber-600 mt-2">
          {data.error?.includes("Management")
            ? t("blBalanceNone", lang)
            : data.error}
        </p>
      )}
    </div>
  );
}

function BudgetBar({ b, lang }: { b: any; lang: any }) {
  const pct = Math.min(100, b.pct);
  const color =
    b.pct >= 100
      ? "bg-red-600"
      : b.pct >= 80
      ? "bg-amber-500"
      : "bg-[#183661]";
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span>
          {b.provider} · {b.period} ·{" "}
          <span className="text-zinc-500">{b.actionOnBreach}</span>
        </span>
        <span>
          {usd(b.spend)} / {usd(b.limitAmount)} ({b.pct}%)
          {b.breached && (
            <span className="ms-2 text-red-600">
              {t("blBudgetBreached", lang)}
            </span>
          )}
        </span>
      </div>
      <div className="relative h-3 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
        <div
          className={`h-full ${color}`}
          style={{ width: `${pct}%` }}
        />
        {(b.thresholds || []).map((th: number) => (
          <div
            key={th}
            className="absolute top-0 h-full w-px bg-zinc-500"
            style={{ left: `${Math.min(100, th)}%` }}
            title={`${th}%`}
          />
        ))}
      </div>
    </div>
  );
}

function Drilldown({ lang }: { lang: any }) {
  const [f, setF] = useState<Record<string, string>>({});
  const qs = new URLSearchParams(
    Object.entries(f).filter(([, v]) => v) as any
  ).toString();
  const { data } = useSWR(
    `/api/billing/events?take=50&${qs}`,
    fetcher
  );
  return (
    <div className={card}>
      <h3 className="font-semibold text-sm mb-3">{t("blDrilldown", lang)}</h3>
      <div className="flex gap-2 flex-wrap mb-3">
        <input
          className={inp}
          placeholder={t("blProvider", lang)}
          onChange={(e) => setF({ ...f, provider: e.target.value })}
        />
        <input
          className={inp}
          placeholder={t("blModel", lang)}
          onChange={(e) => setF({ ...f, model: e.target.value })}
        />
        <input
          className={inp}
          placeholder={t("blModule", lang)}
          onChange={(e) => setF({ ...f, module: e.target.value })}
        />
        <select
          className={inp}
          onChange={(e) => setF({ ...f, byok: e.target.value })}
        >
          <option value="">{t("blByok", lang)}: all</option>
          <option value="true">BYOK</option>
          <option value="false">{t("blDirect", lang)}</option>
        </select>
        <select
          className={inp}
          onChange={(e) => setF({ ...f, free: e.target.value })}
        >
          <option value="">{t("blFree", lang)}: all</option>
          <option value="true">free</option>
          <option value="false">paid</option>
        </select>
      </div>
      {!data?.rows?.length ? (
        <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500">
              <tr>
                <th className="text-start py-1">{t("blWhen", lang)}</th>
                <th className="text-start">{t("blProvider", lang)}</th>
                <th className="text-start">{t("blModel", lang)}</th>
                <th className="text-start">{t("blModule", lang)}</th>
                <th className="text-end">{t("blTokens", lang)}</th>
                <th className="text-end">{t("blCost", lang)}</th>
                <th className="text-start">flags</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr
                  key={r.id}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-1">{fmtDate(r.requestAt, lang)}</td>
                  <td>{r.provider}</td>
                  <td>{r.model || "—"}</td>
                  <td>{r.module}</td>
                  <td className="text-end">
                    {r.tokensIn}/{r.tokensOut}
                  </td>
                  <td className="text-end">{usd(r.totalCost)}</td>
                  <td>
                    {r.isByok && (
                      <span className="text-sky-500">BYOK </span>
                    )}
                    {r.isFreeTier && (
                      <span className="text-emerald-500">free</span>
                    )}
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

function Trends({ lang }: { lang: any }) {
  const { data } = useSWR("/api/billing/trends?days=30", fetcher);
  const pts = data?.points || [];
  if (!pts.length)
    return <EmptyState msg={t("blNone", lang)} />;
  const charts: [string, string, string][] = [
    ["blCostPerDay", "cost", "#10b981"],
    ["blCostPerReq", "costPerRequest", "#3b82f6"],
    ["blAvgTokens", "avgTokens", "#f59e0b"],
    ["blCacheHit", "cacheHitRate", "#a855f7"],
  ];
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {charts.map(([label, key, color]) => (
        <div className={card} key={key}>
          <h3 className="font-semibold text-sm mb-3">{t(label, lang)}</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={pts}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" fontSize={10} />
                <YAxis fontSize={10} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey={key}
                  stroke={color}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ))}
      <div className={`${card} lg:col-span-2`}>
        <h3 className="font-semibold text-sm mb-3">{t("blByokMix", lang)}</h3>
        <div style={{ height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={pts}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="date" fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Legend />
              <Line
                type="monotone"
                dataKey="directCost"
                stroke="#10b981"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="byokCost"
                stroke="#0ea5e9"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Recon({ lang }: { lang: any }) {
  const [provider, setProvider] = useState("openrouter");
  const { data, mutate } = useSWR(
    `/api/billing/reconcile?provider=${provider}`,
    fetcher
  );
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await fetch("/api/billing/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    }).catch(() => {});
    setBusy(false);
    mutate();
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <input
          className={inp}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
        <button className={btn} disabled={busy} onClick={run}>
          {t("blRunRecon", lang)}
        </button>
      </div>
      <div className={card}>
        <h3 className="font-semibold text-sm mb-2">
          {t("blReconLast", lang)}
        </h3>
        {data?.lastSuccess ? (
          <p className="text-sm">
            {fmtDate(data.lastSuccess.forDate, lang)} ·{" "}
            {t("blReconCaptured", lang)} {usd(data.lastSuccess.capturedTotal)}
          </p>
        ) : (
          <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
        )}
      </div>
      <div className={card}>
        <h3 className="font-semibold text-sm mb-3">
          {t("blReconDrift", lang)}
        </h3>
        {!data?.runs?.length ? (
          <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
        ) : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={[...data.runs].reverse()}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis
                  dataKey="forDate"
                  fontSize={10}
                  tickFormatter={(v) => String(v).slice(0, 10)}
                />
                <YAxis fontSize={10} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="driftAbs"
                  stroke="#ef4444"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      <div className={card}>
        <h3 className="font-semibold text-sm mb-3">
          {t("blReconUnresolved", lang)}
        </h3>
        {!data?.unresolved?.length ? (
          <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-zinc-500">
              <tr>
                <th className="text-start py-1">{t("blWhen", lang)}</th>
                <th className="text-end">{t("blReconCaptured", lang)}</th>
                <th className="text-end">{t("blReconProvider", lang)}</th>
                <th className="text-end">{t("blReconDrift", lang)}</th>
                <th className="text-start">{t("blStatus", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {data.unresolved.map((r: any) => (
                <tr
                  key={r.id}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-1">{String(r.forDate).slice(0, 10)}</td>
                  <td className="text-end">{usd(r.capturedTotal)}</td>
                  <td className="text-end">{usd(r.providerTotal)}</td>
                  <td className="text-end text-red-600">
                    {usd(r.driftAbs)} ({r.driftPct}%)
                  </td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Manage({ lang }: { lang: any }) {
  return (
    <div className="space-y-6">
      <PricingManager lang={lang} />
      <BudgetManager lang={lang} />
      <CredentialManager lang={lang} />
      <ConfigManager lang={lang} />
    </div>
  );
}

function PricingManager({ lang }: { lang: any }) {
  const { data, mutate } = useSWR("/api/billing/pricing", fetcher);
  const [form, setForm] = useState<any>({
    provider: "openrouter",
    model: "",
    inPricePerM: 0,
    outPricePerM: 0,
  });
  const save = async () => {
    await fetch("/api/billing/pricing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        inPricePerM: Number(form.inPricePerM),
        outPricePerM: Number(form.outPricePerM),
        cachedInPricePerM: form.cachedInPricePerM
          ? Number(form.cachedInPricePerM)
          : null,
      }),
    });
    mutate();
  };
  return (
    <div className={card}>
      <h3 className="font-semibold text-sm mb-3">{t("blPricing", lang)}</h3>
      <div className="flex gap-2 flex-wrap mb-3">
        {["provider", "model"].map((k) => (
          <input
            key={k}
            className={inp}
            placeholder={k}
            value={form[k] || ""}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          />
        ))}
        <input
          className={inp}
          placeholder={t("blPricingIn", lang)}
          onChange={(e) => setForm({ ...form, inPricePerM: e.target.value })}
        />
        <input
          className={inp}
          placeholder={t("blPricingOut", lang)}
          onChange={(e) => setForm({ ...form, outPricePerM: e.target.value })}
        />
        <input
          className={inp}
          placeholder={t("blPricingCached", lang)}
          onChange={(e) =>
            setForm({ ...form, cachedInPricePerM: e.target.value })
          }
        />
        <button className={btn} onClick={save}>
          {t("blAddPricing", lang)}
        </button>
      </div>
      {!data?.rows?.length ? (
        <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-start py-1">{t("blProvider", lang)}</th>
              <th className="text-start">{t("blModel", lang)}</th>
              <th className="text-end">{t("blPricingIn", lang)}</th>
              <th className="text-end">{t("blPricingOut", lang)}</th>
              <th className="text-start">{t("blEffectiveFrom", lang)}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr
                key={r.id}
                className="border-t border-zinc-100 dark:border-zinc-800"
              >
                <td className="py-1">{r.provider}</td>
                <td>{r.model}</td>
                <td className="text-end">{r.inPricePerM}</td>
                <td className="text-end">{r.outPricePerM}</td>
                <td>{fmtDate(r.effectiveFrom, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BudgetManager({ lang }: { lang: any }) {
  const { mutate } = useSWR("/api/billing/budgets", fetcher);
  const [form, setForm] = useState<any>({
    provider: "openrouter",
    period: "daily",
    limitAmount: 10,
    actionOnBreach: "alert",
  });
  const save = async () => {
    await fetch("/api/billing/budgets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        limitAmount: Number(form.limitAmount),
      }),
    });
    mutate();
  };
  return (
    <div className={card}>
      <h3 className="font-semibold text-sm mb-3">{t("blAddBudget", lang)}</h3>
      <div className="flex gap-2 flex-wrap">
        <input
          className={inp}
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        />
        <select
          className={inp}
          value={form.period}
          onChange={(e) => setForm({ ...form, period: e.target.value })}
        >
          <option value="daily">daily</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
        </select>
        <input
          className={inp}
          type="number"
          value={form.limitAmount}
          onChange={(e) => setForm({ ...form, limitAmount: e.target.value })}
        />
        <select
          className={inp}
          value={form.actionOnBreach}
          onChange={(e) =>
            setForm({ ...form, actionOnBreach: e.target.value })
          }
        >
          <option value="alert">alert</option>
          <option value="pause">pause</option>
        </select>
        <button className={btn} onClick={save}>
          {t("blSaved", lang).replace(".", "")}
        </button>
      </div>
    </div>
  );
}

function CredentialManager({ lang }: { lang: any }) {
  const { data, mutate } = useSWR("/api/billing/credentials", fetcher);
  const [form, setForm] = useState<any>({
    provider: "openrouter",
    credType: "inference",
    key: "",
  });
  const save = async () => {
    await fetch("/api/billing/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm({ ...form, key: "" });
    mutate();
  };
  return (
    <div className={card}>
      <h3 className="font-semibold text-sm mb-1">{t("blCreds", lang)}</h3>
      <p className="text-xs text-zinc-500 mb-3">{t("blCredMasked", lang)}</p>
      {data && !data.masterKeyConfigured && (
        <p className="text-sm text-red-600 mb-2">
          PANEL_MASTER_KEY not configured.
        </p>
      )}
      <div className="flex gap-2 flex-wrap mb-3">
        <input
          className={inp}
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        />
        <select
          className={inp}
          value={form.credType}
          onChange={(e) => setForm({ ...form, credType: e.target.value })}
        >
          <option value="inference">{t("blCredInference", lang)}</option>
          <option value="management">{t("blCredManagement", lang)}</option>
        </select>
        <input
          className={inp}
          type="password"
          placeholder="key"
          value={form.key}
          onChange={(e) => setForm({ ...form, key: e.target.value })}
        />
        <button className={btn} onClick={save}>
          {t("blSaveCred", lang)}
        </button>
      </div>
      {data?.rows?.length ? (
        <table className="w-full text-sm">
          <tbody>
            {data.rows.map((r: any) => (
              <tr
                key={r.id}
                className="border-t border-zinc-100 dark:border-zinc-800"
              >
                <td className="py-1">{r.provider}</td>
                <td>{r.credType}</td>
                <td className="text-zinc-500">••••••••</td>
                <td>{r.scopeNotes || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-zinc-500">{t("blNone", lang)}</p>
      )}
    </div>
  );
}

function ConfigManager({ lang }: { lang: any }) {
  const { data, mutate } = useSWR("/api/billing/config", fetcher);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [form, setForm] = useState<any>({});
  const save = async (extra: any = {}) => {
    const r = await fetch("/api/billing/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, ...extra }),
    }).then((x) => x.json());
    if (r.ingestTokenRevealed) setRevealed(r.ingestToken);
    mutate();
  };
  const reveal = async () => {
    const r = await fetch("/api/billing/config?reveal=true").then((x) =>
      x.json()
    );
    if (r.ingestTokenRevealed) setRevealed(r.ingestToken);
  };
  if (!data) return <div className={card}>{t("loading", lang)}</div>;
  return (
    <div className={card}>
      <h3 className="font-semibold text-sm mb-3">{t("blConfig", lang)}</h3>
      <div className="space-y-3 text-sm">
        <div>
          <div className="text-zinc-500 mb-1">{t("blIngestToken", lang)}</div>
          <div className="flex gap-2 items-center">
            <code className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800">
              {revealed || data.ingestToken}
            </code>
            <button className={btn} onClick={reveal}>
              {t("blReveal", lang)}
            </button>
            <button
              className={btn}
              onClick={() => save({ regenerateIngestToken: true })}
            >
              {t("blRegenToken", lang)}
            </button>
          </div>
          {revealed && (
            <p className="text-xs text-amber-600 mt-1">
              {t("blIngestTokenOnce", lang)}
            </p>
          )}
        </div>
        <label className="block">
          {t("blBalancePoll", lang)}
          <input
            className={`${inp} ms-2`}
            type="number"
            defaultValue={data.balancePollSec}
            onChange={(e) =>
              setForm({ ...form, balancePollSec: Number(e.target.value) })
            }
          />
        </label>
        <label className="block">
          {t("blReconPct", lang)}
          <input
            className={`${inp} ms-2`}
            type="number"
            defaultValue={data.reconThresholdPct}
            onChange={(e) =>
              setForm({
                ...form,
                reconThresholdPct: Number(e.target.value),
              })
            }
          />
        </label>
        <label className="block">
          {t("blReconUsd", lang)}
          <input
            className={`${inp} ms-2`}
            type="number"
            defaultValue={data.reconThresholdUsd}
            onChange={(e) =>
              setForm({
                ...form,
                reconThresholdUsd: Number(e.target.value),
              })
            }
          />
        </label>
        <div>
          <div className="text-zinc-500 mb-1">{t("blBaseUrls", lang)}</div>
          {Object.entries(data.providerBaseUrls || {}).map(([k, v]) => (
            <div key={k} className="flex gap-2 mb-1">
              <span className="w-28">{k}</span>
              <input
                className={inp}
                defaultValue={v as string}
                onChange={(e) =>
                  setForm({
                    ...form,
                    providerBaseUrls: {
                      ...(form.providerBaseUrls || {}),
                      [k]: e.target.value,
                    },
                  })
                }
              />
            </div>
          ))}
        </div>
        <button className={btn} onClick={() => save()}>
          {t("blSaved", lang).replace(".", "")}
        </button>
      </div>
    </div>
  );
}
