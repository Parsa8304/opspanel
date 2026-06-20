"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// ─── Types ───────────────────────────────────────────────────────
type Container = {
  id: string;
  name: string;
  image: string;
  tag: string;
  status: string;
  state: string;
  uptimeSec: number | null;
  restartCount: number;
  health: string | null;
  ports: { ip?: string; privatePort: number; publicPort?: number; type: string }[];
  mounts: { source: string; destination: string; mode: string; rw: boolean; type: string }[];
  networks: string[];
  env: Record<string, string>;
  composeProject: string | null;
  composeService: string | null;
  dependsOn: string[];
};
type Service = { service: string; containers: Container[]; dependsOn: string[]; dependsInferred: boolean };
type Project = { project: string; services: Service[] };

// ─── Helpers ─────────────────────────────────────────────────────
function fmtUptime(sec: number | null): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.max(1, n)) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
function logLineCls(line: string): string {
  if (/\b(error|err|fatal|crit|critical|exception)\b/i.test(line)) return "text-red-400";
  if (/\b(warn|warning)\b/i.test(line)) return "text-amber-400";
  return "text-zinc-400";
}

// ─── Sub-components ───────────────────────────────────────────────
function StatePill({ state }: { state: string }) {
  const map: Record<string, string> = {
    running: "bg-emerald-600/20 text-emerald-400 border-emerald-700/40",
    exited: "bg-red-600/20 text-red-400 border-red-700/40",
    dead: "bg-red-600/20 text-red-400 border-red-700/40",
    restarting: "bg-amber-500/20 text-amber-400 border-amber-600/40",
    paused: "bg-zinc-500/20 text-zinc-300 border-zinc-600/40",
    created: "bg-zinc-500/20 text-zinc-300 border-zinc-600/40",
  };
  const cls = map[state] || "bg-zinc-500/20 text-zinc-300 border-zinc-600/40";
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs ${cls}`}>{state}</span>;
}

function HealthBadge({ h, lang }: { h: string | null; lang: any }) {
  if (!h) return <span className="text-xs text-zinc-500">{t("noHealth", lang)}</span>;
  const cls = h === "healthy" ? "text-emerald-400" : h === "unhealthy" ? "text-red-400" : "text-amber-400";
  return <span className={`text-xs ${cls}`}>{h}</span>;
}

function StatRow({ serverId, id }: { serverId: string; id: string }) {
  const { data } = useSWR(`/api/servers/${serverId}/containers/${id}/stats`, fetcher, {
    refreshInterval: 5000,
    shouldRetryOnError: false,
  });
  if (!data || data.error) return <span className="text-xs text-zinc-500">—</span>;
  return (
    <div className="flex flex-col gap-1 min-w-[150px]">
      <div className="flex items-center gap-1 text-xs">
        <div className="h-1.5 w-16 rounded bg-zinc-700 shrink-0">
          <div className="h-1.5 rounded bg-emerald-500" style={{ width: `${Math.min(100, data.cpuPercent)}%` }} />
        </div>
        <span className="w-10 tabular-nums text-zinc-300">{data.cpuPercent}%</span>
      </div>
      <div className="flex items-center gap-1 text-xs">
        <div className="h-1.5 w-16 rounded bg-zinc-700 shrink-0">
          <div className="h-1.5 rounded bg-sky-500" style={{ width: `${Math.min(100, data.memPercent)}%` }} />
        </div>
        <span className="w-20 tabular-nums text-zinc-300">{fmtBytes(data.memUsage)}</span>
      </div>
      <div className="flex gap-2 text-[10px] text-zinc-500 tabular-nums">
        <span>↓{fmtBytes(data.netRxBytes)} ↑{fmtBytes(data.netTxBytes)}</span>
        <span>IO:{fmtBytes(data.blockReadBytes + data.blockWriteBytes)}</span>
      </div>
    </div>
  );
}

const LEVEL_PATTERNS: Record<string, RegExp> = {
  ERROR: /\b(error|err|fatal|crit|critical|exception)\b/i,
  WARN: /\b(warn|warning)\b/i,
  INFO: /\b(info|notice)\b/i,
};

function LogDrawer({ serverId, id, name, onClose }: { serverId: string; id: string; name: string; onClose: () => void }) {
  const { lang } = useUI();
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<"ALL" | "ERROR" | "WARN" | "INFO">("ALL");
  const [copied, setCopied] = useState<number | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/servers/${serverId}/containers/${id}/logs/stream?tail=300&follow=1`);
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const d = JSON.parse(ev.data);
        if (typeof d.line === "string") setLines((p) => [...p.slice(-2000), d.line]);
      } catch {}
    };
    es.addEventListener("error", () => {});
    return () => es.close();
  }, [serverId, id]);

  const shown = useMemo(() => {
    let result = lines;
    if (filter.trim()) {
      let re: RegExp | null = null;
      try { re = new RegExp(filter, "i"); } catch { re = null; }
      result = result.filter((l) => re ? re.test(l) : l.toLowerCase().includes(filter.toLowerCase()));
    }
    if (level !== "ALL") result = result.filter((l) => LEVEL_PATTERNS[level].test(l));
    return result;
  }, [lines, filter, level]);

  useEffect(() => { if (!paused) bottomRef.current?.scrollIntoView(); }, [shown, paused]);

  const copyLine = (line: string, i: number) => {
    navigator.clipboard.writeText(line).catch(() => {});
    setCopied(i);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50" onClick={onClose}>
      <div className="flex h-full w-full max-w-3xl flex-col bg-zinc-900 border-s border-zinc-800" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 p-3">
          <span className="font-medium text-sm flex-1 truncate min-w-0">{t("liveLogs", lang)} · {name}</span>
          {(["ALL", "ERROR", "WARN", "INFO"] as const).map((l) => (
            <button key={l} onClick={() => setLevel(l)}
              className={`rounded border px-2 py-1 text-[10px] ${level === l ? "border-[#09637E] bg-[#09637E]/30 text-white" : "border-zinc-700 text-zinc-500"}`}>
              {l}
            </button>
          ))}
          <button onClick={() => setPaused((p) => !p)} className="rounded border border-zinc-700 px-2 py-1 text-xs">
            {paused ? t("resume", lang) : t("pause", lang)}
          </button>
          <a href={`/api/servers/${serverId}/containers/${id}/logs?tail=2000&download=1`} className="rounded border border-zinc-700 px-2 py-1 text-xs">
            {t("download", lang)}
          </a>
          <button onClick={onClose} className="rounded border border-zinc-700 px-2 py-1 text-xs">{t("close", lang)}</button>
        </div>
        <div className="border-b border-zinc-800 p-2">
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={t("filterRegex", lang)}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs" />
        </div>
        <div className="flex-1 overflow-auto bg-zinc-950 p-3 font-mono text-xs leading-relaxed">
          {shown.length === 0 ? (
            <div className="text-zinc-600">{t("loading", lang)}</div>
          ) : (
            shown.map((l, i) => (
              <div key={i} className={`group flex items-start gap-1 whitespace-pre-wrap break-all ${logLineCls(l)}`}>
                <span className="flex-1">{l}</span>
                <button onClick={() => copyLine(l, i)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 rounded px-1 text-[10px] text-zinc-600 hover:text-zinc-300">
                  {copied === i ? "✓" : "⎘"}
                </button>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function ExecPanel({ serverId, id }: { serverId: string; id: string }) {
  const { lang } = useUI();
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const [code, setCode] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!cmd.trim()) return;
    setBusy(true);
    setOut(null);
    try {
      const r = await fetch(`/api/servers/${serverId}/containers/${id}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) });
      const d = await r.json();
      setOut(d.output ?? d.error ?? "");
      setCode(d.exitCode ?? null);
    } catch (e: any) {
      setOut(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder={t("execHint", lang)}
          className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-mono" />
        <button onClick={run} disabled={busy} className="rounded bg-[#09637E] px-3 py-1 text-xs text-white disabled:opacity-50">
          {t("run", lang)}
        </button>
      </div>
      {out != null && (
        <pre className="max-h-60 overflow-auto rounded border border-zinc-700 bg-zinc-950 p-2 text-xs whitespace-pre-wrap break-all">
          {code != null ? `[${t("exitCode", lang)}: ${code}]\n` : ""}{out}
        </pre>
      )}
    </div>
  );
}

function ContainerRow({ serverId, c, canAct, onAction, onLogs, onRemove }: { serverId: string; c: Container; canAct: boolean; onAction: (id: string, action: string) => void; onLogs: (c: Container) => void; onRemove: (c: Container) => void }) {
  const { lang } = useUI();
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-t border-zinc-800 hover:bg-zinc-800/30">
        <td className="px-3 py-2">
          <button onClick={() => setOpen((o) => !o)} className="text-start font-medium text-sm hover:underline">
            {open ? "▾" : "▸"} {c.name}
          </button>
        </td>
        <td className="px-3 py-2 text-xs text-zinc-400">{c.image}:{c.tag}</td>
        <td className="px-3 py-2"><StatePill state={c.state} /></td>
        <td className="px-3 py-2 text-xs">{fmtUptime(c.uptimeSec)}</td>
        <td className="px-3 py-2">{c.state === "running" ? <StatRow serverId={serverId} id={c.id} /> : "—"}</td>
        <td className="px-3 py-2 text-xs tabular-nums">{c.restartCount}</td>
        <td className="px-3 py-2"><HealthBadge h={c.health} lang={lang} /></td>
        <td className="px-3 py-2 text-xs text-zinc-400">
          {c.ports.filter((p) => p.publicPort).map((p) => `${p.publicPort}→${p.privatePort}`).join(", ") || "—"}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            <button onClick={() => onLogs(c)} className="rounded border border-zinc-700 px-2 py-1 text-xs">{t("viewLogs", lang)}</button>
            {canAct && (
              <>
                {c.state === "running" && (
                  <>
                    <button onClick={() => onAction(c.id, "stop")} className="rounded border border-red-700/50 text-red-400 px-2 py-1 text-xs">{t("actionStop", lang)}</button>
                    <button onClick={() => onAction(c.id, "pause")} className="rounded border border-zinc-600 text-zinc-400 px-2 py-1 text-xs">{t("actionPause", lang)}</button>
                  </>
                )}
                {c.state === "paused" && (
                  <button onClick={() => onAction(c.id, "unpause")} className="rounded border border-emerald-700/50 text-emerald-400 px-2 py-1 text-xs">{t("actionUnpause", lang)}</button>
                )}
                {(c.state === "exited" || c.state === "created" || c.state === "dead") && (
                  <button onClick={() => onAction(c.id, "start")} className="rounded border border-emerald-700/50 text-emerald-400 px-2 py-1 text-xs">{t("actionStart", lang)}</button>
                )}
                <button onClick={() => onAction(c.id, "restart")} className="rounded border border-amber-600/50 text-amber-400 px-2 py-1 text-xs">{t("actionRestart", lang)}</button>
                <button onClick={() => onAction(c.id, "pull")} className="rounded border border-zinc-600 text-zinc-300 px-2 py-1 text-xs">{t("actionPull", lang)}</button>
                <button onClick={() => onAction(c.id, "recreate")} className="rounded border border-sky-700/50 text-sky-400 px-2 py-1 text-xs">{t("actionRecreate", lang)}</button>
                <button
                  onClick={() => onRemove(c)}
                  className="rounded border border-red-900/50 text-red-500 px-2 py-1 text-xs"
                >{t("actionRemove", lang)}</button>
              </>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-zinc-800/50 bg-zinc-900/50">
          <td colSpan={9} className="px-6 py-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <div className="mb-1 text-xs font-semibold text-zinc-400">{t("mounts", lang)}</div>
                {c.mounts.length === 0 ? <div className="text-xs text-zinc-600">{t("none", lang)}</div> : (
                  <ul className="space-y-1 text-xs font-mono text-zinc-400">
                    {c.mounts.map((m, i) => <li key={i}>{m.source} → {m.destination} ({m.rw ? "rw" : "ro"})</li>)}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold text-zinc-400">{t("networks", lang)}</div>
                {c.networks.length === 0 ? <div className="text-xs text-zinc-600">{t("none", lang)}</div> : (
                  <ul className="space-y-0.5 text-xs font-mono text-zinc-400">
                    {c.networks.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold text-zinc-400">{t("envVars", lang)}</div>
                {Object.keys(c.env).length === 0 ? <div className="text-xs text-zinc-600">{t("none", lang)}</div> : (
                  <ul className="max-h-40 space-y-0.5 overflow-auto text-xs font-mono text-zinc-400">
                    {Object.entries(c.env).map(([k, v]) => <li key={k}><span className="text-zinc-500">{k}</span>={v}</li>)}
                  </ul>
                )}
              </div>
            </div>
            {canAct && (
              <div>
                <div className="mt-3 text-xs font-semibold text-zinc-400">{t("execPanel", lang)}</div>
                <ExecPanel serverId={serverId} id={c.id} />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ContainerGroupBlock({ s, render }: { s: Service; render: (cs: Container[]) => React.ReactNode }) {
  const { lang } = useUI();
  const allRunning = s.containers.every((c) => c.state === "running");
  const anyBad = s.containers.some((c) => c.state === "exited" || c.state === "dead");
  const healthCls = anyBad ? "text-red-400" : allRunning ? "text-emerald-400" : "text-amber-400";
  return (
    <>
      <tr className="bg-zinc-900/40">
        <td colSpan={9} className="px-3 py-1.5 text-xs text-zinc-400">
          <span className="font-semibold text-emerald-400">{s.service}</span>
          <span className={`ml-2 text-[10px] ${healthCls}`}>
            {s.containers.filter((c) => c.state === "running").length}/{s.containers.length} running
          </span>
          {s.dependsOn.length > 0 && (
            <span className="ms-2">
              {t("dependsOn", lang)}:{" "}
              {s.dependsOn.map((d) => (
                <span key={d} className="ms-1 rounded bg-zinc-800 px-1.5 py-0.5 text-amber-400">
                  {d}{s.dependsInferred && <em className="ms-1 text-zinc-500">({t("inferredDep", lang)})</em>}
                </span>
              ))}
            </span>
          )}
        </td>
      </tr>
      {render(s.containers)}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────
export default function ServerContainersPage() {
  const { lang } = useUI();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const [logTarget, setLogTarget] = useState<Container | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Container | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);

  const { data: me } = useSWR("/api/auth/me", fetcher);
  const canAct = me && ["ADMIN", "ENGINEER"].includes(me.role);

  const { data, error, isLoading, mutate } = useSWR<{ projects: Project[]; ungrouped: Container[] }>(
    id ? `/api/servers/${id}/containers/groups` : null, fetcher, { refreshInterval: 10000 }
  );

  const onAction = async (cid: string, action: string) => {
    try { await fetch(`/api/servers/${id}/containers/${cid}/${action}`, { method: "POST" }); }
    finally { mutate(); }
  };

  const onPrune = async () => {
    try { await fetch(`/api/servers/${id}/containers/prune`, { method: "POST" }); }
    finally { mutate(); }
  };

  const tableHead = (
    <thead className="text-start text-xs uppercase text-zinc-500">
      <tr>
        <th className="px-3 py-2 text-start">{t("colName", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colImage", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colStatus", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colUptime", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colCpu", lang)} / {t("colMem", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colRestarts", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colHealth", lang)}</th>
        <th className="px-3 py-2 text-start">{t("colPorts", lang)}</th>
        <th className="px-3 py-2 text-start"></th>
      </tr>
    </thead>
  );

  const renderRows = (cs: Container[]) =>
    cs.map((c) => (
      <ContainerRow key={c.id} serverId={id} c={c} canAct={!!canAct} onAction={onAction} onLogs={setLogTarget} onRemove={setConfirmRemove} />
    ));

  const allFlat = data ? [...data.projects.flatMap((p) => p.services.flatMap((s) => s.containers)), ...data.ungrouped] : [];

  return (
    <div>
      <ConfirmDialog
        open={!!confirmRemove}
        title={`Remove container "${confirmRemove?.name}"?`}
        message="This will permanently remove the container. The image is kept. This cannot be undone."
        confirmWord={confirmRemove?.name ?? ""}
        confirmLabel="Remove"
        onConfirm={() => { if (confirmRemove) { onAction(confirmRemove.id, "remove"); setConfirmRemove(null); } }}
        onCancel={() => setConfirmRemove(null)}
      />
      <ConfirmDialog
        open={confirmPrune}
        title="Prune stopped containers?"
        message="All stopped containers will be permanently removed. Running containers are not affected."
        confirmWord="prune"
        confirmLabel="Prune"
        onConfirm={() => { setConfirmPrune(false); onPrune(); }}
        onCancel={() => setConfirmPrune(false)}
      />
      <PageHeader title={t("containerMonitoring", lang)} desc={t("containerMonitoringDesc", lang)} />

      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        <button onClick={() => setView("grouped")}
          className={`rounded px-3 py-1 text-xs ${view === "grouped" ? "bg-[#09637E] text-white" : "border border-zinc-700"}`}>
          {t("groupedView", lang)}
        </button>
        <button onClick={() => setView("flat")}
          className={`rounded px-3 py-1 text-xs ${view === "flat" ? "bg-[#09637E] text-white" : "border border-zinc-700"}`}>
          {t("flatView", lang)}
        </button>
        <button onClick={() => mutate()} className="rounded border border-zinc-700 px-3 py-1 text-xs">{t("refresh", lang)}</button>
        {canAct && (
          <button onClick={() => setConfirmPrune(true)} className="rounded border border-red-900/40 text-red-500 px-3 py-1 text-xs">
            {t("pruneContainers", lang)}
          </button>
        )}
      </div>

      {error ? <EmptyState msg={t("dockerUnreachable", lang)} />
        : isLoading ? <EmptyState msg={t("loading", lang)} />
        : !data || allFlat.length === 0 ? <EmptyState msg={t("noContainers", lang)} />
        : view === "flat" ? (
          <div className="m-6 overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full">{tableHead}<tbody>{renderRows(allFlat)}</tbody></table>
          </div>
        ) : (
          <div className="space-y-6 p-6">
            {data.projects.map((p) => {
              const total = p.services.reduce((a, s) => a + s.containers.length, 0);
              const running = p.services.reduce((a, s) => a + s.containers.filter((c) => c.state === "running").length, 0);
              const healthCls = running < total ? "text-amber-400" : "text-emerald-400";
              return (
                <details key={p.project} open className="rounded-lg border border-zinc-800">
                  <summary className="cursor-pointer bg-zinc-900 px-4 py-2 text-sm font-semibold flex items-center gap-2">
                    <span>{p.project}</span>
                    <span className={`text-xs ${healthCls}`}>{running}/{total} running</span>
                  </summary>
                  <div className="overflow-x-auto">
                    <table className="w-full">{tableHead}
                      <tbody>{p.services.map((s) => <ContainerGroupBlock key={s.service} s={s} render={renderRows} />)}</tbody>
                    </table>
                  </div>
                </details>
              );
            })}
            {data.ungrouped.length > 0 && (
              <details open className="rounded-lg border border-zinc-800">
                <summary className="cursor-pointer bg-zinc-900 px-4 py-2 text-sm font-semibold">
                  {t("ungrouped", lang)} <span className="text-zinc-500">({data.ungrouped.length})</span>
                </summary>
                <div className="overflow-x-auto">
                  <table className="w-full">{tableHead}<tbody>{renderRows(data.ungrouped)}</tbody></table>
                </div>
              </details>
            )}
          </div>
        )}

      {logTarget && <LogDrawer serverId={id} id={logTarget.id} name={logTarget.name} onClose={() => setLogTarget(null)} />}
    </div>
  );
}
