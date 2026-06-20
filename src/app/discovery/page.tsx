"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  status: "green" | "yellow" | "red" | "unknown";
  detail: string | null;
}
interface GraphEdge {
  from: string;
  to: string;
  detectionType: "explicit" | "inferred" | "observed";
  label: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  green: "#10b981",
  yellow: "#f59e0b",
  red: "#ef4444",
  unknown: "#71717a",
};
const EDGE_STYLE: Record<string, { stroke: string; dash: string }> = {
  explicit: { stroke: "#10b981", dash: "0" },
  inferred: { stroke: "#3b82f6", dash: "6 4" },
  observed: { stroke: "#a1a1aa", dash: "2 4" },
};

function Graph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const W = 760;
  const H = 420;
  const initial = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 70;
    nodes.forEach((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    return pos;
  }, [nodes]);

  const [pos, setPos] = useState(initial);
  useEffect(() => setPos(initial), [initial]);
  const drag = useRef<string | null>(null);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 select-none"
      style={{ touchAction: "none" }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const r = (e.target as SVGElement).ownerSVGElement!.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * W;
        const y = ((e.clientY - r.top) / r.height) * H;
        setPos((p) => ({ ...p, [drag.current!]: { x, y } }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      {edges.map((e, i) => {
        const a = pos[e.from];
        const b = pos[e.to];
        if (!a || !b) return null;
        const st = EDGE_STYLE[e.detectionType];
        return (
          <g key={i}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={st.stroke}
              strokeWidth={1.5}
              strokeDasharray={st.dash}
            />
            <text
              x={(a.x + b.x) / 2}
              y={(a.y + b.y) / 2 - 3}
              fontSize="9"
              fill="#a1a1aa"
              textAnchor="middle"
            >
              {e.label || e.detectionType}
            </text>
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = pos[n.id];
        if (!p) return null;
        return (
          <g
            key={n.id}
            transform={`translate(${p.x},${p.y})`}
            style={{ cursor: "grab" }}
            onPointerDown={() => (drag.current = n.id)}
          >
            <circle r={22} fill={STATUS_COLOR[n.status]} opacity={0.85} />
            <title>
              {n.label} — {n.kind} — {n.status}
              {n.detail ? `\n${n.detail}` : ""}
            </title>
            <text
              y={4}
              fontSize="9"
              fill="#fff"
              textAnchor="middle"
              fontWeight="bold"
            >
              {n.kind.slice(0, 3)}
            </text>
            <text
              y={38}
              fontSize="10"
              fill="currentColor"
              textAnchor="middle"
              className="text-zinc-700 dark:text-zinc-300"
            >
              {n.label.length > 16 ? n.label.slice(0, 15) + "…" : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ProposalCard({
  p,
  isAdmin,
  onDecide,
  lang,
}: {
  p: any;
  isAdmin: boolean;
  onDecide: (id: string, action: "accept" | "reject") => void;
  lang: any;
}) {
  const [open, setOpen] = useState(false);
  const statusColor =
    p.status === "pending"
      ? "text-amber-500"
      : p.status === "accepted"
        ? "text-emerald-500"
        : p.status === "rejected"
          ? "text-red-500"
          : "text-zinc-500";
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-sm">{p.title}</div>
          <div className="text-xs text-zinc-500 mt-1">{p.description}</div>
        </div>
        <span className={`text-xs font-semibold ${statusColor}`}>
          {p.status}
        </span>
      </div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-3 text-xs text-emerald-600 hover:underline"
      >
        {t("discEvidence", lang)} {open ? "▲" : "▼"}
      </button>
      {open && (
        <pre className="mt-2 text-[11px] bg-zinc-50 dark:bg-zinc-950 p-2 rounded overflow-x-auto max-h-60">
          {JSON.stringify(
            { proposed: p.proposed, evidence: p.evidence },
            null,
            2
          )}
        </pre>
      )}
      {isAdmin && p.status === "pending" && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => onDecide(p.id, "accept")}
            className="rounded bg-indigo-600 text-white text-xs px-3 py-1.5 hover:bg-indigo-500"
          >
            {t("discAccept", lang)}
          </button>
          <button
            onClick={() => onDecide(p.id, "reject")}
            className="rounded border border-zinc-300 dark:border-zinc-700 text-xs px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {t("discReject", lang)}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const { lang } = useUI();
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const isAdmin = (me?.role as Role) === "ADMIN";

  const { data: graphData, mutate: refreshGraph } = useSWR(
    "/api/discovery/graph",
    fetcher,
    { refreshInterval: 0 }
  );

  const [status, setStatus] = useState("");
  const proposalsKey = `/api/discovery/proposals${
    status ? `?status=${status}` : ""
  }`;
  const { data: proposals, mutate: refreshProposals } = useSWR(
    proposalsKey,
    fetcher
  );

  const { data: cfg, mutate: refreshCfg } = useSWR(
    "/api/discovery/config",
    fetcher
  );

  const [jobLog, setJobLog] = useState("");
  const [running, setRunning] = useState(false);

  const runScan = async () => {
    setJobLog("");
    setRunning(true);
    const r = await fetch("/api/discovery/scan", {
      method: "POST",
      credentials: "include",
    });
    if (!r.ok) {
      setJobLog("Failed to start scan: " + r.status);
      setRunning(false);
      return;
    }
    const { jobId } = await r.json();
    const es = new EventSource(`/api/discovery/scan/${jobId}/stream`);
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.logDelta) setJobLog((l) => l + d.logDelta);
        if (
          ["SUCCEEDED", "FAILED", "CANCELLED", "ROLLED_BACK"].includes(d.state)
        ) {
          es.close();
          setRunning(false);
          refreshGraph();
          refreshProposals();
        }
      } catch {
        /* ignore parse */
      }
    };
    es.onerror = () => {
      es.close();
      setRunning(false);
      refreshGraph();
      refreshProposals();
    };
  };

  const decide = async (id: string, action: "accept" | "reject") => {
    const msg =
      action === "accept"
        ? t("discConfirmAccept", lang)
        : t("discConfirmReject", lang);
    if (!confirm(msg)) return;
    const r = await fetch(`/api/discovery/proposals/${id}/${action}`, {
      method: "POST",
      credentials: "include",
    });
    if (!r.ok) {
      alert("Failed: " + r.status + " " + (await r.text()));
      return;
    }
    refreshProposals();
    refreshGraph();
  };

  const [composePaths, setComposePaths] = useState("");
  const [scanInterval, setScanInterval] = useState("");
  const [probePaths, setProbePaths] = useState("");
  const [savedFlag, setSavedFlag] = useState(false);
  useEffect(() => {
    if (cfg) {
      setComposePaths((cfg.composePaths || []).join("\n"));
      setScanInterval(cfg.scanIntervalSec ? String(cfg.scanIntervalSec) : "");
      setProbePaths((cfg.probePaths || []).join("\n"));
    }
  }, [cfg]);

  const saveCfg = async () => {
    const r = await fetch("/api/discovery/config", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        composePaths: composePaths
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        scanIntervalSec: scanInterval ? Number(scanInterval) : undefined,
        probePaths: probePaths
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    });
    if (r.ok) {
      setSavedFlag(true);
      setTimeout(() => setSavedFlag(false), 2000);
      refreshCfg();
    }
  };

  const graph = graphData?.graph;
  const reconcile = graphData?.reconcile;

  return (
    <div>
      <PageHeader title={t("discTitle", lang)} desc={t("discDesc", lang)} />
      <div className="p-6 space-y-6">
        <section>
          {isAdmin ? (
            <button
              onClick={runScan}
              disabled={running}
              className="rounded bg-indigo-600 text-white text-sm px-4 py-2 hover:bg-indigo-500 disabled:opacity-50"
            >
              {running ? t("discRunning", lang) : t("discRun", lang)}
            </button>
          ) : (
            <p className="text-xs text-zinc-500">{t("discAdminOnly", lang)}</p>
          )}
          {jobLog && (
            <div className="mt-3">
              <div className="text-xs font-medium mb-1">
                {t("discJobLog", lang)}
              </div>
              <pre className="text-[11px] bg-zinc-950 text-zinc-200 p-3 rounded max-h-56 overflow-auto">
                {jobLog}
              </pre>
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="text-sm font-semibold">{t("discGraph", lang)}</h2>
            <div className="flex gap-3 text-[11px] text-zinc-500 flex-wrap">
              <span>
                <svg className="inline" width="22" height="6">
                  <line x1="0" y1="3" x2="22" y2="3" stroke="#10b981" strokeWidth="2" />
                </svg>{" "}
                {t("discExplicit", lang)}
              </span>
              <span>
                <svg className="inline" width="22" height="6">
                  <line x1="0" y1="3" x2="22" y2="3" stroke="#3b82f6" strokeWidth="2" strokeDasharray="6 4" />
                </svg>{" "}
                {t("discInferred", lang)}
              </span>
              <span>
                <svg className="inline" width="22" height="6">
                  <line x1="0" y1="3" x2="22" y2="3" stroke="#a1a1aa" strokeWidth="2" strokeDasharray="2 4" />
                </svg>{" "}
                {t("discObserved", lang)}
              </span>
            </div>
          </div>
          {graph && graph.dockerReachable && graph.nodes.length > 0 ? (
            <Graph nodes={graph.nodes} edges={graph.edges} />
          ) : (
            <EmptyState
              msg={
                graph && !graph.dockerReachable
                  ? t("discDockerDown", lang)
                  : t("discGraphEmpty", lang)
              }
            />
          )}
        </section>

        {reconcile && (
          <section>
            <h2 className="text-sm font-semibold mb-2">
              {t("discReconcile", lang)}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              {[
                {
                  title: t("discOrphans", lang),
                  items: reconcile.orphans as string[],
                },
                {
                  title: t("discMissing", lang),
                  items: reconcile.missing as string[],
                },
                {
                  title: t("discDrift", lang),
                  items: (reconcile.versionDrift as any[]).map(
                    (d) =>
                      `${d.service}: compose ${d.composeTag} vs running ${d.runningTag}`
                  ),
                },
              ].map((box) => (
                <div
                  key={box.title}
                  className="rounded border border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900"
                >
                  <div className="font-medium mb-1">{box.title}</div>
                  {box.items && box.items.length ? (
                    <ul className="list-disc ms-4 space-y-0.5">
                      {box.items.map((i, idx) => (
                        <li key={idx}>{i}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-zinc-500">
                      {t("discNoneHonest", lang)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">
              {t("discProposals", lang)}
            </h2>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="">{t("discStatusAll", lang)}</option>
              <option value="pending">{t("discStatusPending", lang)}</option>
              <option value="accepted">{t("discStatusAccepted", lang)}</option>
              <option value="rejected">{t("discStatusRejected", lang)}</option>
              <option value="superseded">
                {t("discStatusSuperseded", lang)}
              </option>
            </select>
          </div>
          {proposals && proposals.length ? (
            <div className="space-y-3">
              {proposals.map((p: any) => (
                <ProposalCard
                  key={p.id}
                  p={p}
                  isAdmin={isAdmin}
                  onDecide={decide}
                  lang={lang}
                />
              ))}
            </div>
          ) : (
            <EmptyState msg={t("discProposalsEmpty", lang)} />
          )}
        </section>

        {isAdmin && (
          <section>
            <h2 className="text-sm font-semibold mb-2">
              {t("discConfig", lang)}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="text-xs">
                <div className="mb-1">{t("discComposePaths", lang)}</div>
                <textarea
                  value={composePaths}
                  onChange={(e) => setComposePaths(e.target.value)}
                  rows={4}
                  className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 font-mono text-[11px]"
                />
              </label>
              <label className="text-xs">
                <div className="mb-1">{t("discScanInterval", lang)}</div>
                <input
                  value={scanInterval}
                  onChange={(e) => setScanInterval(e.target.value)}
                  type="number"
                  className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2"
                />
              </label>
              <label className="text-xs">
                <div className="mb-1">{t("discProbePaths", lang)}</div>
                <textarea
                  value={probePaths}
                  onChange={(e) => setProbePaths(e.target.value)}
                  rows={4}
                  className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 font-mono text-[11px]"
                />
              </label>
            </div>
            <button
              onClick={saveCfg}
              className="mt-3 rounded bg-indigo-600 text-white text-sm px-4 py-2 hover:bg-indigo-500"
            >
              {savedFlag ? t("discSaved", lang) : t("discSave", lang)}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
