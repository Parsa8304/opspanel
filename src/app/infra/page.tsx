"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { fetcher } from "@/lib/fetcher";
import {
  CheckCircle2, XCircle, RefreshCw, CloudUpload,
  Play, FlaskConical, Plus, Trash2, GripVertical, ChevronDown, ChevronRight, Save,
} from "lucide-react";

interface Container { name: string; image: string; status: string; running: boolean }
interface Commit { sha: string; shortSha: string; author: string; date: string; message: string }
interface StatusData { containers: Container[]; commit: Commit | null; dir: string }

interface DeployStep { label: string; cmd: string; allowFail?: boolean }
interface InfraDeployConfig { steps: DeployStep[]; dryRunSteps: DeployStep[]; timeoutSec: number }

interface DeployJob {
  id: string; label: string; state: string; progress: number | null;
  error: string | null; createdAt: string; startedAt: string | null;
  finishedAt: string | null; params: { dryRun?: boolean } | null;
  createdBy: { email: string } | null;
}

const STATE_COLOR: Record<string, string> = {
  QUEUED: "text-zinc-400", RUNNING: "text-amber-400",
  SUCCEEDED: "text-emerald-400", FAILED: "text-red-400", CANCELLED: "text-zinc-500",
};

// ─── Step editor ─────────────────────────────────────────────────────────────

function StepEditor({
  steps, onChange,
}: { steps: DeployStep[]; onChange: (s: DeployStep[]) => void }) {
  const add = () => onChange([...steps, { label: "", cmd: "", allowFail: false }]);
  const del = (i: number) => onChange(steps.filter((_, j) => j !== i));
  const upd = <K extends keyof DeployStep>(i: number, k: K, v: DeployStep[K]) => {
    const next = steps.map((s, j) => j === i ? { ...s, [k]: v } : s);
    onChange(next);
  };
  const move = (from: number, to: number) => {
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {steps.map((s, i) => (
        <div key={i} className="flex gap-2 items-start rounded border border-zinc-700 bg-zinc-900/50 p-2">
          <div className="flex flex-col gap-1 mt-1 shrink-0">
            <button disabled={i === 0} onClick={() => move(i, i - 1)}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-20">
              <GripVertical size={12} />
            </button>
            <button disabled={i === steps.length - 1} onClick={() => move(i, i + 1)}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-20">
              <GripVertical size={12} />
            </button>
          </div>
          <div className="flex-1 grid gap-1.5">
            <div className="flex gap-2">
              <input
                placeholder="Step label"
                value={s.label}
                onChange={(e) => upd(i, "label", e.target.value)}
                className="flex-1 bg-transparent border border-zinc-700 rounded px-2 py-1 text-xs font-medium"
              />
              <label className="flex items-center gap-1 text-xs text-zinc-400 whitespace-nowrap cursor-pointer select-none">
                <input type="checkbox" checked={!!s.allowFail}
                  onChange={(e) => upd(i, "allowFail", e.target.checked)}
                  className="accent-amber-400" />
                allow fail
              </label>
            </div>
            <input
              placeholder="shell command (runs via nsenter into host)"
              value={s.cmd}
              onChange={(e) => upd(i, "cmd", e.target.value)}
              className="w-full bg-transparent border border-zinc-700 rounded px-2 py-1 text-xs font-mono text-emerald-300"
            />
          </div>
          <button onClick={() => del(i)} className="text-zinc-600 hover:text-red-400 mt-1 shrink-0">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button onClick={add}
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 border border-dashed border-zinc-700 rounded px-3 py-1.5 w-full justify-center">
        <Plus size={11} /> Add step
      </button>
    </div>
  );
}

// ─── Config panel ─────────────────────────────────────────────────────────────

function ConfigPanel({ config, onSaved }: { config: InfraDeployConfig; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"deploy" | "dryrun">("deploy");
  const [form, setForm] = useState<InfraDeployConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setForm(config), [config]);

  async function save() {
    setSaving(true);
    const res = await fetch("/api/infra/deploy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) { setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2000); }
  }

  const reset = () => setForm(config);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-medium"
      >
        <span>Deploy Script Editor</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {open && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 space-y-4">
          <p className="text-xs text-zinc-500">
            Each step runs as a shell command on the <strong>host</strong> via nsenter.
            Steps run in order; a failing step aborts the deploy unless "allow fail" is checked.
          </p>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-zinc-700">
            {(["deploy", "dryrun"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs rounded-t border border-b-0 ${
                  tab === t
                    ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t === "deploy" ? "Deploy steps" : "Dry-run steps"}
              </button>
            ))}
          </div>

          {tab === "deploy" ? (
            <StepEditor
              steps={form.steps}
              onChange={(steps) => setForm({ ...form, steps })}
            />
          ) : (
            <StepEditor
              steps={form.dryRunSteps}
              onChange={(dryRunSteps) => setForm({ ...form, dryRunSteps })}
            />
          )}

          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Step timeout (seconds):</span>
            <input
              type="number"
              min={30}
              max={3600}
              value={form.timeoutSec}
              onChange={(e) => setForm({ ...form, timeoutSec: Number(e.target.value) })}
              className="w-20 bg-transparent border border-zinc-700 rounded px-2 py-0.5 text-zinc-200"
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 bg-[#09637E] hover:bg-[#088395] text-white rounded px-3 py-1.5 text-xs disabled:opacity-50"
            >
              <Save size={12} /> {saving ? "Saving…" : "Save steps"}
            </button>
            <button onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-300">
              Reset
            </button>
            {saved && <span className="text-xs text-emerald-400">Saved.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function InfraPage() {
  useUI();

  const { data: status, mutate: refetchStatus, isLoading: loadingStatus } =
    useSWR<StatusData>("/api/infra/status", fetcher, { refreshInterval: 20000 });

  const { data: deployData, mutate: refetchJobs } =
    useSWR<{ jobs: DeployJob[]; config: InfraDeployConfig }>("/api/infra/deploy", fetcher, { refreshInterval: 5000 });

  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [banner, setBanner] = useState<{ kind: "ok" | "fail"; msg: string } | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll log
  useEffect(() => {
    if (logBoxRef.current)
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logLines]);

  // Auto-attach to a running job on first load
  const attachedRef = useRef(false);
  useEffect(() => {
    if (attachedRef.current || !deployData) return;
    const running = deployData.jobs.find((j) => j.state === "RUNNING" || j.state === "QUEUED");
    if (running) { attachedRef.current = true; streamJob(running.id); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployData]);

  function streamJob(jobId: string) {
    setActiveJobId(jobId);
    setLogLines([]);
    esRef.current?.close();

    const es = new EventSource(`/api/infra/deploy/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.logDelta) {
          const lines = d.logDelta.split("\n").filter((l: string) => l.trim() !== "");
          setLogLines((prev) => [...prev, ...lines]);
        }
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(d.state)) {
          es.close();
          refetchJobs();
          refetchStatus();
          setBusy(false);
          if (d.state === "SUCCEEDED") setBanner({ kind: "ok", msg: "Deploy completed successfully." });
          else if (d.state === "FAILED") setBanner({ kind: "fail", msg: d.error || "Deploy failed." });
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); setBusy(false); };
  }

  async function triggerDeploy() {
    setBusy(true);
    setBanner(null);
    setLogLines([]);
    const res = await fetch("/api/infra/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBusy(false);
      setBanner({ kind: "fail", msg: body.error || "Failed to start deploy." });
      return;
    }
    streamJob(body.jobId);
    refetchJobs();
  }

  const runningJob = deployData?.jobs.find((j) => j.state === "RUNNING" || j.state === "QUEUED");

  return (
    <div>
      <PageHeader
        title="MN Infrastructure"
        desc="Deploy Market Navigator services. Commands run directly on the host via nsenter."
      />

      <div className="p-6 space-y-6">
        {banner && (
          <div className={`rounded-md px-4 py-3 text-sm ${
            banner.kind === "ok"
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-600/40"
              : "bg-red-500/15 text-red-400 border border-red-600/40"
          }`}>
            {banner.msg}
          </div>
        )}

        {runningJob && !activeJobId && (
          <div className="rounded-md px-4 py-3 text-sm bg-amber-500/10 text-amber-400 border border-amber-600/40 flex items-center gap-2">
            <span>A deploy is running.</span>
            <button className="underline" onClick={() => streamJob(runningJob.id)}>
              Attach to live log
            </button>
          </div>
        )}

        {/* Container status */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium flex items-center justify-between">
            <span>MN Container Status</span>
            <button onClick={() => refetchStatus()}
              className="text-zinc-400 hover:text-zinc-200 p-1 rounded" title="Refresh">
              <RefreshCw size={13} className={loadingStatus ? "animate-spin" : ""} />
            </button>
          </div>
          {status?.commit && (
            <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
              <span>Deployed: <code className="font-mono text-zinc-300">{status.commit.shortSha}</code></span>
              <span className="text-zinc-400">{status.commit.message.slice(0, 80)}</span>
              <span>{status.commit.author}</span>
              <span>{new Date(status.commit.date).toLocaleString()}</span>
            </div>
          )}
          {!status ? (
            <div className="px-4 py-6 text-sm text-zinc-500">Loading…</div>
          ) : status.containers.length === 0 ? (
            <div className="px-4 py-6 text-sm text-zinc-500">
              No containers found at <code>{status.dir}</code>.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-start px-4 py-2">Container</th>
                  <th className="text-start px-4 py-2">Image</th>
                  <th className="text-start px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {status.containers.map((c) => (
                  <tr key={c.name} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="px-4 py-2 font-mono text-xs">{c.name}</td>
                    <td className="px-4 py-2 text-xs text-zinc-400">{c.image}</td>
                    <td className="px-4 py-2">
                      <span className={`flex items-center gap-1 text-xs ${c.running ? "text-emerald-400" : "text-red-400"}`}>
                        {c.running ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Deploy trigger */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-4">
          <div className="text-sm font-medium">Trigger Deploy</div>

          {/* Show current steps as a preview */}
          {deployData?.config && (
            <div className="space-y-1">
              {(dryRun ? deployData.config.dryRunSteps : deployData.config.steps).map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="text-zinc-600 w-4 text-right shrink-0">{i + 1}.</span>
                  <span className="text-zinc-400">{s.label}</span>
                  <span className="font-mono text-zinc-600 truncate">{s.cmd}</span>
                  {s.allowFail && <span className="text-amber-600 shrink-0">(allow-fail)</span>}
                </div>
              ))}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)}
              className="accent-[var(--primary)]" />
            <span>
              <span className="font-medium">Dry run</span>
              <span className="text-zinc-500 ml-2">— uses dry-run steps (build only, no restart)</span>
            </span>
          </label>

          <div className="flex gap-3 items-center">
            <button
              disabled={busy || !!runningJob}
              onClick={triggerDeploy}
              className="flex items-center gap-2 bg-[#09637E] hover:bg-[#088395] text-white rounded px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {dryRun ? <FlaskConical size={14} /> : <CloudUpload size={14} />}
              {dryRun ? "Run dry-run" : "Deploy now"}
            </button>
            {busy && (
              <span className="flex items-center gap-1 text-xs text-amber-400">
                <RefreshCw size={11} className="animate-spin" /> Running…
              </span>
            )}
          </div>
        </div>

        {/* Live log */}
        {activeJobId && (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium flex items-center justify-between">
              <span>Live log</span>
              <button className="text-xs text-zinc-500 hover:text-zinc-300 underline"
                onClick={() => { setActiveJobId(null); esRef.current?.close(); }}>
                dismiss
              </button>
            </div>
            <div ref={logBoxRef}
              className="font-mono text-xs p-3 max-h-[28rem] overflow-auto bg-zinc-950 text-zinc-300 leading-relaxed">
              {logLines.length === 0 ? (
                <span className="text-zinc-600">Waiting for output…</span>
              ) : (
                logLines.map((l, i) => {
                  const cls =
                    l.includes("✗") || l.startsWith("ERROR") || l.includes("FAILED")
                      ? "text-red-400"
                      : l.startsWith(">>>")
                      ? "text-cyan-300 font-semibold mt-2 block"
                      : l.startsWith("===")
                      ? "text-emerald-400 font-semibold"
                      : l.includes("✓") || l.includes("done")
                      ? "text-emerald-300"
                      : l.startsWith("    $")
                      ? "text-zinc-500 italic"
                      : "";
                  return <div key={i} className={cls}>{l || " "}</div>;
                })
              )}
            </div>
          </div>
        )}

        {/* Script editor */}
        {deployData?.config && (
          <ConfigPanel config={deployData.config} onSaved={refetchJobs} />
        )}

        {/* Deploy history */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">
            Deploy History
          </div>
          {!deployData || deployData.jobs.length === 0 ? (
            <div className="px-4 py-6 text-sm text-zinc-500">No deploys yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-start px-4 py-2">Label</th>
                  <th className="text-start px-4 py-2">State</th>
                  <th className="text-start px-4 py-2">By</th>
                  <th className="text-start px-4 py-2">Started</th>
                  <th className="text-start px-4 py-2">Duration</th>
                  <th className="text-start px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {deployData.jobs.map((j) => {
                  const dur = j.startedAt && j.finishedAt
                    ? Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000) + "s"
                    : j.startedAt ? "running…" : "—";
                  return (
                    <tr key={j.id} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="px-4 py-2">
                        {j.label}
                        {j.params?.dryRun && (
                          <span className="ml-2 text-xs text-zinc-500 border border-zinc-600 rounded px-1">dry</span>
                        )}
                      </td>
                      <td className={`px-4 py-2 ${STATE_COLOR[j.state] ?? "text-zinc-400"}`}>
                        {j.state}
                        {j.state === "RUNNING" && j.progress != null && (
                          <span className="ml-1 text-zinc-500">({j.progress}%)</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">{j.createdBy?.email ?? "—"}</td>
                      <td className="px-4 py-2 text-xs text-zinc-500">
                        {j.startedAt ? new Date(j.startedAt).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2 text-xs text-zinc-500">{dur}</td>
                      <td className="px-4 py-2">
                        <button className="text-xs text-emerald-500 hover:underline flex items-center gap-1"
                          onClick={() => streamJob(j.id)}>
                          <Play size={10} /> log
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
