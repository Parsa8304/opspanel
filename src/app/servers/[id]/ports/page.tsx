"use client";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { fetcher } from "@/lib/fetcher";

interface PortRow {
  id: string;
  hostName: string;
  port: number;
  protocol: string;
  iface: string;
  processName: string | null;
  serviceName: string | null;
  containerName: string | null;
  discoveredVia: string;
  isPublic: boolean;
  status: string;
}

const BASE_RANGES = [
  { label: "1–1024", from: 1, to: 1024 },
  { label: "3000–9000", from: 3000, to: 9000 },
  { label: "27000+", from: 27000, to: 27100 },
];

function owner(p: PortRow): string {
  return p.containerName || p.serviceName || p.processName || "unknown process";
}

export default function ServerPortsPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [fExposure, setFExposure] = useState("");
  const [fService, setFService] = useState("");
  const [fRange, setFRange] = useState("");

  const portsKey = useMemo(() => {
    if (!id) return null;
    const qs = new URLSearchParams();
    if (fExposure) qs.set("exposure", fExposure);
    if (fService) qs.set("service", fService);
    if (fRange) qs.set("range", fRange);
    return `/api/servers/${id}/ports${qs.toString() ? `?${qs}` : ""}`;
  }, [id, fExposure, fService, fRange]);
  const { data: ports, mutate: refreshPorts, isLoading } = useSWR<PortRow[]>(
    portsKey,
    fetcher
  );

  const { data: conflicts, mutate: refreshConflicts } = useSWR(
    id ? `/api/servers/${id}/ports/conflicts` : null,
    fetcher
  );
  const { data: pub, mutate: refreshPub } = useSWR(
    id ? `/api/servers/${id}/ports/public` : null,
    fetcher
  );

  // ── scan job ──
  const [jobLog, setJobLog] = useState("");
  const [running, setRunning] = useState(false);
  const runScan = async () => {
    if (!id) return;
    setJobLog("");
    setRunning(true);
    const r = await fetch(`/api/servers/${id}/ports/scan`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    if (!r.ok) {
      setJobLog("Failed to start scan: " + r.status);
      setRunning(false);
      return;
    }
    const { jobId } = await r.json();
    const es = new EventSource(`/api/servers/${id}/ports/scan/${jobId}/stream`);
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.logDelta) setJobLog((l) => l + d.logDelta);
        if (
          ["SUCCEEDED", "FAILED", "CANCELLED", "ROLLED_BACK"].includes(d.state)
        ) {
          es.close();
          setRunning(false);
          refreshPorts();
          refreshConflicts();
          refreshPub();
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es.close();
      setRunning(false);
      refreshPorts();
      refreshConflicts();
      refreshPub();
    };
  };

  // ── next free ──
  const [nf, setNf] = useState({ from: "3000", to: "9000" });
  const [nfResult, setNfResult] = useState<string | null>(null);
  const findFree = async () => {
    if (!id) return;
    const qs = new URLSearchParams({ from: nf.from, to: nf.to });
    const r = await fetch(`/api/servers/${id}/ports/next-free?${qs}`, {
      credentials: "include",
    });
    if (!r.ok) {
      setNfResult(null);
      return;
    }
    const d = await r.json();
    setNfResult(d.port == null ? "none free in range" : String(d.port));
  };

  // ── manual register ──
  const [mr, setMr] = useState({ port: "", protocol: "tcp", serviceName: "" });
  const addManual = async () => {
    if (!id) return;
    const r = await fetch(`/api/servers/${id}/ports/manual`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        port: Number(mr.port),
        protocol: mr.protocol,
        serviceName: mr.serviceName || undefined,
      }),
    });
    if (!r.ok) {
      alert("Failed: " + r.status + " " + (await r.text()));
      return;
    }
    setMr({ port: "", protocol: "tcp", serviceName: "" });
    refreshPorts();
    refreshConflicts();
  };

  // index ports by port number for the visual grid
  const portIndex = useMemo(() => {
    const m = new Map<string, PortRow>();
    for (const p of ports || []) {
      const k = `${p.port}`;
      const prev = m.get(k);
      if (!prev || (prev.status === "stale" && p.status === "active"))
        m.set(k, p);
    }
    return m;
  }, [ports]);

  return (
    <div>
      <PageHeader
        title="Ports"
        desc="Port allocation map for this server — scan, conflicts, and public exposure findings."
      />
      <div className="p-6 space-y-8">
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Honest limitation: only ports actually observed via ss/netstat and real Docker
          published ports are reported. A remote server without reachable SSH is not
          scanned and nothing is recorded.
        </p>

        {/* Scan */}
        <section>
          <button
            onClick={runScan}
            disabled={running}
            className="rounded bg-[#09637E] text-white text-sm px-4 py-2 hover:bg-[#088395] disabled:opacity-50"
          >
            {running ? "Scanning…" : "Scan ports"}
          </button>
          {jobLog && (
            <div className="mt-3">
              <div className="text-xs font-medium mb-1">Job log</div>
              <pre className="text-[11px] bg-zinc-950 text-zinc-200 p-3 rounded max-h-56 overflow-auto">
                {jobLog}
              </pre>
            </div>
          )}
        </section>

        {/* Filters + Table */}
        <section>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="text-sm font-semibold">Allocations</h2>
            <div className="flex gap-2 flex-wrap text-xs">
              <select
                value={fExposure}
                onChange={(e) => setFExposure(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
              >
                <option value="">All exposure</option>
                <option value="public">Public</option>
                <option value="local">Local only</option>
              </select>
              <input
                placeholder="from-to"
                value={fRange}
                onChange={(e) => setFRange(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 w-28"
              />
              <input
                placeholder="service / process / container"
                value={fService}
                onChange={(e) => setFService(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
              />
            </div>
          </div>
          {isLoading && (
            <div className="text-center py-10 text-xs text-zinc-500">
              Loading ports…
            </div>
          )}
          {ports && ports.length ? (
            <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-xs">
                <thead className="bg-zinc-100 dark:bg-zinc-800/60">
                  <tr>
                    <th className="p-2 text-start">Port</th>
                    <th className="p-2 text-start">Proto</th>
                    <th className="p-2 text-start">Iface</th>
                    <th className="p-2 text-start">Owner</th>
                    <th className="p-2 text-start">Via</th>
                    <th className="p-2 text-start">Exposure</th>
                    <th className="p-2 text-start">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.map((p) => (
                    <tr
                      key={p.id}
                      className="border-t border-zinc-200 dark:border-zinc-800"
                    >
                      <td className="p-2 font-mono">{p.port}</td>
                      <td className="p-2">{p.protocol}</td>
                      <td className="p-2 font-mono">{p.iface}</td>
                      <td className="p-2">{owner(p)}</td>
                      <td className="p-2">{p.discoveredVia}</td>
                      <td className="p-2">
                        {p.isPublic ? (
                          <span className="rounded bg-red-600 text-white px-1.5 py-0.5 text-[10px]">
                            Public
                          </span>
                        ) : (
                          <span className="rounded bg-emerald-700 text-white px-1.5 py-0.5 text-[10px]">
                            Local only
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        {p.status === "stale" ? (
                          <span className="text-zinc-500">Stale</span>
                        ) : (
                          <span className="text-emerald-600">Active</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !isLoading && <EmptyState msg="No ports recorded yet — run a scan." />
          )}
        </section>

        {/* Visual grid */}
        <section>
          <h2 className="text-sm font-semibold mb-1">Port map</h2>
          <p className="text-[11px] text-zinc-500 mb-2">
            Green = local-only active, red = public active, gray = stale.
          </p>
          <div className="space-y-4">
            {BASE_RANGES.map((rng) => {
              const span = Math.min(rng.to - rng.from + 1, 1200);
              return (
                <div key={`${rng.label}-${rng.from}`}>
                  <div className="text-xs font-medium mb-1">{rng.label}</div>
                  <div className="flex flex-wrap gap-[2px]">
                    {Array.from({ length: span }).map((_, i) => {
                      const port = rng.from + i;
                      const hit = portIndex.get(`${port}`);
                      let cls = "bg-zinc-200 dark:bg-zinc-800";
                      if (hit) {
                        cls =
                          hit.status === "stale"
                            ? "bg-zinc-500"
                            : hit.isPublic
                              ? "bg-red-500"
                              : "bg-emerald-500";
                      }
                      return (
                        <div
                          key={port}
                          title={
                            hit
                              ? `${port}/${hit.protocol} — ${owner(hit)} (${hit.status}${
                                  hit.isPublic ? ", public" : ""
                                })`
                              : `${port} — free`
                          }
                          className={`h-2.5 w-2.5 rounded-[2px] ${cls}`}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Conflicts */}
        <section>
          <h2 className="text-sm font-semibold mb-2">Conflicts</h2>
          {conflicts && conflicts.length ? (
            <div className="space-y-2">
              {conflicts.map((c: any, i: number) => (
                <div
                  key={i}
                  className="rounded border border-red-500/50 bg-red-500/5 p-3 text-xs"
                >
                  <div className="font-semibold text-red-500">
                    {c.port}/{c.protocol}
                  </div>
                  <ul className="mt-1 list-disc ms-4">
                    {c.claimants.map((cl: any, j: number) => (
                      <li key={j}>
                        {cl.owner} — {cl.iface} ({cl.status}, {cl.discoveredVia})
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState msg="No port conflicts detected." />
          )}
        </section>

        {/* Public findings */}
        <section>
          <h2 className="text-sm font-semibold mb-2">Public exposure findings</h2>
          {pub && pub.length ? (
            <div className="space-y-2">
              {pub.map((f: any, i: number) => (
                <div
                  key={i}
                  className={`rounded p-3 text-xs border ${
                    f.severity === "high"
                      ? "border-red-600 bg-red-600/10"
                      : "border-amber-500 bg-amber-500/10"
                  }`}
                >
                  <span
                    className={`font-bold ${
                      f.severity === "high" ? "text-red-500" : "text-amber-500"
                    }`}
                  >
                    {f.severity === "high" ? "HIGH" : "MEDIUM"}
                  </span>{" "}
                  — {f.port}/{f.protocol} bound to {f.iface} → {f.owner} ({f.status})
                </div>
              ))}
            </div>
          ) : (
            <EmptyState msg="No public-exposure findings." />
          )}
        </section>

        {/* Next free port */}
        <section>
          <h2 className="text-sm font-semibold mb-2">Next free port</h2>
          <div className="flex gap-2 flex-wrap items-center text-xs">
            <input
              value={nf.from}
              onChange={(e) => setNf({ ...nf, from: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 w-24"
            />
            <input
              value={nf.to}
              onChange={(e) => setNf({ ...nf, to: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 w-24"
            />
            <button
              onClick={findFree}
              className="rounded bg-[#09637E] text-white px-3 py-1.5 hover:bg-[#088395]"
            >
              Find
            </button>
            {nfResult !== null && (
              <span className="font-mono">Result: {nfResult}</span>
            )}
          </div>
        </section>

        {/* Manual register */}
        <section>
          <h2 className="text-sm font-semibold mb-2">Manually register a port</h2>
          <div className="flex gap-2 flex-wrap items-center text-xs">
            <input
              placeholder="Port"
              value={mr.port}
              onChange={(e) => setMr({ ...mr, port: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 w-24"
            />
            <select
              value={mr.protocol}
              onChange={(e) => setMr({ ...mr, protocol: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
            <input
              placeholder="Owner / service"
              value={mr.serviceName}
              onChange={(e) => setMr({ ...mr, serviceName: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
            <button
              onClick={addManual}
              className="rounded bg-[#09637E] text-white px-3 py-1.5 hover:bg-[#088395]"
            >
              Add
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
