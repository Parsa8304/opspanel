import { exec } from "child_process";
import { promisify } from "util";
import { NodeSSH } from "node-ssh";
import { prisma } from "./prisma";
import { createJob, runJob } from "./jobs";
import { listContainers } from "./docker";
import { decryptSecret } from "./crypto";
import { hostExec } from "./server";

/**
 * Section 15 — Port Allocation Map.
 *
 * HONESTY: this module only reports ports it actually observed by running a
 * real `ss`/`netstat` on the local host (or remotely over real SSH) and by
 * reading real Docker published ports. A port whose owning process cannot be
 * determined is reported honestly as an unknown process — never guessed.
 * Remote hosts require SSH credentials; without a configured SSH key the
 * remote host is NOT scanned and a typed error is returned — we never pretend
 * a remote host was scanned. Stale allocations are kept (status "stale"),
 * never deleted, because allocation history matters.
 */

const execAsync = promisify(exec);

export const LOCAL_HOST = process.env.PANEL_LOCAL_HOST || "local";

export interface ObservedPort {
  port: number;
  protocol: string; // tcp | udp
  iface: string; // 0.0.0.0 | 127.0.0.1 | :: | ::1 | specific addr
  processName: string | null; // null = honestly unknown
  pid: number | null;
  isPublic: boolean; // bound to 0.0.0.0 or :: (non-loopback)
  containerName: string | null;
  serviceName: string | null;
  discoveredVia: "netstat" | "docker";
}

export interface ScanResult {
  hostName: string;
  reachable: boolean;
  error: string | null;
  observed: ObservedPort[];
}

/** Typed error so callers can distinguish "no SSH key / unreachable" honestly. */
export class RemoteScanError extends Error {
  code: "NO_SSH_KEY" | "UNREACHABLE" | "NO_MASTER_KEY";
  constructor(
    code: "NO_SSH_KEY" | "UNREACHABLE" | "NO_MASTER_KEY",
    message: string
  ) {
    super(message);
    this.name = "RemoteScanError";
    this.code = code;
  }
}

// ─────────────────────────── ss/netstat parsing ───────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeIface(rawAddr: string): { iface: string; isPublic: boolean } {
  let a = rawAddr.trim();
  // ss uses *:port and [::]:port and 0.0.0.0:port; netstat similar
  if (a === "*") a = "0.0.0.0";
  // strip surrounding [] for ipv6
  a = a.replace(/^\[/, "").replace(/\]$/, "");
  if (a === "" || a === "*") a = "0.0.0.0";
  const isWildcard = a === "0.0.0.0" || a === "::";
  const isLoop = LOOPBACK.has(a) || a.startsWith("127.") || a === "::1";
  return { iface: a, isPublic: isWildcard && !isLoop };
}

/** Split an "address:port" tail into [address, port] handling IPv6. */
function splitAddrPort(token: string): { addr: string; port: number } | null {
  const idx = token.lastIndexOf(":");
  if (idx === -1) return null;
  const addr = token.slice(0, idx);
  const portStr = token.slice(idx + 1);
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { addr, port };
}

/**
 * Parse `ss -tlnp` / `ss -ulnp` (and the equivalent `netstat -tlnp/-ulnp`)
 * output. Only LISTEN sockets are taken for tcp; udp sockets are all bound.
 */
export function parseSsOutput(
  text: string,
  protocol: "tcp" | "udp"
): ObservedPort[] {
  const out: ObservedPort[] = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(Netid|State|Active|Proto|Recv-Q)/i.test(line)) continue;

    const cols = line.split(/\s+/);
    // ss -tlnp: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
    // ss -ulnp: UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:(("..."))
    // netstat -tlnp: Proto Recv-Q Send-Q Local-Address Foreign-Address State PID/Program
    let localTok: string | undefined;
    let procField = "";
    let isNetstat = false;

    if (/^(tcp|tcp6|udp|udp6)$/i.test(cols[0])) {
      // netstat style
      isNetstat = true;
      localTok = cols[3];
      if (protocol === "tcp") {
        // must be LISTEN
        if (!cols.includes("LISTEN")) continue;
      }
      procField = cols[cols.length - 1];
    } else {
      // ss style: for tcp the first col is the state (LISTEN); udp is UNCONN
      if (protocol === "tcp" && !/^LISTEN$/i.test(cols[0])) continue;
      localTok = cols[3];
      procField = cols.slice(4).join(" ");
    }
    if (!localTok) continue;

    const sp = splitAddrPort(localTok);
    if (!sp) continue;
    const { iface, isPublic } = normalizeIface(sp.addr);

    // Extract pid + process name honestly; null when not determinable.
    let processName: string | null = null;
    let pid: number | null = null;
    if (isNetstat) {
      // procField like "1234/sshd" or "-"
      const m = procField.match(/^(\d+)\/(.+)$/);
      if (m) {
        pid = parseInt(m[1], 10);
        processName = m[2];
      }
    } else {
      // ss: users:(("sshd",pid=1234,fd=3))
      const m = procField.match(/users:\(\("([^"]+)",pid=(\d+)/);
      if (m) {
        processName = m[1];
        pid = parseInt(m[2], 10);
      }
    }

    out.push({
      port: sp.port,
      protocol,
      iface,
      processName,
      pid,
      isPublic,
      containerName: null,
      serviceName: null,
      discoveredVia: "netstat",
    });
  }
  return out;
}

/** Dedupe by port+protocol+iface, preferring a row that has a process name. */
function dedupe(ports: ObservedPort[]): ObservedPort[] {
  const map = new Map<string, ObservedPort>();
  for (const p of ports) {
    const key = `${p.port}|${p.protocol}|${p.iface}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, p);
      continue;
    }
    // keep the richer record
    if (!prev.processName && p.processName) map.set(key, p);
    else if (!prev.containerName && p.containerName)
      map.set(key, { ...prev, containerName: p.containerName, serviceName: p.serviceName });
  }
  return Array.from(map.values());
}

// ──────────────────────── Docker reconciliation ────────────────────────

/** Attach containerName/serviceName where a published port maps to a container. */
async function attachDocker(observed: ObservedPort[]): Promise<ObservedPort[]> {
  let containers;
  try {
    containers = await listContainers();
  } catch {
    return observed; // Docker not reachable — honest: no container attribution
  }
  // Build a map of publicPort/type -> container.
  const byPort = new Map<string, { name: string; service: string | null }>();
  for (const c of containers) {
    for (const p of c.ports) {
      if (p.publicPort == null) continue;
      byPort.set(`${p.publicPort}|${p.type}`, {
        name: c.name,
        service: c.composeService || c.name,
      });
    }
  }
  return observed.map((o) => {
    const hit = byPort.get(`${o.port}|${o.protocol}`);
    if (hit) {
      return {
        ...o,
        containerName: hit.name,
        serviceName: o.serviceName ?? hit.service,
        discoveredVia: "docker" as const,
      };
    }
    return o;
  });
}

// ─────────────────────────── Local scan ───────────────────────────

const SS_TCP = "ss -tlnp 2>/dev/null";
const SS_UDP = "ss -ulnp 2>/dev/null";
const NETSTAT_TCP = "netstat -tlnp 2>/dev/null";
const NETSTAT_UDP = "netstat -ulnp 2>/dev/null";

async function tryExecLocal(cmd: string): Promise<string | null> {
  // Prefer the host namespace (the panel runs in a container that does not
  // ship ss/netstat and whose own netns only sees container-local sockets).
  // nsenter -t 1 puts us in the host's mount + network namespace so we see the
  // real host listeners. Fall back to in-container exec for non-containerized
  // / local-dev runs where nsenter is unavailable.
  try {
    const { stdout } = await hostExec(cmd, 15000);
    if (stdout && stdout.trim()) return stdout;
  } catch (e: any) {
    if (e && typeof e.stdout === "string" && e.stdout.trim().length > 0)
      return e.stdout;
    // fall through to plain exec
  }
  try {
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    return stdout;
  } catch (e: any) {
    // ss/netstat exit non-zero but still print rows in some cases
    if (e && typeof e.stdout === "string" && e.stdout.length > 0)
      return e.stdout;
    return null;
  }
}

export async function scanLocalPorts(): Promise<ObservedPort[]> {
  const result: ObservedPort[] = [];

  // TCP: prefer ss, fall back to netstat.
  let tcpText = await tryExecLocal(SS_TCP);
  if (tcpText == null || tcpText.trim() === "")
    tcpText = await tryExecLocal(NETSTAT_TCP);
  if (tcpText) result.push(...parseSsOutput(tcpText, "tcp"));

  // UDP: prefer ss, fall back to netstat.
  let udpText = await tryExecLocal(SS_UDP);
  if (udpText == null || udpText.trim() === "")
    udpText = await tryExecLocal(NETSTAT_UDP);
  if (udpText) result.push(...parseSsOutput(udpText, "udp"));

  const withDocker = await attachDocker(dedupe(result));
  return dedupe(withDocker);
}

// ─────────────────────────── Remote scan ───────────────────────────

export async function scanRemotePorts(host: {
  name: string;
  address: string;
  sshUser: string;
  sshPort: number;
  sshKeyEnc: string | null;
}): Promise<ObservedPort[]> {
  if (!host.sshKeyEnc) {
    throw new RemoteScanError(
      "NO_SSH_KEY",
      `Remote host "${host.name}" has no SSH key configured — not scanned (honest limitation). No data recorded.`
    );
  }
  let privateKey: string;
  try {
    privateKey = decryptSecret(host.sshKeyEnc);
  } catch (e) {
    throw new RemoteScanError(
      "NO_MASTER_KEY",
      `Cannot decrypt SSH key for "${host.name}": ${
        e instanceof Error ? e.message : "decrypt failed"
      } — not scanned, nothing recorded.`
    );
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: host.address,
      port: host.sshPort,
      username: host.sshUser,
      privateKey,
      readyTimeout: 10000,
    });
  } catch (e) {
    throw new RemoteScanError(
      "UNREACHABLE",
      `Remote host "${host.name}" (${host.address}:${host.sshPort}) unreachable over SSH: ${
        e instanceof Error ? e.message : "connect failed"
      } — nothing recorded.`
    );
  }

  try {
    const out: ObservedPort[] = [];
    const run = async (cmd: string): Promise<string> => {
      const r = await ssh.execCommand(cmd);
      return r.stdout || "";
    };
    let tcpText = await run("ss -tlnp 2>/dev/null");
    if (!tcpText.trim()) tcpText = await run("netstat -tlnp 2>/dev/null");
    if (tcpText.trim()) out.push(...parseSsOutput(tcpText, "tcp"));

    let udpText = await run("ss -ulnp 2>/dev/null");
    if (!udpText.trim()) udpText = await run("netstat -ulnp 2>/dev/null");
    if (udpText.trim()) out.push(...parseSsOutput(udpText, "udp"));

    return dedupe(out);
  } finally {
    ssh.dispose();
  }
}

// ─────────────────────────── Reconcile / persist ───────────────────────────

/** Ensure a Host row exists; auto-create the local host if absent. */
export async function ensureHost(hostName: string): Promise<void> {
  const existing = await prisma.host.findUnique({ where: { name: hostName } });
  if (existing) return;
  const isLocal = hostName === LOCAL_HOST;
  await prisma.host.create({
    data: {
      name: hostName,
      address: isLocal ? "127.0.0.1" : hostName,
      isLocal,
      lastSeenAt: new Date(),
    },
  });
}

export interface ReconcileResult {
  upserted: number;
  markedStale: number;
}

/**
 * Upsert observed PortAllocation rows (unique hostName+port+protocol+iface),
 * update lastSeen. Rows previously active for this host but NOT seen in this
 * scan are marked status "stale" — never deleted (history matters).
 */
export async function reconcile(
  hostName: string,
  observed: ObservedPort[]
): Promise<ReconcileResult> {
  await ensureHost(hostName);
  const now = new Date();
  let upserted = 0;

  const seenKeys = new Set<string>();
  for (const o of observed) {
    const key = `${o.port}|${o.protocol}|${o.iface}`;
    seenKeys.add(key);
    await prisma.portAllocation.upsert({
      where: {
        serverId_hostName_port_protocol_iface: {
          serverId: "local",
          hostName,
          port: o.port,
          protocol: o.protocol,
          iface: o.iface,
        },
      },
      create: {
        hostName,
        port: o.port,
        protocol: o.protocol,
        iface: o.iface,
        processName: o.processName,
        serviceName: o.serviceName,
        containerName: o.containerName,
        discoveredVia: o.discoveredVia,
        isPublic: o.isPublic,
        status: "active",
        firstSeen: now,
        lastSeen: now,
      },
      update: {
        processName: o.processName,
        serviceName: o.serviceName,
        containerName: o.containerName,
        discoveredVia: o.discoveredVia,
        isPublic: o.isPublic,
        status: "active",
        lastSeen: now,
      },
    });
    upserted++;
  }

  // Mark rows not seen this scan as stale (do not delete).
  const existing = await prisma.portAllocation.findMany({
    where: { hostName, status: "active" },
  });
  const staleIds: string[] = [];
  for (const row of existing) {
    const key = `${row.port}|${row.protocol}|${row.iface}`;
    if (!seenKeys.has(key)) staleIds.push(row.id);
  }
  if (staleIds.length) {
    await prisma.portAllocation.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "stale" },
    });
  }

  await prisma.host.update({
    where: { name: hostName },
    data: { lastSeenAt: now },
  });

  return { upserted, markedStale: staleIds.length };
}

// ─────────────────────────── Findings ───────────────────────────

export interface PortConflict {
  port: number;
  protocol: string;
  hostName: string;
  claimants: {
    iface: string;
    owner: string;
    status: string;
    discoveredVia: string;
  }[];
}

/**
 * Ports claimed by more than one distinct service/container on the same host
 * (including a stale row vs an active row on the same port).
 */
export async function detectConflicts(
  hostName: string
): Promise<PortConflict[]> {
  const rows = await prisma.portAllocation.findMany({
    where: { hostName },
    orderBy: [{ port: "asc" }, { protocol: "asc" }],
  });
  const byPort = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.port}|${r.protocol}`;
    if (!byPort.has(k)) byPort.set(k, []);
    byPort.get(k)!.push(r);
  }
  const conflicts: PortConflict[] = [];
  for (const [, group] of Array.from(byPort.entries())) {
    const owners = new Set(
      group.map(
        (g) =>
          g.containerName ||
          g.serviceName ||
          g.processName ||
          `unknown(${g.iface})`
      )
    );
    if (owners.size > 1 || group.length > 1) {
      // Only flag when owners differ OR multiple rows (e.g. stale vs active).
      const distinctOwners = owners.size > 1;
      const multipleRows = group.length > 1;
      if (!distinctOwners && !multipleRows) continue;
      conflicts.push({
        port: group[0].port,
        protocol: group[0].protocol,
        hostName,
        claimants: group.map((g) => ({
          iface: g.iface,
          owner:
            g.containerName ||
            g.serviceName ||
            g.processName ||
            "unknown process",
          status: g.status,
          discoveredVia: g.discoveredVia,
        })),
      });
    }
  }
  return conflicts;
}

export interface PublicFinding {
  port: number;
  protocol: string;
  iface: string;
  owner: string;
  status: string;
  severity: "high" | "medium";
}

/** Ports bound to 0.0.0.0 / :: → security findings with severity. */
export async function publicFindings(
  hostName: string
): Promise<PublicFinding[]> {
  const rows = await prisma.portAllocation.findMany({
    where: { hostName, isPublic: true },
    orderBy: { port: "asc" },
  });
  return rows.map((r) => ({
    port: r.port,
    protocol: r.protocol,
    iface: r.iface,
    owner:
      r.containerName || r.serviceName || r.processName || "unknown process",
    status: r.status,
    // Active public bind is high; a stale public record is medium.
    severity: r.status === "active" ? "high" : "medium",
  }));
}

/**
 * Lowest port in [rangeStart, rangeEnd] not in ANY allocation (active OR stale)
 * for that host.
 */
export async function nextFreePort(
  hostName: string,
  rangeStart: number,
  rangeEnd: number
): Promise<number | null> {
  const rows = await prisma.portAllocation.findMany({
    where: { hostName, port: { gte: rangeStart, lte: rangeEnd } },
    select: { port: true },
  });
  const taken = new Set(rows.map((r) => r.port));
  for (let p = rangeStart; p <= rangeEnd; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

// ─────────────────────────── Config ───────────────────────────

export interface PortsConfig {
  ranges?: { label: string; from: number; to: number }[];
  defaultScanHosts?: string[];
}

export async function getPortsConfig(): Promise<PortsConfig> {
  const row = await prisma.setting.findUnique({ where: { key: "ports" } });
  return (row?.value as PortsConfig) ?? {};
}

export async function setPortsConfig(cfg: PortsConfig): Promise<PortsConfig> {
  const clean: PortsConfig = {
    ranges: Array.isArray(cfg.ranges)
      ? cfg.ranges
          .filter(
            (r) =>
              r &&
              typeof r.label === "string" &&
              Number.isFinite(r.from) &&
              Number.isFinite(r.to)
          )
          .map((r) => ({
            label: r.label,
            from: Math.floor(r.from),
            to: Math.floor(r.to),
          }))
      : undefined,
    defaultScanHosts: Array.isArray(cfg.defaultScanHosts)
      ? cfg.defaultScanHosts.filter(Boolean)
      : undefined,
  };
  await prisma.setting.upsert({
    where: { key: "ports" },
    create: { key: "ports", value: clean as object },
    update: { value: clean as object },
  });
  return clean;
}

// ─────────────────────────── Job runner ───────────────────────────

/**
 * Background portscan job. Scans the local host directly and any remote host
 * with reachable SSH credentials. Remote hosts without an SSH key are reported
 * honestly as skipped — never fabricated.
 */
export async function runPortScanJob(
  hostNames: string[],
  createdById?: string | null
): Promise<string> {
  const job = await createJob({
    kind: "portscan",
    label: `Port scan: ${hostNames.join(", ") || "all hosts"}`,
    createdById: createdById ?? null,
  });
  runJob(job.id, async (ctx) => {
    await ctx.log(
      "Starting port scan (honest: only ports observed via real ss/netstat/Docker)."
    );
    await ctx.progress(5);

    let targets = hostNames;
    if (!targets.length) {
      const all = await prisma.host.findMany({ select: { name: true } });
      targets = all.map((h) => h.name);
      if (!targets.includes(LOCAL_HOST)) targets.push(LOCAL_HOST);
    }
    await ctx.log(`Targets: ${targets.join(", ")}`);

    const summary: Record<string, unknown> = {};
    let i = 0;
    for (const name of targets) {
      i++;
      if (ctx.cancelled()) return { cancelled: true };
      await ensureHost(name);
      const host = await prisma.host.findUnique({ where: { name } });
      if (!host) continue;

      if (host.isLocal) {
        await ctx.log(`[${name}] scanning local host via ss/netstat…`);
        const observed = await scanLocalPorts();
        const rec = await reconcile(name, observed);
        await ctx.log(
          `[${name}] observed ${observed.length} port(s); upserted ${rec.upserted}, marked ${rec.markedStale} stale.`
        );
        summary[name] = {
          observed: observed.length,
          ...rec,
          scanned: true,
        };
      } else {
        try {
          await ctx.log(`[${name}] connecting over SSH (${host.address})…`);
          const observed = await scanRemotePorts({
            name: host.name,
            address: host.address,
            sshUser: host.sshUser,
            sshPort: host.sshPort,
            sshKeyEnc: host.sshKeyEnc,
          });
          const rec = await reconcile(name, observed);
          await ctx.log(
            `[${name}] observed ${observed.length} port(s); upserted ${rec.upserted}, marked ${rec.markedStale} stale.`
          );
          summary[name] = {
            observed: observed.length,
            ...rec,
            scanned: true,
          };
        } catch (e) {
          const msg =
            e instanceof RemoteScanError
              ? `${e.code}: ${e.message}`
              : e instanceof Error
                ? e.message
                : String(e);
          await ctx.log(`[${name}] NOT scanned — ${msg}`);
          summary[name] = { scanned: false, reason: msg };
        }
      }
      await ctx.progress(5 + Math.round((i / targets.length) * 90));
    }

    await ctx.progress(100);
    return { targets, summary };
  });
  return job.id;
}
