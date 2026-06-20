"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { fetcher } from "@/lib/fetcher";
import Link from "next/link";
import {
  CheckCircle2, XCircle, RefreshCw, Terminal, Play, Plug, Trash2, ArrowLeft, Boxes,
} from "lucide-react";

interface RemoteServer {
  id: string; name: string; host: string; port: number; sshUser: string;
  fingerprint: string | null; tags: string[];
  lastOkAt: string | null; lastError: string | null;
  createdAt: string;
}

interface Container { name: string; image: string; status: string; running: boolean }

interface ExecJob {
  id: string; label: string; state: string; progress: number | null;
  error: string | null; createdAt: string; startedAt: string | null;
  finishedAt: string | null; params: { cmd?: string } | null;
}

const STATE_COLOR: Record<string, string> = {
  QUEUED: "text-zinc-400", RUNNING: "text-amber-400",
  SUCCEEDED: "text-emerald-400", FAILED: "text-red-400", CANCELLED: "text-zinc-500",
};

export default function ServerDetailPage() {
  useUI();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const { data, mutate: refetchServer } = useSWR<{ servers: RemoteServer[] }>("/api/servers", fetcher);
  const server = data?.servers.find((s) => s.id === id);

  const { data: containersData, mutate: refetchContainers, isLoading: loadingContainers } =
    useSWR<{ containers: Container[]; error: string | null }>(
      id ? `/api/servers/${id}/containers` : null, fetcher, { refreshInterval: 20000 }
    );
  const { data: execData, mutate: refetchJobs } =
    useSWR<{ jobs: ExecJob[] }>(id ? `/api/servers/${id}/exec` : null, fetcher, { refreshInterval: 5000 });

  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logLines]);

  const attachedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!execData || !id || attachedRef.current === id) return;
    const running = execData.jobs.find((j) => j.state === "RUNNING" || j.state === "QUEUED");
    if (running) { attachedRef.current = id; streamJob(running.id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execData, id]);

  function streamJob(jobId: string) {
    setActiveJobId(jobId);
    setLogLines([]);
    setBusy(true);
    esRef.current?.close();
    const es = new EventSource(`/api/servers/exec/${jobId}/stream`);
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
          setBusy(false);
          refetchJobs();
          refetchContainers();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); setBusy(false); };
  }

  async function run() {
    if (!cmd.trim() || !id) return;
    setBusy(true);
    setLogLines([]);
    const res = await fetch(`/api/servers/${id}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBusy(false);
      setLogLines([`Error: ${body.error || "failed to start"}`]);
      return;
    }
    streamJob(body.jobId);
    refetchJobs();
  }

  async function testServer() {
    if (!id) return;
    setTesting(true);
    const res = await fetch(`/api/servers/${id}/test`, { method: "POST" });
    const body = await res.json();
    setTesting(false);
    setTestResult(body);
    refetchServer();
  }

  async function deleteServer() {
    if (!id || !server) return;
    if (!confirm(`Remove server "${server.name}"? This deletes its stored credentials.`)) return;
    await fetch(`/api/servers/${id}`, { method: "DELETE" });
    router.push("/servers");
  }

  const runningJob = execData?.jobs.find((j) => j.state === "RUNNING" || j.state === "QUEUED");

  if (data && !server) {
    return (
      <div>
        <PageHeader title="Server not found" />
        <div className="p-6 text-sm text-zinc-500">
          This server doesn't exist or was removed.{" "}
          <button onClick={() => router.push("/servers")} className="text-emerald-500 hover:underline">
            Back to registry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={server?.name ?? "Loading…"}
        desc={server ? (id === "local" ? "local machine — the host this panel runs on" : `${server.sshUser}@${server.host}:${server.port}`) : undefined}
      />

      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push("/servers")}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-1"
          >
            <ArrowLeft size={11} /> All servers
          </button>
          <button
            onClick={testServer}
            disabled={testing}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-1 disabled:opacity-50"
          >
            <Plug size={11} className={testing ? "animate-pulse" : ""} /> Test connection
          </button>
          <Link
            href={`/servers/${id}/containers`}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-1"
          >
            <Boxes size={11} /> Containers
          </Link>
          {id !== "local" && (
            <button
              onClick={deleteServer}
              className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 border border-zinc-700 rounded px-2 py-1 ml-auto"
            >
              <Trash2 size={11} /> Remove server
            </button>
          )}
        </div>

        {server?.tags && server.tags.length > 0 && (
          <div className="flex items-center gap-1.5">
            {server.tags.map((tg) => (
              <span key={tg} className="text-[10px] uppercase tracking-wide text-zinc-500 border border-zinc-700 rounded px-1">{tg}</span>
            ))}
          </div>
        )}

        <div className="text-xs">
          {testResult ? (
            <span className={testResult.ok ? "text-emerald-400" : "text-red-400"}>
              {testResult.ok ? "OK: " : "Failed: "}{testResult.message}
            </span>
          ) : server?.lastOkAt ? (
            <span className="text-emerald-400">Last OK {new Date(server.lastOkAt).toLocaleString()}</span>
          ) : server?.lastError ? (
            <span className="text-red-400">{server.lastError}</span>
          ) : (
            <span className="text-zinc-500">Not tested yet</span>
          )}
        </div>

        {/* Containers */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs font-medium flex items-center justify-between">
            <span>Containers</span>
            <button onClick={() => refetchContainers()} className="text-zinc-400 hover:text-zinc-200 p-1 rounded">
              <RefreshCw size={12} className={loadingContainers ? "animate-spin" : ""} />
            </button>
          </div>
          {containersData?.error ? (
            <div className="px-3 py-3 text-xs text-red-400">{containersData.error}</div>
          ) : !containersData || containersData.containers.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-500">No containers found.</div>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {containersData.containers.map((c) => (
                  <tr key={c.name} className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                    <td className="px-3 py-1.5 font-mono">{c.name}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{c.image}</td>
                    <td className="px-3 py-1.5">
                      <span className={`flex items-center gap-1 ${c.running ? "text-emerald-400" : "text-red-400"}`}>
                        {c.running ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Exec console */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
          <div className="text-xs font-medium flex items-center gap-1.5"><Terminal size={12} /> Run command</div>
          <div className="flex gap-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy && !runningJob) run(); }}
              placeholder="e.g. docker compose -f /opt/app/docker-compose.yml ps"
              className="flex-1 bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono"
            />
            <button
              onClick={run}
              disabled={busy || !!runningJob || !cmd.trim()}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded px-3 py-1.5 text-xs disabled:opacity-40"
            >
              <Play size={11} /> Run
            </button>
          </div>

          {activeJobId && (
            <div ref={logBoxRef}
              className="font-mono text-xs p-2.5 max-h-64 overflow-auto bg-zinc-950 text-zinc-300 leading-relaxed rounded">
              {logLines.length === 0 ? (
                <span className="text-zinc-600">Waiting for output…</span>
              ) : (
                logLines.map((l, i) => {
                  const cls = l.includes("✗") || l.includes("FAILED")
                    ? "text-red-400"
                    : l.startsWith("===")
                    ? "text-emerald-400 font-semibold"
                    : l.startsWith("$")
                    ? "text-zinc-500 italic"
                    : "";
                  return <div key={i} className={cls}>{l || " "}</div>;
                })
              )}
            </div>
          )}

          {/* Recent commands */}
          {execData && execData.jobs.length > 0 && (
            <div className="pt-1 space-y-0.5">
              {execData.jobs.slice(0, 8).map((j) => (
                <div key={j.id} className="flex items-center gap-2 text-xs">
                  <span className={STATE_COLOR[j.state] ?? "text-zinc-400"}>{j.state}</span>
                  <span className="font-mono text-zinc-500 truncate flex-1">{j.params?.cmd}</span>
                  <button className="text-emerald-500 hover:underline shrink-0" onClick={() => streamJob(j.id)}>log</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
