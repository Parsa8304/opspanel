"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

interface QueueDepth {
  queue: string;
  depth: number;
}
interface TaskStat {
  taskType: string;
  total: number;
  success: number;
  failure: number;
  retry: number;
  dead: number;
  pending: number;
  successRate: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  lastJobAt: string | null;
}
interface Workers {
  inferred: boolean;
  connectedClients: number | null;
  workerKeys: string[];
  unacked: { key: string; count: number }[];
  noTelemetry: boolean;
  note: string;
}
interface Ws {
  reported: boolean;
  connections: number | null;
  messagesPerMin: number | null;
  updatedAt: string | null;
}
interface Job {
  id: string;
  taskId: string;
  taskType: string;
  queue: string;
  status: string;
  workerName: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}
interface Overview {
  windowHours: number;
  queues: string[];
  redis: { ok: boolean; error: string | null };
  queueDepths: QueueDepth[];
  workers: Workers | null;
  taskStats: TaskStat[];
  ws: Ws;
}

const pct = (v: number | null) =>
  v == null ? "—" : `${(v * 100).toFixed(1)}%`;
const ms = (v: number | null) =>
  v == null ? "—" : `${Math.round(v)} ms`;

const STATUS_CLS: Record<string, string> = {
  SUCCESS: "text-emerald-500",
  FAILURE: "text-red-500",
  DEAD: "text-red-600",
  RETRY: "text-amber-500",
  STARTED: "text-sky-500",
  PENDING: "text-zinc-400",
};

function Card({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export default function Page() {
  const { lang } = useUI();
  const { data, mutate } = useSWR<Overview>(
    "/api/async/overview",
    fetcher,
    { refreshInterval: 10000 }
  );
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canEdit = me?.role === "ENGINEER" || me?.role === "ADMIN";

  // Live SSE stream for queue depths + newest jobs.
  const [liveDepths, setLiveDepths] = useState<QueueDepth[] | null>(null);
  const [liveJobs, setLiveJobs] = useState<Job[]>([]);
  const [streamRedisOk, setStreamRedisOk] = useState(true);
  useEffect(() => {
    const es = new EventSource("/api/async/stream");
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (Array.isArray(m.queueDepths)) setLiveDepths(m.queueDepths);
        if (Array.isArray(m.jobs)) setLiveJobs(m.jobs);
        if (m.redis) setStreamRedisOk(!!m.redis.ok);
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  const depths = liveDepths ?? data?.queueDepths ?? [];
  const redisOk = data ? data.redis.ok && streamRedisOk : streamRedisOk;

  if (!data) {
    return (
      <div>
        <PageHeader title={t("asyncTitle", lang)} desc={t("asyncDesc", lang)} />
        <EmptyState msg={t("loading", lang)} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t("asyncTitle", lang)} desc={t("asyncDesc", lang)} />

      {!redisOk && (
        <div className="mx-6 mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {t("redisDown", lang)}
          {data.redis.error ? ` (${data.redis.error})` : ""}
        </div>
      )}

      <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title={t("queueDepth", lang)}>
          {depths.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("noQueues", lang)}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-4 mb-3">
                {depths.map((d) => (
                  <div
                    key={d.queue}
                    className="rounded border border-zinc-200 dark:border-zinc-800 px-3 py-2"
                  >
                    <div className="text-xs text-zinc-500">{d.queue}</div>
                    <div className="text-2xl font-semibold tabular-nums">
                      {d.depth}
                    </div>
                  </div>
                ))}
              </div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={depths}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                    <XAxis dataKey="queue" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="depth" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>

        <Card
          title={t("workersTitle", lang)}
          right={
            <span className="text-[10px] uppercase tracking-wide text-amber-500">
              {t("coarseInferred", lang)}
            </span>
          }
        >
          {!data.workers || data.workers.noTelemetry ? (
            <p className="text-sm text-zinc-500">
              {t("noWorkerTelemetry", lang)}
            </p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">
                  {t("connectedClients", lang)}
                </span>
                <span className="tabular-nums">
                  {data.workers.connectedClients ?? "—"}
                </span>
              </div>
              <div>
                <div className="text-zinc-500">{t("heartbeatKeys", lang)}</div>
                {data.workers.workerKeys.length === 0 ? (
                  <span className="text-zinc-500">—</span>
                ) : (
                  <ul className="list-disc ms-5">
                    {data.workers.workerKeys.map((k) => (
                      <li key={k} className="font-mono text-xs">
                        {k}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="text-zinc-500">{t("inFlight", lang)}</div>
                {data.workers.unacked.length === 0 ? (
                  <span className="text-zinc-500">—</span>
                ) : (
                  <ul className="text-xs">
                    {data.workers.unacked.map((u) => (
                      <li key={u.key} className="flex justify-between">
                        <span className="font-mono">{u.key}</span>
                        <span className="tabular-nums">{u.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {data.workers && (
            <p className="mt-3 text-[11px] text-zinc-500">
              {data.workers.note}
            </p>
          )}
        </Card>

        <div className="xl:col-span-2">
          <Card
            title={t("taskTypeStats", lang)}
            right={
              <span className="text-xs text-zinc-500">
                {data.windowHours}h
              </span>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr className="border-b border-zinc-200 dark:border-zinc-800">
                    <th className="py-2 text-start">
                      {t("colTaskType", lang)}
                    </th>
                    <th className="py-2 text-end">
                      {t("colSuccessRate", lang)}
                    </th>
                    <th className="py-2 text-end">{t("colAvgDur", lang)}</th>
                    <th className="py-2 text-end">{t("colP95Dur", lang)}</th>
                    <th className="py-2 text-end">{t("colSuccess", lang)}</th>
                    <th className="py-2 text-end">{t("colFailure", lang)}</th>
                    <th className="py-2 text-end">{t("colRetry", lang)}</th>
                    <th className="py-2 text-end">{t("colDead", lang)}</th>
                    <th className="py-2 text-end">{t("colTotal", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.taskStats.map((s) => (
                    <tr
                      key={s.taskType}
                      className="border-b border-zinc-100 dark:border-zinc-800/60"
                    >
                      <td className="py-2 font-mono text-xs">{s.taskType}</td>
                      <td className="py-2 text-end tabular-nums">
                        {pct(s.successRate)}
                      </td>
                      <td className="py-2 text-end tabular-nums">
                        {ms(s.avgDurationMs)}
                      </td>
                      <td className="py-2 text-end tabular-nums">
                        {ms(s.p95DurationMs)}
                      </td>
                      <td className="py-2 text-end tabular-nums text-emerald-500">
                        {s.success}
                      </td>
                      <td className="py-2 text-end tabular-nums text-red-500">
                        {s.failure}
                      </td>
                      <td className="py-2 text-end tabular-nums text-amber-500">
                        {s.retry}
                      </td>
                      <td className="py-2 text-end tabular-nums text-red-600">
                        {s.dead}
                      </td>
                      <td className="py-2 text-end tabular-nums">{s.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <DlqPanel lang={lang} canEdit={canEdit} queues={data.queues} />

        <Card title={t("wsTile", lang)}>
          {!data.ws.reported ? (
            <p className="text-sm text-zinc-500">
              {t("wsNotReported", lang)}
            </p>
          ) : (
            <div className="flex gap-6">
              <div>
                <div className="text-xs text-zinc-500">
                  {t("wsConnections", lang)}
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {data.ws.connections ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">
                  {t("wsThroughput", lang)}
                </div>
                <div className="text-2xl font-semibold tabular-nums">
                  {data.ws.messagesPerMin ?? "—"}
                </div>
              </div>
              {data.ws.updatedAt && (
                <div className="text-xs text-zinc-500 self-end">
                  {fmtDate(data.ws.updatedAt, lang)}
                </div>
              )}
            </div>
          )}
        </Card>

        <div className="xl:col-span-2">
          <Card title={t("jobStream", lang)}>
            {liveJobs.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("noJobs", lang)}</p>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {liveJobs.map((j) => (
                      <tr
                        key={j.id}
                        className="border-b border-zinc-100 dark:border-zinc-800/60"
                      >
                        <td className="py-1.5 pe-3 font-mono text-xs">
                          {j.taskId}
                        </td>
                        <td className="py-1.5 pe-3 text-xs">{j.taskType}</td>
                        <td
                          className={`py-1.5 pe-3 text-xs font-medium ${
                            STATUS_CLS[j.status] ?? ""
                          }`}
                        >
                          {j.status}
                        </td>
                        <td className="py-1.5 pe-3 text-xs tabular-nums">
                          {ms(j.durationMs)}
                        </td>
                        <td className="py-1.5 pe-3 text-xs text-zinc-500">
                          {j.workerName ?? "—"}
                        </td>
                        <td className="py-1.5 text-xs text-zinc-500">
                          {fmtDate(j.createdAt, lang)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="xl:col-span-2">
          <ConfigEditor lang={lang} canEdit={canEdit} onSaved={() => mutate()} />
        </div>
      </div>
    </div>
  );
}

function DlqPanel({
  lang,
  canEdit,
  queues,
}: {
  lang: Lang;
  canEdit: boolean;
  queues: string[];
}) {
  const [queue, setQueue] = useState(queues[0] || "celery");
  const { data, mutate } = useSWR<{
    ok: boolean;
    queue: string;
    dlqKey: string;
    entries: { index: number; raw: string; parsed: unknown | null }[];
    error?: string;
  }>(`/api/async/dlq?queue=${encodeURIComponent(queue)}`, fetcher, {
    refreshInterval: 8000,
  });
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (
    entry: { index: number; raw: string },
    kind: "retry" | "discard"
  ) => {
    setBusy(true);
    try {
      await fetch(`/api/async/dlq/${entry.index}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ queue, raw: entry.raw }),
      });
      await mutate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t("dlqTitle", lang)}
      right={
        <select
          value={queue}
          onChange={(e) => setQueue(e.target.value)}
          className="bg-transparent text-xs border border-zinc-300 dark:border-zinc-700 rounded px-1 py-0.5"
        >
          {(queues.length ? queues : ["celery"]).map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
      }
    >
      {!data ? (
        <p className="text-sm text-zinc-500">{t("loading", lang)}</p>
      ) : data.ok === false ? (
        <p className="text-sm text-red-500">
          {t("redisDown", lang)} {data.error ? `(${data.error})` : ""}
        </p>
      ) : data.entries.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("dlqEmpty", lang)}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {data.entries.map((e) => (
            <li
              key={e.index}
              className="rounded border border-zinc-200 dark:border-zinc-800 p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs truncate">
                  {e.raw.slice(0, 80)}
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() =>
                      setOpen(open === e.index ? null : e.index)
                    }
                    className="text-xs underline text-zinc-500"
                  >
                    {t("inspect", lang)}
                  </button>
                  {canEdit && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => act(e, "retry")}
                        className="text-xs rounded bg-[#183661] text-white px-2 py-0.5 disabled:opacity-50"
                      >
                        {t("retryAction", lang)}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => act(e, "discard")}
                        className="text-xs rounded border border-red-500/50 text-red-500 px-2 py-0.5 disabled:opacity-50"
                      >
                        {t("discard", lang)}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {open === e.index && (
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-100 dark:bg-zinc-950 p-2 text-[11px]">
                  {JSON.stringify(e.parsed ?? e.raw, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConfigEditor({
  lang,
  canEdit,
  onSaved,
}: {
  lang: Lang;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { data, mutate } = useSWR<{
    config: { url?: string; queues?: string[]; dlq?: string };
    resolved: {
      url: string;
      queues: string[];
      envOverride: boolean;
      defaultUrl: string;
    };
  }>("/api/async/config", fetcher);
  const [url, setUrl] = useState("");
  const [queues, setQueues] = useState("");
  const [dlq, setDlq] = useState("");
  const [saved, setSaved] = useState(false);
  const init = useRef(false);

  useEffect(() => {
    if (data && !init.current) {
      init.current = true;
      setUrl(data.config.url || "");
      setQueues((data.config.queues || []).join(", "));
      setDlq(data.config.dlq || "");
    }
  }, [data]);

  const save = async () => {
    await fetch("/api/async/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        url: url || null,
        queues: queues
          .split(",")
          .map((q) => q.trim())
          .filter(Boolean),
        dlq: dlq || null,
      }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await mutate();
    onSaved();
  };

  return (
    <Card title={t("redisConfig", lang)}>
      {!data ? (
        <p className="text-sm text-zinc-500">{t("loading", lang)}</p>
      ) : (
        <div className="space-y-3 max-w-xl">
          <label className="block text-sm">
            <span className="text-zinc-500">{t("brokerUrl", lang)}</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={!canEdit}
              className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-500">{t("queuesField", lang)}</span>
            <input
              value={queues}
              onChange={(e) => setQueues(e.target.value)}
              disabled={!canEdit}
              placeholder="celery"
              className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60"
            />
          </label>
          <label className="block text-sm">
            <span className="text-zinc-500">{t("dlqField", lang)}</span>
            <input
              value={dlq}
              onChange={(e) => setDlq(e.target.value)}
              disabled={!canEdit}
              placeholder="<queue>.dlq"
              className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60"
            />
          </label>
          <div className="text-xs text-zinc-500">
            {data.resolved.queues.join(", ")} · {data.resolved.url}
            {data.resolved.envOverride && (
              <span className="block text-amber-500 mt-1">
                {t("envOverrideNote", lang)}
              </span>
            )}
          </div>
          {canEdit && (
            <button
              onClick={save}
              className="rounded bg-[#183661] text-white text-sm px-3 py-1.5"
            >
              {saved ? t("savedCfg", lang) : t("saveCfg", lang)}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
