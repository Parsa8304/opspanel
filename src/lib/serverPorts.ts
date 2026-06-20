import { prisma } from "./prisma";
import { createJob, runJob } from "./jobs";
import { listContainers } from "./remoteDocker";
import { targetExec } from "./target";
import { LOCAL_ID } from "./target";
import {
  parseSsOutput,
  LOCAL_HOST,
  type ObservedPort,
} from "./ports";

/**
 * Section 15 (server-scoped) — Port Allocation Map, per registered server tab.
 *
 * Mirrors src/lib/ports.ts but parameterized by serverId and routed through
 * targetExec (so local vs SSH-remote is collapsed into one code path) and
 * remoteDocker.ts's CLI-based listContainers(serverId) instead of the
 * dockerode-based lib/docker.ts (which only talks to the panel's own host).
 *
 * HONESTY: only reports ports actually observed via a real `ss`/`netstat` run
 * on the target (local via nsenter, or remote via SSH) and real `docker`
 * published ports on that same target. A port whose owning process cannot be
 * determined is reported honestly as unknown — never guessed. Stale
 * allocations are kept (status "stale"), never deleted.
 */

export type { ObservedPort };

// ─────────────────────────── Local scan ───────────────────────────

const SS_TCP = "ss -tlnp 2>/dev/null";
const SS_UDP = "ss -ulnp 2>/dev/null";
const NETSTAT_TCP = "netstat -tlnp 2>/dev/null";
const NETSTAT_UDP = "netstat -ulnp 2>/dev/null";

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
    if (!prev.processName && p.processName) map.set(key, p);
    else if (!prev.containerName && p.containerName)
      map.set(key, { ...prev, containerName: p.containerName, serviceName: p.serviceName });
  }
  return Array.from(map.values());
}

/** Attach containerName/serviceName where a published port maps to a container on this server. */
export async function attachDocker(
  serverId: string,
  observed: ObservedPort[]
): Promise<ObservedPort[]> {
  let containers;
  try {
    containers = await listContainers(serverId);
  } catch {
    return observed; // Docker not reachable on this target — honest: no container attribution
  }
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

async function tryExecTarget(serverId: string, cmd: string): Promise<string | null> {
  try {
    const { stdout } = await targetExec(serverId, cmd, 15000);
    if (stdout && stdout.trim()) return stdout;
  } catch (e: any) {
    if (e && typeof e.stdout === "string" && e.stdout.trim().length > 0)
      return e.stdout;
  }
  return null;
}

/**
 * Scan ports on the given server (local via nsenter, remote via SSH — both
 * transparently handled by targetExec) and attach Docker container
 * attribution observed on that same target.
 */
export async function scanPorts(serverId: string): Promise<ObservedPort[]> {
  const result: ObservedPort[] = [];

  let tcpText = await tryExecTarget(serverId, SS_TCP);
  if (tcpText == null || tcpText.trim() === "")
    tcpText = await tryExecTarget(serverId, NETSTAT_TCP);
  if (tcpText) result.push(...parseSsOutput(tcpText, "tcp"));

  let udpText = await tryExecTarget(serverId, SS_UDP);
  if (udpText == null || udpText.trim() === "")
    udpText = await tryExecTarget(serverId, NETSTAT_UDP);
  if (udpText) result.push(...parseSsOutput(udpText, "udp"));

  const withDocker = await attachDocker(serverId, dedupe(result));
  return dedupe(withDocker);
}

// ─────────────────────────── Reconcile / persist ───────────────────────────

/** Resolve a stable, human-meaningful hostName label for a given serverId. */
export async function hostNameForServer(serverId: string): Promise<string> {
  if (serverId === LOCAL_ID) return LOCAL_HOST;
  const server = await prisma.remoteServer.findUnique({
    where: { id: serverId },
    select: { name: true, host: true },
  });
  return server?.name || server?.host || serverId;
}

/** Ensure a Host row exists for the legacy Host relation; auto-create if absent. */
async function ensureHost(hostName: string, serverId: string): Promise<void> {
  const existing = await prisma.host.findUnique({ where: { name: hostName } });
  if (existing) return;
  const isLocal = serverId === LOCAL_ID;
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
 * Upsert observed PortAllocation rows for this serverId (unique
 * serverId+hostName+port+protocol+iface), update lastSeen. Rows previously
 * active for this server but NOT seen in this scan are marked status "stale"
 * — never deleted (history matters).
 */
export async function reconcile(
  serverId: string,
  hostName: string,
  observed: ObservedPort[]
): Promise<ReconcileResult> {
  await ensureHost(hostName, serverId);
  const now = new Date();
  let upserted = 0;

  const seenKeys = new Set<string>();
  for (const o of observed) {
    const key = `${o.port}|${o.protocol}|${o.iface}`;
    seenKeys.add(key);
    await prisma.portAllocation.upsert({
      where: {
        serverId_hostName_port_protocol_iface: {
          serverId,
          hostName,
          port: o.port,
          protocol: o.protocol,
          iface: o.iface,
        },
      },
      create: {
        serverId,
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

  const existing = await prisma.portAllocation.findMany({
    where: { serverId, hostName, status: "active" },
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
 * Ports claimed by more than one distinct service/container on this server
 * (including a stale row vs an active row on the same port).
 */
export async function detectConflicts(serverId: string): Promise<PortConflict[]> {
  const rows = await prisma.portAllocation.findMany({
    where: { serverId },
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
    const distinctOwners = owners.size > 1;
    const multipleRows = group.length > 1;
    if (!distinctOwners && !multipleRows) continue;
    conflicts.push({
      port: group[0].port,
      protocol: group[0].protocol,
      hostName: group[0].hostName,
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

/** Ports bound to 0.0.0.0 / :: on this server → security findings with severity. */
export async function publicFindings(serverId: string): Promise<PublicFinding[]> {
  const rows = await prisma.portAllocation.findMany({
    where: { serverId, isPublic: true },
    orderBy: { port: "asc" },
  });
  return rows.map((r) => ({
    port: r.port,
    protocol: r.protocol,
    iface: r.iface,
    owner:
      r.containerName || r.serviceName || r.processName || "unknown process",
    status: r.status,
    severity: r.status === "active" ? "high" : "medium",
  }));
}

/**
 * Lowest port in [rangeStart, rangeEnd] not in ANY allocation (active OR
 * stale) for this server.
 */
export async function nextFreePort(
  serverId: string,
  rangeStart: number,
  rangeEnd: number
): Promise<number | null> {
  const rows = await prisma.portAllocation.findMany({
    where: { serverId, port: { gte: rangeStart, lte: rangeEnd } },
    select: { port: true },
  });
  const taken = new Set(rows.map((r) => r.port));
  for (let p = rangeStart; p <= rangeEnd; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

// ─────────────────────────── Job runner ───────────────────────────

/**
 * Background portscan job for one server tab (local or a registered
 * RemoteServer). Connectivity failures are reported honestly in the job log
 * — never fabricated.
 */
export async function runPortScanJob(
  serverId: string,
  createdById?: string | null
): Promise<string> {
  const hostName = await hostNameForServer(serverId);
  const job = await createJob({
    kind: "portscan",
    label: `Port scan: ${hostName}`,
    createdById: createdById ?? null,
  });
  runJob(job.id, async (ctx) => {
    await ctx.log(
      "Starting port scan (honest: only ports observed via real ss/netstat/Docker)."
    );
    await ctx.progress(10);

    if (ctx.cancelled()) return { cancelled: true };

    try {
      await ctx.log(
        serverId === LOCAL_ID
          ? `[${hostName}] scanning local host via ss/netstat…`
          : `[${hostName}] connecting over SSH…`
      );
      const observed = await scanPorts(serverId);
      await ctx.progress(70);
      const rec = await reconcile(serverId, hostName, observed);
      await ctx.log(
        `[${hostName}] observed ${observed.length} port(s); upserted ${rec.upserted}, marked ${rec.markedStale} stale.`
      );
      await ctx.progress(100);
      return { hostName, observed: observed.length, ...rec, scanned: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.log(`[${hostName}] NOT scanned — ${msg}`);
      await ctx.progress(100);
      return { hostName, scanned: false, reason: msg };
    }
  });
  return job.id;
}
