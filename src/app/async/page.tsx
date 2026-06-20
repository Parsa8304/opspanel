"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
} from "recharts";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  AlertCircle,
  RefreshCw,
} from "lucide-react";

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface QueueDepth { queue: string; depth: number; }
interface TaskStat {
  taskType: string; total: number; success: number; failure: number;
  retry: number; dead: number; pending: number;
  successRate: number | null; avgDurationMs: number | null;
  p95DurationMs: number | null; lastJobAt: string | null;
}
interface Worker {
  id?: string; name?: string; api_type?: string; type?: string;
  status?: string; current_task?: string | null;
  tasks_completed?: number; tasks_failed?: number;
  started_at?: string; last_heartbeat?: string;
}
interface WorkerSummary {
  total: number; idle: number; working: number;
  byType: Record<string, { total: number; idle: number; working: number }>;
}
interface Job {
  id?: string; task_id?: string; taskId?: string;
  task_type?: string; taskType?: string; type?: string;
  status?: string; worker?: string | null;
  duration_ms?: number | null; durationMs?: number | null;
  error?: string | null; created_at?: string; createdAt?: string;
}
interface OrchestratorData {
  ok: boolean; baseUrl: string; latencyMs: number;
  health: unknown; workers: Worker[]; workerSummary: WorkerSummary;
  jobs: Job[]; activeTasks: Job[]; stats: unknown; queue: unknown;
  endpoints: Record<string, boolean>;
  checkedAt: string;
}
interface Overview {
  windowHours: number; queues: string[];
  redis: { ok: boolean; error: string | null };
  queueDepths: QueueDepth[]; workers: unknown; taskStats: TaskStat[];
  ws: { reported: boolean; connections: number | null; messagesPerMin: number | null; updatedAt: string | null };
}
interface DlqEntry { index: number; raw: string; parsed: unknown | null; }
interface DlqData {
  ok: boolean; queue: string; dlqKey: string; entries: DlqEntry[]; error?: string;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

const pct = (v: number | null) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
const ms  = (v: number | null | undefined) =>
  v == null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;

const STATUS_COLOR: Record<string, string> = {
  SUCCESS: "text-emerald-500", FAILURE: "text-red-500", DEAD: "text-red-600",
  RETRY: "text-amber-500", STARTED: "text-sky-500", PENDING: "text-zinc-400",
  working: "text-sky-500", idle: "text-emerald-500", running: "text-sky-500",
  pending: "text-zinc-400", failed: "text-red-500", success: "text-emerald-500",
};

function jobStatus(j: Job): string {
  return String(j.status ?? "unknown");
}
function jobId(j: Job): string {
  return String(j.task_id ?? j.taskId ?? j.id ?? "—");
}
function jobType(j: Job): string {
  return String(j.task_type ?? j.taskType ?? j.type ?? "—");
}
function jobDuration(j: Job): number | null {
  const v = j.duration_ms ?? j.durationMs;
  return typeof v === "number" ? v : null;
}
function jobCreated(j: Job): string | null {
  return String(j.created_at ?? j.createdAt ?? "");
}
function workerType(w: Worker): string {
  return String(w.api_type ?? w.type ?? "—");
}
function workerName(w: Worker): string {
  return String(w.name ?? w.id ?? "—");
}

/* ─── Components ─────────────────────────────────────────────────────────── */

function Card({
  title, children, right, accent,
}: {
  title: string; children: React.ReactNode;
  right?: React.ReactNode; accent?: boolean;
}) {
  return (
    <div className={`rounded-lg border ${accent ? "border-sky-500/40" : "border-zinc-200 dark:border-zinc-800"} bg-white dark:bg-zinc-900`}>
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}


function WorkerCard({ w }: { w: Worker }) {
  const isWorking = w.status === "working" || w.status === "running";
  return (
    <div className={`rounded border px-3 py-2 ${isWorking ? "border-sky-500/40 bg-sky-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`inline-block w-2 h-2 rounded-full ${isWorking ? "bg-sky-500" : "bg-emerald-500"}`} />
        <span className="text-xs font-medium truncate max-w-[180px]">{workerName(w)}</span>
        <span className={`ms-auto text-[10px] uppercase tracking-wide ${STATUS_COLOR[w.status ?? ""] ?? "text-zinc-400"}`}>
          {w.status ?? "unknown"}
        </span>
      </div>
      <div className="text-[11px] text-zinc-500 space-y-0.5">
        <div>Type: <span className="text-zinc-300 font-mono">{workerType(w)}</span></div>
        {w.current_task && (
          <div>Task: <span className="text-sky-400 font-mono truncate block max-w-full">{String(w.current_task)}</span></div>
        )}
        {typeof w.tasks_completed === "number" && (
          <div>Done: <span className="text-emerald-400">{w.tasks_completed}</span>
            {typeof w.tasks_failed === "number" && (
              <span className="text-red-400 ms-2">Failed: {w.tasks_failed}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Active Tasks Card ──────────────────────────────────────────────────── */

function ActiveTasksCard({ orchOk, orch }: { orchOk: boolean; orch: OrchestratorData | undefined }) {
  const activeTasks: Job[] = orch?.activeTasks ?? [];
  return (
    <Card title={`Active tasks (${activeTasks.length})`}>
      {!orch ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !orchOk ? (
        <p className="text-sm text-zinc-500">Orchestrator unreachable.</p>
      ) : activeTasks.length === 0 ? (
        <p className="text-sm text-zinc-500">No active tasks right now.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="py-2 text-start">Task ID</th>
                <th className="py-2 text-start">Type</th>
                <th className="py-2 text-start">Status</th>
                <th className="py-2 text-start">Worker</th>
                <th className="py-2 text-end">Duration</th>
              </tr>
            </thead>
            <tbody>
              {activeTasks.map((j, i) => (
                <tr key={jobId(j) + i} className="border-b border-zinc-100 dark:border-zinc-800/60">
                  <td className="py-1.5 pe-3 font-mono text-xs truncate max-w-[200px]">{jobId(j)}</td>
                  <td className="py-1.5 pe-3 text-xs">{jobType(j)}</td>
                  <td className={`py-1.5 pe-3 text-xs font-medium ${STATUS_COLOR[jobStatus(j)] ?? ""}`}>{jobStatus(j)}</td>
                  <td className="py-1.5 pe-3 text-xs text-zinc-500">{j.worker ?? "—"}</td>
                  <td className="py-1.5 text-end text-xs tabular-nums">{ms(jobDuration(j))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */

export default function Page() {
  const { lang } = useUI();
  const { data: overview, mutate: refetchOverview } = useSWR<Overview>(
    "/api/async/overview", fetcher, { refreshInterval: 15000 }
  );
  const { data: orch, mutate: refetchOrch } = useSWR<OrchestratorData>(
    "/api/async/orchestrator", fetcher, { refreshInterval: 6000 }
  );
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canEdit = me?.role === "ENGINEER" || me?.role === "ADMIN";

  // Live SSE stream for queue depths
  const [liveDepths, setLiveDepths] = useState<QueueDepth[] | null>(null);
  const [streamRedisOk, setStreamRedisOk] = useState(true);
  const [depthHistory, setDepthHistory] = useState<{ ts: string; depth: number }[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/async/stream");
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (Array.isArray(m.queueDepths)) {
          setLiveDepths(m.queueDepths);
          const total = (m.queueDepths as QueueDepth[]).reduce((a, d) => a + d.depth, 0);
          setDepthHistory((h) => [...h.slice(-59), { ts: m.ts, depth: total }]);
        }
        if (m.redis) setStreamRedisOk(!!m.redis.ok);
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  const depths  = liveDepths ?? overview?.queueDepths ?? [];
  const redisOk = overview ? overview.redis.ok && streamRedisOk : streamRedisOk;
  const totalDepth = depths.reduce((a, d) => a + d.depth, 0);

  const refresh = () => { refetchOverview(); refetchOrch(); };

  if (!overview && !orch) {
    return (
      <div>
        <PageHeader title={t("asyncTitle", lang)} desc={t("asyncDesc", lang)} />
        <EmptyState msg={t("loading", lang)} />
      </div>
    );
  }

  const orchOk = orch?.ok ?? false;
  const workers = orch?.workers ?? [];
  const workingWorkers = workers.filter((w) => w.status === "working" || w.status === "running");
  const idleWorkers    = workers.filter((w) => w.status === "idle");
  const allJobs = orch?.jobs ?? [];
  const recentJobs = allJobs.slice(0, 30);

  return (
    <div>
      <PageHeader title={t("asyncTitle", lang)} desc={t("asyncDesc", lang)} />

      {/* Status banner */}
      <div className="mx-6 mt-4 flex flex-wrap items-center gap-3">
        <StatusBadge
          label="Orchestrator"
          ok={orchOk}
          detail={orchOk ? `${orch?.latencyMs ?? 0} ms` : "unreachable"}
        />
        <StatusBadge
          label="Redis broker"
          ok={redisOk}
          detail={redisOk ? `queue depth: ${totalDepth}` : overview?.redis.error ?? "down"}
        />
        <StatusBadge
          label="Workers"
          ok={workers.length > 0}
          detail={`${workingWorkers.length} active / ${workers.length} total`}
        />
        <button
          onClick={refresh}
          className="ms-auto flex items-center gap-1.5 text-xs rounded border border-zinc-300 dark:border-zinc-700 px-2.5 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* ── Workers ──────────────────────────────────────────────────── */}
        <Card
          title={`Workers (${workers.length})`}
          accent={workingWorkers.length > 0}
          right={
            <div className="flex gap-3 text-xs">
              <span className="text-sky-500 font-semibold">{workingWorkers.length} active</span>
              <span className="text-zinc-500">{idleWorkers.length} idle</span>
            </div>
          }
        >
          {!orch ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : !orchOk ? (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" />
              Orchestrator unreachable — no worker data available
            </div>
          ) : workers.length === 0 ? (
            <p className="text-sm text-zinc-500">No workers registered in the orchestrator.</p>
          ) : (
            <>
              {/* Worker type summary */}
              {orch.workerSummary && Object.keys(orch.workerSummary.byType).length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {Object.entries(orch.workerSummary.byType).map(([type, s]) => (
                    <div key={type} className="rounded bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1.5 text-xs">
                      <span className="font-mono text-zinc-300">{type}</span>
                      <span className="ms-2 text-sky-400">{s.working}w</span>
                      <span className="ms-1 text-zinc-500">/ {s.total}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                {workers.map((w, i) => (
                  <WorkerCard key={w.id ?? w.name ?? i} w={w} />
                ))}
              </div>
            </>
          )}
        </Card>

        {/* ── Queue depth ──────────────────────────────────────────────── */}
        <Card title="Queue depth (live)">
          {!redisOk ? (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" />
              Redis broker unreachable
              {overview?.redis.error && <span className="text-xs">({overview.redis.error})</span>}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-3 mb-3">
                {depths.map((d) => (
                  <div key={d.queue} className="rounded border border-zinc-200 dark:border-zinc-800 px-3 py-2 min-w-[80px]">
                    <div className="text-[11px] text-zinc-500">{d.queue}</div>
                    <div className={`text-2xl font-semibold tabular-nums ${d.depth > 0 ? "text-amber-400" : ""}`}>{d.depth}</div>
                  </div>
                ))}
                {depths.length === 0 && <p className="text-sm text-zinc-500">No queues configured.</p>}
              </div>
              {depthHistory.length > 1 && (
                <div className="h-32">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={depthHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                      <XAxis dataKey="ts" hide />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                      <Tooltip
                        labelFormatter={() => ""}
                        contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }}
                      />
                      <Line type="monotone" dataKey="depth" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </Card>

        {/* ── Active tasks ─────────────────────────────────────────────── */}
        <div className="xl:col-span-2">
          <ActiveTasksCard orchOk={orchOk} orch={orch} />
        </div>

        {/* ── Task type stats ───────────────────────────────────────────── */}
        <div className="xl:col-span-2">
          <Card
            title="Task type stats"
            right={
              <span className="text-xs text-zinc-500">{overview?.windowHours ?? 24}h window (Postgres)</span>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr className="border-b border-zinc-200 dark:border-zinc-800">
                    <th className="py-2 text-start">Task type</th>
                    <th className="py-2 text-end">Success rate</th>
                    <th className="py-2 text-end">Avg dur.</th>
                    <th className="py-2 text-end">p95 dur.</th>
                    <th className="py-2 text-end text-emerald-500">✓</th>
                    <th className="py-2 text-end text-red-500">✗</th>
                    <th className="py-2 text-end text-amber-500">↩</th>
                    <th className="py-2 text-end text-red-600">☠</th>
                    <th className="py-2 text-end">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.taskStats ?? []).map((s) => (
                    <tr key={s.taskType} className="border-b border-zinc-100 dark:border-zinc-800/60">
                      <td className="py-2 font-mono text-xs">{s.taskType}</td>
                      <td className="py-2 text-end tabular-nums">{pct(s.successRate)}</td>
                      <td className="py-2 text-end tabular-nums">{ms(s.avgDurationMs)}</td>
                      <td className="py-2 text-end tabular-nums">{ms(s.p95DurationMs)}</td>
                      <td className="py-2 text-end tabular-nums text-emerald-500">{s.success}</td>
                      <td className="py-2 text-end tabular-nums text-red-500">{s.failure}</td>
                      <td className="py-2 text-end tabular-nums text-amber-500">{s.retry}</td>
                      <td className="py-2 text-end tabular-nums text-red-600">{s.dead}</td>
                      <td className="py-2 text-end tabular-nums">{s.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(overview?.taskStats ?? []).every((s) => s.total === 0) && (
                <p className="mt-3 text-xs text-zinc-500">
                  No job records in Postgres yet. Jobs are logged here when the product POSTs to <span className="font-mono">/api/async/jobs</span>.
                </p>
              )}
            </div>
          </Card>
        </div>

        {/* ── Recent jobs from orchestrator ─────────────────────────────── */}
        {orch?.endpoints.jobs && recentJobs.length > 0 && (
          <div className="xl:col-span-2">
            <Card title={`Recent jobs — orchestrator (${recentJobs.length})`}>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-zinc-500 sticky top-0 bg-zinc-900">
                    <tr className="border-b border-zinc-200 dark:border-zinc-800">
                      <th className="py-2 text-start">Task ID</th>
                      <th className="py-2 text-start">Type</th>
                      <th className="py-2 text-start">Status</th>
                      <th className="py-2 text-start">Worker</th>
                      <th className="py-2 text-end">Duration</th>
                      <th className="py-2 text-end">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentJobs.map((j, i) => (
                      <tr key={jobId(j) + i} className="border-b border-zinc-100 dark:border-zinc-800/60">
                        <td className="py-1.5 pe-3 font-mono text-xs max-w-[160px] truncate">{jobId(j)}</td>
                        <td className="py-1.5 pe-3 text-xs">{jobType(j)}</td>
                        <td className={`py-1.5 pe-3 text-xs font-medium ${STATUS_COLOR[jobStatus(j)] ?? ""}`}>{jobStatus(j)}</td>
                        <td className="py-1.5 pe-3 text-xs text-zinc-500 max-w-[120px] truncate">{String(j.worker ?? "—")}</td>
                        <td className="py-1.5 pe-3 text-end text-xs tabular-nums">{ms(jobDuration(j))}</td>
                        <td className="py-1.5 text-end text-xs text-zinc-500 whitespace-nowrap">
                          {jobCreated(j) ? fmtDate(jobCreated(j)!, lang) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* ── Orchestrator raw stats ────────────────────────────────────── */}
        {orch?.endpoints.stats && orch.stats != null && (
          <div className="xl:col-span-2">
            <OrchestratorStats stats={orch.stats} />
          </div>
        )}

        {/* ── DLQ ──────────────────────────────────────────────────────── */}
        <DlqPanel lang={lang} canEdit={canEdit} queues={overview?.queues ?? ["celery"]} />

        {/* ── Redis config ─────────────────────────────────────────────── */}
        <div className="xl:col-span-1">
          <EndpointsPanel orch={orch} />
        </div>

        {/* ── Config editor (collapsed) ─────────────────────────────────── */}
        <div className="xl:col-span-2">
          <ConfigEditor lang={lang} canEdit={canEdit} onSaved={() => refetchOverview()} />
        </div>
      </div>
    </div>
  );
}

/* ─── Status badge ───────────────────────────────────────────────────────── */

function StatusBadge({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`}>
      <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      <span className="font-medium">{label}</span>
      {detail && <span className="text-zinc-500">{detail}</span>}
    </div>
  );
}

/* ─── Orchestrator stats panel ───────────────────────────────────────────── */

function OrchestratorStats({ stats }: { stats: unknown }) {
  const entries = Object.entries(stats as Record<string, unknown>).filter(
    ([, v]) => typeof v !== "object" || v === null
  );
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="border-b border-zinc-200 dark:border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold">Orchestrator stats</h2>
      </div>
      <div className="p-4 flex flex-wrap gap-4">
        {entries.map(([k, v]) => (
          <div key={k} className="text-sm">
            <div className="text-[11px] text-zinc-500">{k}</div>
            <div className="font-semibold tabular-nums">{String(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Endpoints availability panel ──────────────────────────────────────── */

function EndpointsPanel({ orch }: { orch: OrchestratorData | undefined }) {
  if (!orch) return null;
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="border-b border-zinc-200 dark:border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold">Orchestrator endpoints</h2>
      </div>
      <div className="p-4 space-y-1.5">
        {Object.entries(orch.endpoints).map(([ep, ok]) => (
          <div key={ep} className="flex items-center gap-2 text-sm">
            <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-emerald-500" : "bg-zinc-600"}`} />
            <span className="font-mono text-xs">{orch.baseUrl}/{ep}</span>
            <span className={`text-xs ms-auto ${ok ? "text-emerald-500" : "text-zinc-500"}`}>{ok ? "200 OK" : "N/A"}</span>
          </div>
        ))}
        <div className="text-[10px] text-zinc-600 mt-2">
          Checked: {orch.checkedAt ? new Date(orch.checkedAt).toLocaleTimeString() : "—"}
        </div>
      </div>
    </div>
  );
}

/* ─── DLQ panel ──────────────────────────────────────────────────────────── */

function DlqPanel({ lang, canEdit, queues }: { lang: Lang; canEdit: boolean; queues: string[] }) {
  const [queue, setQueue] = useState(queues[0] || "celery");
  const { data, mutate } = useSWR<DlqData>(
    `/api/async/dlq?queue=${encodeURIComponent(queue)}`, fetcher, { refreshInterval: 8000 }
  );
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (entry: DlqEntry, kind: "retry" | "discard") => {
    setBusy(true);
    try {
      await fetch(`/api/async/dlq/${entry.index}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ queue, raw: entry.raw }),
      });
      await mutate();
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-2">
        <h2 className="text-sm font-semibold">{t("dlqTitle", lang)}</h2>
        <select
          value={queue} onChange={(e) => setQueue(e.target.value)}
          className="bg-transparent text-xs border border-zinc-300 dark:border-zinc-700 rounded px-1 py-0.5"
        >
          {(queues.length ? queues : ["celery"]).map((q) => (
            <option key={q} value={q}>{q}</option>
          ))}
        </select>
      </div>
      <div className="p-4">
        {!data ? (
          <p className="text-sm text-zinc-500">{t("loading", lang)}</p>
        ) : data.ok === false ? (
          <p className="text-sm text-red-500">{t("redisDown", lang)} {data.error ? `(${data.error})` : ""}</p>
        ) : data.entries.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("dlqEmpty", lang)}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.entries.map((e) => (
              <li key={e.index} className="rounded border border-zinc-200 dark:border-zinc-800 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs truncate">{e.raw.slice(0, 80)}</span>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => setOpen(open === e.index ? null : e.index)} className="text-xs underline text-zinc-500">
                      {t("inspect", lang)}
                    </button>
                    {canEdit && (
                      <>
                        <button disabled={busy} onClick={() => act(e, "retry")}
                          className="text-xs rounded bg-indigo-600 text-white px-2 py-0.5 disabled:opacity-50">
                          {t("retryAction", lang)}
                        </button>
                        <button disabled={busy} onClick={() => act(e, "discard")}
                          className="text-xs rounded border border-red-500/50 text-red-500 px-2 py-0.5 disabled:opacity-50">
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
      </div>
    </div>
  );
}

/* ─── Config editor ──────────────────────────────────────────────────────── */

function ConfigEditor({ lang, canEdit, onSaved }: { lang: Lang; canEdit: boolean; onSaved: () => void }) {
  const { data, mutate } = useSWR<{
    config: { url?: string; queues?: string[]; dlq?: string };
    resolved: { url: string; queues: string[]; envOverride: boolean; defaultUrl: string };
  }>("/api/async/config", fetcher);
  const [url, setUrl]   = useState("");
  const [queues, setQueues] = useState("");
  const [dlq, setDlq]   = useState("");
  const [saved, setSaved]  = useState(false);
  const [open, setOpen]  = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (data && !initialized.current) {
      initialized.current = true;
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
        queues: queues.split(",").map((q) => q.trim()).filter(Boolean),
        dlq: dlq || null,
      }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await mutate();
    onSaved();
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold"
      >
        <span>{t("redisConfig", lang)}</span>
        <span className="text-zinc-500 text-xs">{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-4">
          {!data ? (
            <p className="text-sm text-zinc-500">{t("loading", lang)}</p>
          ) : (
            <div className="space-y-3 max-w-xl">
              <label className="block text-sm">
                <span className="text-zinc-500">{t("brokerUrl", lang)}</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={!canEdit}
                  className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60" />
              </label>
              <label className="block text-sm">
                <span className="text-zinc-500">{t("queuesField", lang)}</span>
                <input value={queues} onChange={(e) => setQueues(e.target.value)} disabled={!canEdit} placeholder="celery"
                  className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60" />
              </label>
              <label className="block text-sm">
                <span className="text-zinc-500">{t("dlqField", lang)}</span>
                <input value={dlq} onChange={(e) => setDlq(e.target.value)} disabled={!canEdit} placeholder="<queue>.dlq"
                  className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono text-sm disabled:opacity-60" />
              </label>
              <div className="text-xs text-zinc-500">
                {data.resolved.queues.join(", ")} · {data.resolved.url}
                {data.resolved.envOverride && (
                  <span className="block text-amber-500 mt-1">{t("envOverrideNote", lang)}</span>
                )}
              </div>
              {canEdit && (
                <button onClick={save} className="rounded bg-indigo-600 text-white text-sm px-3 py-1.5">
                  {saved ? t("savedCfg", lang) : t("saveCfg", lang)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
