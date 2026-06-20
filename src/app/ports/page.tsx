"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";

interface HostRow {
  name: string;
  address: string;
  sshUser: string;
  sshPort: number;
  sshKeySet: boolean;
  sshKeyMasked: string;
  isLocal: boolean;
  lastSeenAt: string | null;
}
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

function owner(p: PortRow, lang: any): string {
  return (
    p.containerName ||
    p.serviceName ||
    p.processName ||
    t("potUnknownProc", lang)
  );
}

export default function Page() {
  const { lang } = useUI();
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const isAdmin = (me?.role as Role) === "ADMIN";

  const { data: hosts, mutate: refreshHosts } = useSWR<HostRow[]>(
    "/api/ports/hosts",
    fetcher
  );

  const [fHost, setFHost] = useState("");
  const [fExposure, setFExposure] = useState("");
  const [fService, setFService] = useState("");
  const [fRange, setFRange] = useState("");

  const portsKey = useMemo(() => {
    const qs = new URLSearchParams();
    if (fHost) qs.set("host", fHost);
    if (fExposure) qs.set("exposure", fExposure);
    if (fService) qs.set("service", fService);
    if (fRange) qs.set("range", fRange);
    return `/api/ports${qs.toString() ? `?${qs}` : ""}`;
  }, [fHost, fExposure, fService, fRange]);
  const { data: ports, mutate: refreshPorts } = useSWR<PortRow[]>(
    portsKey,
    fetcher
  );

  const { data: conflicts, mutate: refreshConflicts } = useSWR(
    "/api/ports/conflicts",
    fetcher
  );
  const { data: pub, mutate: refreshPub } = useSWR(
    "/api/ports/public",
    fetcher
  );
  const { data: cfg, mutate: refreshCfg } = useSWR(
    "/api/ports/config",
    fetcher
  );

  // ── scan job ──
  const [jobLog, setJobLog] = useState("");
  const [running, setRunning] = useState(false);
  const runScan = async () => {
    setJobLog("");
    setRunning(true);
    const r = await fetch("/api/ports/scan", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hosts: [] }),
    });
    if (!r.ok) {
      setJobLog("Failed to start scan: " + r.status);
      setRunning(false);
      return;
    }
    const { jobId } = await r.json();
    const es = new EventSource(`/api/ports/scan/${jobId}/stream`);
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
          refreshHosts();
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

  // ── add host ──
  const [nh, setNh] = useState({
    name: "",
    address: "",
    sshUser: "root",
    sshPort: "22",
    sshKey: "",
  });
  const addHost = async () => {
    const r = await fetch("/api/ports/hosts", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: nh.name,
        address: nh.address,
        sshUser: nh.sshUser,
        sshPort: Number(nh.sshPort) || 22,
        sshKey: nh.sshKey || undefined,
      }),
    });
    if (!r.ok) {
      alert("Failed: " + r.status + " " + (await r.text()));
      return;
    }
    setNh({ name: "", address: "", sshUser: "root", sshPort: "22", sshKey: "" });
    refreshHosts();
  };
  const delHost = async (name: string) => {
    if (!confirm(t("potDeleteHostConfirm", lang))) return;
    const r = await fetch(`/api/ports/hosts/${encodeURIComponent(name)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (r.ok) {
      refreshHosts();
      refreshPorts();
    }
  };

  // ── next free ──
  const [nf, setNf] = useState({ host: "", from: "3000", to: "9000" });
  const [nfResult, setNfResult] = useState<string | null>(null);
  const findFree = async () => {
    const qs = new URLSearchParams({
      host: nf.host || (hosts?.[0]?.name ?? "local"),
      from: nf.from,
      to: nf.to,
    });
    const r = await fetch(`/api/ports/next-free?${qs}`, {
      credentials: "include",
    });
    if (!r.ok) {
      setNfResult(null);
      return;
    }
    const d = await r.json();
    setNfResult(
      d.port == null ? t("potNextFreeNone", lang) : String(d.port)
    );
  };

  // ── manual register ──
  const [mr, setMr] = useState({
    hostName: "",
    port: "",
    protocol: "tcp",
    serviceName: "",
  });
  const addManual = async () => {
    const r = await fetch("/api/ports/manual", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostName: mr.hostName || (hosts?.[0]?.name ?? "local"),
        port: Number(mr.port),
        protocol: mr.protocol,
        serviceName: mr.serviceName || undefined,
      }),
    });
    if (!r.ok) {
      alert("Failed: " + r.status + " " + (await r.text()));
      return;
    }
    setMr({ hostName: "", port: "", protocol: "tcp", serviceName: "" });
    refreshPorts();
    refreshConflicts();
  };

  // ── config ──
  const [cfgRanges, setCfgRanges] = useState("");
  const [cfgHosts, setCfgHosts] = useState("");
  const [savedFlag, setSavedFlag] = useState(false);
  useEffect(() => {
    if (cfg) {
      setCfgRanges(
        (cfg.ranges || [])
          .map((r: any) => `${r.label},${r.from},${r.to}`)
          .join("\n")
      );
      setCfgHosts((cfg.defaultScanHosts || []).join(", "));
    }
  }, [cfg]);
  const saveCfg = async () => {
    const ranges = cfgRanges
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [label, from, to] = l.split(",").map((s) => s.trim());
        return { label, from: Number(from), to: Number(to) };
      })
      .filter(
        (r) => r.label && Number.isFinite(r.from) && Number.isFinite(r.to)
      );
    const r = await fetch("/api/ports/config", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ranges,
        defaultScanHosts: cfgHosts
          .split(",")
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

  const allRanges = useMemo(() => {
    const extra = (cfg?.ranges || []) as {
      label: string;
      from: number;
      to: number;
    }[];
    return [...BASE_RANGES, ...extra];
  }, [cfg]);

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
      <PageHeader title={t("potTitle", lang)} desc={t("potDesc", lang)} />
      <div className="p-6 space-y-8">
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t("potScanLimitation", lang)}
        </p>

        {/* Hosts */}
        <section>
          <h2 className="text-sm font-semibold mb-2">{t("potHosts", lang)}</h2>
          {!isAdmin && (
            <p className="text-xs text-zinc-500 mb-2">
              {t("potAdminOnly", lang)}
            </p>
          )}
          <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="bg-zinc-100 dark:bg-zinc-800/60">
                <tr>
                  <th className="p-2 text-start">{t("potHostName", lang)}</th>
                  <th className="p-2 text-start">{t("potAddress", lang)}</th>
                  <th className="p-2 text-start">{t("potSshUser", lang)}</th>
                  <th className="p-2 text-start">SSH</th>
                  <th className="p-2 text-start">{t("potLastSeen", lang)}</th>
                  {isAdmin && <th className="p-2"></th>}
                </tr>
              </thead>
              <tbody>
                {(hosts || []).map((h) => (
                  <tr
                    key={h.name}
                    className="border-t border-zinc-200 dark:border-zinc-800"
                  >
                    <td className="p-2 font-medium">
                      {h.name}{" "}
                      {h.isLocal && (
                        <span className="rounded bg-indigo-600 text-white px-1.5 py-0.5 text-[10px]">
                          {t("potLocalBadge", lang)}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      {h.address}:{h.sshPort}
                    </td>
                    <td className="p-2">{h.sshUser}</td>
                    <td className="p-2">
                      {h.isLocal ? (
                        <span className="text-zinc-500">—</span>
                      ) : h.sshKeySet ? (
                        <span className="text-emerald-600">
                          {t("potKeySet", lang)} ({h.sshKeyMasked})
                        </span>
                      ) : (
                        <span className="text-amber-600">
                          {t("potNoKey", lang)}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      {h.lastSeenAt
                        ? fmtDate(h.lastSeenAt, lang)
                        : t("potNever", lang)}
                    </td>
                    {isAdmin && (
                      <td className="p-2 text-end">
                        {!h.isLocal && (
                          <button
                            onClick={() => delHost(h.name)}
                            className="text-red-500 hover:underline"
                          >
                            {t("potDelete", lang)}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {(!hosts || hosts.length === 0) && (
                  <tr>
                    <td colSpan={6} className="p-3 text-center text-zinc-500">
                      {t("potNoPorts", lang)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {isAdmin && (
            <div className="mt-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
              <input
                placeholder={t("potHostName", lang)}
                value={nh.name}
                onChange={(e) => setNh({ ...nh, name: e.target.value })}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs"
              />
              <input
                placeholder={t("potAddress", lang)}
                value={nh.address}
                onChange={(e) => setNh({ ...nh, address: e.target.value })}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs"
              />
              <input
                placeholder={t("potSshUser", lang)}
                value={nh.sshUser}
                onChange={(e) => setNh({ ...nh, sshUser: e.target.value })}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs"
              />
              <input
                placeholder={t("potSshPort", lang)}
                value={nh.sshPort}
                onChange={(e) => setNh({ ...nh, sshPort: e.target.value })}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs"
              />
              <input
                placeholder={t("potSshKey", lang)}
                type="password"
                value={nh.sshKey}
                onChange={(e) => setNh({ ...nh, sshKey: e.target.value })}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs"
              />
              <button
                onClick={addHost}
                className="rounded bg-indigo-600 text-white text-xs px-3 py-1.5 hover:bg-indigo-500"
              >
                {t("potAddHost", lang)}
              </button>
            </div>
          )}
        </section>

        {/* Scan */}
        <section>
          {isAdmin ? (
            <button
              onClick={runScan}
              disabled={running}
              className="rounded bg-indigo-600 text-white text-sm px-4 py-2 hover:bg-indigo-500 disabled:opacity-50"
            >
              {running ? t("potScanning", lang) : t("potScan", lang)}
            </button>
          ) : (
            <p className="text-xs text-zinc-500">{t("potAdminOnly", lang)}</p>
          )}
          {jobLog && (
            <div className="mt-3">
              <div className="text-xs font-medium mb-1">
                {t("potJobLog", lang)}
              </div>
              <pre className="text-[11px] bg-zinc-950 text-zinc-200 p-3 rounded max-h-56 overflow-auto">
                {jobLog}
              </pre>
            </div>
          )}
        </section>

        {/* Filters + Table */}
        <section>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h2 className="text-sm font-semibold">{t("potTable", lang)}</h2>
            <div className="flex gap-2 flex-wrap text-xs">
              <select
                value={fHost}
                onChange={(e) => setFHost(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
              >
                <option value="">{t("potFilterHost", lang)}</option>
                {(hosts || []).map((h) => (
                  <option key={h.name} value={h.name}>
                    {h.name}
                  </option>
                ))}
              </select>
              <select
                value={fExposure}
                onChange={(e) => setFExposure(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
              >
                <option value="">{t("potFilterExposure", lang)}</option>
                <option value="public">{t("potPublic", lang)}</option>
                <option value="local">{t("potLocalOnly", lang)}</option>
              </select>
              <input
                placeholder={t("potFilterRange", lang)}
                value={fRange}
                onChange={(e) => setFRange(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 w-28"
              />
              <input
                placeholder={t("potFilterService", lang)}
                value={fService}
                onChange={(e) => setFService(e.target.value)}
                className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
              />
            </div>
          </div>
          {ports && ports.length ? (
            <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-xs">
                <thead className="bg-zinc-100 dark:bg-zinc-800/60">
                  <tr>
                    <th className="p-2 text-start">{t("potColHost", lang)}</th>
                    <th className="p-2 text-start">{t("potColPort", lang)}</th>
                    <th className="p-2 text-start">{t("potColProto", lang)}</th>
                    <th className="p-2 text-start">{t("potColIface", lang)}</th>
                    <th className="p-2 text-start">{t("potColOwner", lang)}</th>
                    <th className="p-2 text-start">{t("potColVia", lang)}</th>
                    <th className="p-2 text-start">
                      {t("potColExposure", lang)}
                    </th>
                    <th className="p-2 text-start">
                      {t("potColStatus", lang)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ports.map((p) => (
                    <tr
                      key={p.id}
                      className="border-t border-zinc-200 dark:border-zinc-800"
                    >
                      <td className="p-2">{p.hostName}</td>
                      <td className="p-2 font-mono">{p.port}</td>
                      <td className="p-2">{p.protocol}</td>
                      <td className="p-2 font-mono">{p.iface}</td>
                      <td className="p-2">{owner(p, lang)}</td>
                      <td className="p-2">{p.discoveredVia}</td>
                      <td className="p-2">
                        {p.isPublic ? (
                          <span className="rounded bg-red-600 text-white px-1.5 py-0.5 text-[10px]">
                            {t("potPublic", lang)}
                          </span>
                        ) : (
                          <span className="rounded bg-emerald-700 text-white px-1.5 py-0.5 text-[10px]">
                            {t("potLocalOnly", lang)}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        {p.status === "stale" ? (
                          <span className="text-zinc-500">
                            {t("potStale", lang)}
                          </span>
                        ) : (
                          <span className="text-emerald-600">
                            {t("potActive", lang)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState msg={t("potNoPorts", lang)} />
          )}
        </section>

        {/* Visual grid */}
        <section>
          <h2 className="text-sm font-semibold mb-1">{t("potGrid", lang)}</h2>
          <p className="text-[11px] text-zinc-500 mb-2">
            {t("potGridHint", lang)}
          </p>
          <div className="space-y-4">
            {allRanges.map((rng) => {
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
                              ? `${port}/${hit.protocol} — ${owner(
                                  hit,
                                  lang
                                )} (${hit.status}${
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
          <h2 className="text-sm font-semibold mb-2">
            {t("potConflicts", lang)}
          </h2>
          {conflicts && conflicts.length ? (
            <div className="space-y-2">
              {conflicts.map((c: any, i: number) => (
                <div
                  key={i}
                  className="rounded border border-red-500/50 bg-red-500/5 p-3 text-xs"
                >
                  <div className="font-semibold text-red-500">
                    {c.hostName} · {c.port}/{c.protocol}
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
            <EmptyState msg={t("potConflictsEmpty", lang)} />
          )}
        </section>

        {/* Public findings */}
        <section>
          <h2 className="text-sm font-semibold mb-2">
            {t("potPublicFindings", lang)}
          </h2>
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
                      f.severity === "high"
                        ? "text-red-500"
                        : "text-amber-500"
                    }`}
                  >
                    {f.severity === "high"
                      ? t("potSevHigh", lang)
                      : t("potSevMedium", lang)}
                  </span>{" "}
                  — {f.hostName} · {f.port}/{f.protocol} bound to {f.iface} →{" "}
                  {f.owner} ({f.status})
                </div>
              ))}
            </div>
          ) : (
            <EmptyState msg={t("potPublicEmpty", lang)} />
          )}
        </section>

        {/* Next free port */}
        <section>
          <h2 className="text-sm font-semibold mb-2">
            {t("potNextFree", lang)}
          </h2>
          <div className="flex gap-2 flex-wrap items-center text-xs">
            <select
              value={nf.host}
              onChange={(e) => setNf({ ...nf, host: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              {(hosts || []).map((h) => (
                <option key={h.name} value={h.name}>
                  {h.name}
                </option>
              ))}
            </select>
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
              className="rounded bg-indigo-600 text-white px-3 py-1.5 hover:bg-indigo-500"
            >
              {t("potNextFreeFind", lang)}
            </button>
            {nfResult !== null && (
              <span className="font-mono">
                {t("potNextFreeResult", lang)}: {nfResult}
              </span>
            )}
          </div>
        </section>

        {/* Manual register + Config (ADMIN) */}
        {isAdmin && (
          <>
            <section>
              <h2 className="text-sm font-semibold mb-2">
                {t("potManual", lang)}
              </h2>
              <div className="flex gap-2 flex-wrap items-center text-xs">
                <select
                  value={mr.hostName}
                  onChange={(e) =>
                    setMr({ ...mr, hostName: e.target.value })
                  }
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
                >
                  {(hosts || []).map((h) => (
                    <option key={h.name} value={h.name}>
                      {h.name}
                    </option>
                  ))}
                </select>
                <input
                  placeholder={t("potColPort", lang)}
                  value={mr.port}
                  onChange={(e) => setMr({ ...mr, port: e.target.value })}
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 w-24"
                />
                <select
                  value={mr.protocol}
                  onChange={(e) =>
                    setMr({ ...mr, protocol: e.target.value })
                  }
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
                <input
                  placeholder={t("potColOwner", lang)}
                  value={mr.serviceName}
                  onChange={(e) =>
                    setMr({ ...mr, serviceName: e.target.value })
                  }
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
                />
                <button
                  onClick={addManual}
                  className="rounded bg-indigo-600 text-white px-3 py-1.5 hover:bg-indigo-500"
                >
                  {t("potManualAdd", lang)}
                </button>
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold mb-2">
                {t("potConfig", lang)}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-xs">
                  <div className="mb-1">{t("potConfigRanges", lang)}</div>
                  <textarea
                    value={cfgRanges}
                    onChange={(e) => setCfgRanges(e.target.value)}
                    rows={4}
                    className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 font-mono text-[11px]"
                  />
                </label>
                <label className="text-xs">
                  <div className="mb-1">{t("potConfigHosts", lang)}</div>
                  <input
                    value={cfgHosts}
                    onChange={(e) => setCfgHosts(e.target.value)}
                    className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent p-2 text-xs"
                  />
                </label>
              </div>
              <button
                onClick={saveCfg}
                className="mt-3 rounded bg-indigo-600 text-white text-sm px-4 py-2 hover:bg-indigo-500"
              >
                {savedFlag ? t("potSaved", lang) : t("potSave", lang)}
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
