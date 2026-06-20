import { targetExec, targetSpawn } from "./target";
import { maskSecrets } from "./api";

/**
 * Docker container management for any target server (local via nsenter, or a
 * registered RemoteServer via SSH) using pure `docker` CLI commands through
 * targetExec/targetSpawn — mirrors the shape of lib/docker.ts but has no
 * dependency on dockerode or the local docker.sock.
 */

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  tag: string;
  status: string;
  state: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
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
}

export interface StatsSnapshot {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  readAt: string;
}

export interface ComposeService {
  service: string;
  containers: ContainerSummary[];
  dependsOn: string[];
  dependsInferred: boolean;
}
export interface ComposeProject {
  project: string;
  services: ComposeService[];
}

function splitImage(image: string): { repo: string; tag: string } {
  const noDigest = image.split("@")[0];
  const lastColon = noDigest.lastIndexOf(":");
  const lastSlash = noDigest.lastIndexOf("/");
  if (lastColon > lastSlash && lastColon !== -1) {
    return { repo: noDigest.slice(0, lastColon), tag: noDigest.slice(lastColon + 1) };
  }
  return { repo: noDigest, tag: "latest" };
}

function envArrayToObject(env: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of env || []) {
    const i = e.indexOf("=");
    if (i === -1) out[e] = "";
    else out[e.slice(0, i)] = e.slice(i + 1);
  }
  return out;
}

function inferDeps(labels: Record<string, string>): { deps: string[]; inferred: boolean } {
  const dependsLabel =
    labels["com.docker.compose.depends_on"] || labels["com.docker.compose.project.depends_on"];
  if (dependsLabel) {
    return {
      deps: dependsLabel
        .split(",")
        .map((s) => s.split(":")[0].trim())
        .filter(Boolean),
      inferred: false,
    };
  }
  return { deps: [], inferred: true };
}

function parseNdjson(stdout: string): any[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x): x is any => x !== null);
}

/** Run `docker inspect <id>` and return the parsed (single) object, or null. */
async function inspectRaw(serverId: string, containerId: string): Promise<any | null> {
  const { stdout } = await targetExec(
    serverId,
    `docker inspect ${JSON.stringify(containerId)} 2>/dev/null`,
    20000
  );
  try {
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr[0] ?? null : arr ?? null;
  } catch {
    return null;
  }
}

function summaryFromInspect(inspect: any): ContainerSummary {
  const labels = (inspect?.Config?.Labels || {}) as Record<string, string>;
  const { repo, tag } = splitImage(inspect?.Config?.Image || "");
  const startedAtRaw = inspect?.State?.StartedAt;
  const startedAt = startedAtRaw && startedAtRaw !== "0001-01-01T00:00:00Z" ? startedAtRaw : null;
  const finishedAtRaw = inspect?.State?.FinishedAt;
  const finishedAt = finishedAtRaw && finishedAtRaw !== "0001-01-01T00:00:00Z" ? finishedAtRaw : null;
  const running = !!inspect?.State?.Running;
  const uptimeSec =
    running && startedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
      : null;
  const { deps } = inferDeps(labels);

  const portsObj = inspect?.NetworkSettings?.Ports || {};
  const ports: ContainerSummary["ports"] = [];
  for (const [key, bindings] of Object.entries<any>(portsObj)) {
    const [privatePortStr, type] = key.split("/");
    const privatePort = parseInt(privatePortStr, 10);
    if (Array.isArray(bindings) && bindings.length > 0) {
      for (const b of bindings) {
        ports.push({
          ip: b.HostIp || undefined,
          privatePort,
          publicPort: b.HostPort ? parseInt(b.HostPort, 10) : undefined,
          type: type || "tcp",
        });
      }
    } else {
      ports.push({ privatePort, type: type || "tcp" });
    }
  }

  const mounts = (inspect?.Mounts || []).map((m: any) => ({
    source: m.Source || m.Name || "",
    destination: m.Destination || "",
    mode: m.Mode || "",
    rw: !!m.RW,
    type: m.Type || "",
  }));

  return {
    id: inspect?.Id || "",
    name: (inspect?.Name || "").replace(/^\//, ""),
    image: repo,
    tag,
    status: inspect?.State?.Status || "",
    state: inspect?.State?.Status || "unknown",
    createdAt: inspect?.Created || new Date().toISOString(),
    startedAt,
    finishedAt,
    uptimeSec,
    restartCount: inspect?.RestartCount ?? 0,
    health: inspect?.State?.Health?.Status ?? null,
    ports,
    mounts,
    networks: Object.keys(inspect?.NetworkSettings?.Networks || {}),
    env: envArrayToObject(inspect?.Config?.Env),
    composeProject: labels["com.docker.compose.project"] || null,
    composeService: labels["com.docker.compose.service"] || null,
    dependsOn: deps,
  };
}

export async function listContainers(serverId: string): Promise<ContainerSummary[]> {
  const { stdout } = await targetExec(serverId, `docker ps -a --format '{{.ID}}'`, 20000);
  const ids = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (ids.length === 0) return [];

  const { stdout: inspectOut } = await targetExec(
    serverId,
    `docker inspect ${ids.map((id) => JSON.stringify(id)).join(" ")} 2>/dev/null`,
    30000
  );
  let arr: any[] = [];
  try {
    arr = JSON.parse(inspectOut);
  } catch {
    arr = [];
  }
  return arr.map(summaryFromInspect);
}

export async function inspectContainer(serverId: string, containerId: string): Promise<any> {
  const inspect = await inspectRaw(serverId, containerId);
  if (!inspect) throw new Error(`Container ${containerId} not found`);
  return inspect;
}

export async function statsSnapshot(serverId: string, containerId: string): Promise<StatsSnapshot> {
  const { stdout } = await targetExec(
    serverId,
    `docker stats --no-stream --format '{{json .}}' ${JSON.stringify(containerId)}`,
    20000
  );
  const rows = parseNdjson(stdout);
  const s = rows[0];
  if (!s) throw new Error(`No stats available for ${containerId}`);

  const cpuPercent = parseFloat(String(s.CPUPerc || "0").replace("%", "")) || 0;
  const memPercent = parseFloat(String(s.MemPerc || "0").replace("%", "")) || 0;

  const parseBytes = (str: string): number => {
    const m = String(str || "").match(/^([\d.]+)\s*([a-zA-Z]+)$/);
    if (!m) return 0;
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const mult: Record<string, number> = {
      b: 1,
      kb: 1000,
      kib: 1024,
      mb: 1000 ** 2,
      mib: 1024 ** 2,
      gb: 1000 ** 3,
      gib: 1024 ** 3,
      tb: 1000 ** 4,
      tib: 1024 ** 4,
    };
    return value * (mult[unit] ?? 1);
  };

  const memUsageStr = String(s.MemUsage || "").split("/")[0]?.trim() || "0";
  const memLimitStr = String(s.MemUsage || "").split("/")[1]?.trim() || "0";
  const netRxStr = String(s.NetIO || "").split("/")[0]?.trim() || "0";
  const netTxStr = String(s.NetIO || "").split("/")[1]?.trim() || "0";
  const blkReadStr = String(s.BlockIO || "").split("/")[0]?.trim() || "0";
  const blkWriteStr = String(s.BlockIO || "").split("/")[1]?.trim() || "0";

  return {
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memUsage: parseBytes(memUsageStr),
    memLimit: parseBytes(memLimitStr),
    memPercent: Number(memPercent.toFixed(2)),
    netRxBytes: parseBytes(netRxStr),
    netTxBytes: parseBytes(netTxStr),
    blockReadBytes: parseBytes(blkReadStr),
    blockWriteBytes: parseBytes(blkWriteStr),
    pids: parseInt(String(s.PIDs || "0"), 10) || 0,
    readAt: new Date().toISOString(),
  };
}

export async function startContainer(serverId: string, containerId: string): Promise<void> {
  await targetExec(serverId, `docker start ${JSON.stringify(containerId)}`, 30000);
}

export async function stopContainer(serverId: string, containerId: string): Promise<void> {
  await targetExec(serverId, `docker stop ${JSON.stringify(containerId)}`, 30000);
}

export async function restartContainer(serverId: string, containerId: string): Promise<void> {
  await targetExec(serverId, `docker restart ${JSON.stringify(containerId)}`, 30000);
}

export async function pauseContainer(serverId: string, containerId: string): Promise<void> {
  await targetExec(serverId, `docker pause ${JSON.stringify(containerId)}`, 15000);
}

export async function unpauseContainer(serverId: string, containerId: string): Promise<void> {
  await targetExec(serverId, `docker unpause ${JSON.stringify(containerId)}`, 15000);
}

export async function removeContainer(serverId: string, containerId: string): Promise<void> {
  const { code, stderr } = await targetExec(
    serverId,
    `docker rm -f ${JSON.stringify(containerId)}`,
    30000
  );
  if (code && code !== 0) throw new Error(stderr || `docker rm exited with code ${code}`);
}

export async function pullLatestForContainer(serverId: string, containerId: string): Promise<void> {
  const inspect = await inspectContainer(serverId, containerId);
  const image = inspect?.Config?.Image;
  if (!image) throw new Error("Unable to determine image for container");
  const { code, stderr } = await targetExec(serverId, `docker pull ${JSON.stringify(image)}`, 300000);
  if (code && code !== 0) throw new Error(stderr || `docker pull exited with code ${code}`);
}

/**
 * Recreate a container in place: stop, remove, then `docker run` again with
 * the same name/image/env/cmd/entrypoint, reusing the host config via
 * `docker run --name X <flags> image`. We can't perfectly replicate every
 * dockerode HostConfig field through a shell one-liner, so we cover the
 * common, load-bearing ones: env, ports, volumes/mounts, restart policy,
 * network mode, and labels.
 */
export async function recreateContainer(serverId: string, containerId: string): Promise<string> {
  const inspect = await inspectContainer(serverId, containerId);
  const name = String(inspect?.Name || "").replace(/^\//, "");
  const image = inspect?.Config?.Image;
  if (!image) throw new Error("Unable to determine image for container");

  const env: string[] = inspect?.Config?.Env || [];
  const labels: Record<string, string> = inspect?.Config?.Labels || {};
  const portsObj: Record<string, any> = inspect?.NetworkSettings?.Ports || {};
  const restartPolicy = inspect?.HostConfig?.RestartPolicy?.Name || "";
  const mounts: any[] = inspect?.Mounts || [];
  const networkMode = inspect?.HostConfig?.NetworkMode || "";

  const args: string[] = ["run", "-d", "--name", JSON.stringify(name)];
  for (const e of env) args.push("-e", JSON.stringify(e));
  for (const [k, v] of Object.entries(labels)) args.push("-l", JSON.stringify(`${k}=${v}`));
  for (const [portKey, bindings] of Object.entries<any>(portsObj)) {
    if (Array.isArray(bindings)) {
      for (const b of bindings) {
        const hostIp = b.HostIp ? `${b.HostIp}:` : "";
        args.push("-p", JSON.stringify(`${hostIp}${b.HostPort}:${portKey}`));
      }
    }
  }
  for (const m of mounts) {
    if (m.Type === "volume" && m.Name) {
      args.push("-v", JSON.stringify(`${m.Name}:${m.Destination}${m.RW ? "" : ":ro"}`));
    } else if (m.Source && m.Destination) {
      args.push("-v", JSON.stringify(`${m.Source}:${m.Destination}${m.RW ? "" : ":ro"}`));
    }
  }
  if (restartPolicy && restartPolicy !== "no") args.push("--restart", JSON.stringify(restartPolicy));
  if (networkMode && !["default", ""].includes(networkMode)) {
    args.push("--network", JSON.stringify(networkMode));
  }
  args.push(JSON.stringify(image));

  await targetExec(serverId, `docker stop ${JSON.stringify(containerId)} || true`, 30000);
  await targetExec(serverId, `docker rm -f ${JSON.stringify(containerId)} || true`, 30000);
  const { stdout, code, stderr } = await targetExec(serverId, `docker ${args.join(" ")}`, 60000);
  if (code && code !== 0) throw new Error(stderr || `docker run exited with code ${code}`);
  return stdout.trim();
}

export async function execInContainer(
  serverId: string,
  containerId: string,
  cmd: string[]
): Promise<{ output: string; exitCode: number | null }> {
  const quoted = cmd.map((c) => JSON.stringify(c)).join(" ");
  const { stdout, stderr, code } = await targetExec(
    serverId,
    `docker exec ${JSON.stringify(containerId)} ${quoted} 2>&1`,
    30000
  );
  return { output: stdout || stderr || "", exitCode: code ?? null };
}

export async function getLogs(
  serverId: string,
  containerId: string,
  opts: { tail?: number | "all"; since?: string | number } = {}
): Promise<string> {
  const flags: string[] = ["--timestamps"];
  if (opts.tail && opts.tail !== "all") flags.push("--tail", String(opts.tail));
  else flags.push("--tail", "all");
  if (opts.since !== undefined && opts.since !== null && opts.since !== "") {
    flags.push("--since", JSON.stringify(String(opts.since)));
  }
  const { stdout, stderr } = await targetExec(
    serverId,
    `docker logs ${flags.join(" ")} ${JSON.stringify(containerId)} 2>&1`,
    30000
  );
  return stdout || stderr || "";
}

/** Stream logs line by line via `docker logs -f`, for SSE follow endpoints. */
export function streamLogs(
  serverId: string,
  containerId: string,
  onLine: (line: string) => void,
  tail: number | "all" = 200,
  timeoutMs = 600000
): Promise<void> {
  const tailFlag = tail === "all" ? "all" : String(tail);
  const cmd = `docker logs -f --timestamps --tail ${JSON.stringify(tailFlag)} ${JSON.stringify(containerId)} 2>&1`;
  return targetSpawn(serverId, cmd, onLine, timeoutMs);
}

export async function pruneContainers(
  serverId: string
): Promise<{ removed: string[]; spaceReclaimed: number }> {
  const { stdout } = await targetExec(serverId, `docker container prune -f`, 60000);
  const idMatch = stdout.match(/Deleted Containers:\n([\s\S]*?)(?:\n\n|Total reclaimed space)/);
  const removed = idMatch
    ? idMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  const spaceMatch = stdout.match(/Total reclaimed space:\s*([\d.]+)\s*([a-zA-Z]+)/);
  let spaceReclaimed = 0;
  if (spaceMatch) {
    const value = parseFloat(spaceMatch[1]);
    const unit = spaceMatch[2].toLowerCase();
    const mult: Record<string, number> = {
      b: 1,
      kb: 1000,
      kib: 1024,
      mb: 1000 ** 2,
      mib: 1024 ** 2,
      gb: 1000 ** 3,
      gib: 1024 ** 3,
    };
    spaceReclaimed = value * (mult[unit] ?? 1);
  }
  return { removed, spaceReclaimed };
}

/** Group containers by compose project → service with dependency hints. */
export async function groupByCompose(
  serverId: string
): Promise<{ projects: ComposeProject[]; ungrouped: ContainerSummary[] }> {
  const containers = await listContainers(serverId);
  const projects = new Map<string, Map<string, ContainerSummary[]>>();
  const ungrouped: ContainerSummary[] = [];

  for (const c of containers) {
    if (!c.composeProject) {
      ungrouped.push(c);
      continue;
    }
    if (!projects.has(c.composeProject)) projects.set(c.composeProject, new Map());
    const svc = projects.get(c.composeProject)!;
    const key = c.composeService || c.name;
    if (!svc.has(key)) svc.set(key, []);
    svc.get(key)!.push(c);
  }

  const out: ComposeProject[] = [];
  for (const [project, svcMap] of Array.from(projects.entries())) {
    const serviceNames = new Set(Array.from(svcMap.keys()));
    const services: ComposeService[] = [];
    for (const [service, conts] of Array.from(svcMap.entries())) {
      const explicit = new Set<string>();
      for (const c of conts) for (const d of c.dependsOn) explicit.add(d);

      let deps: string[];
      let inferred: boolean;
      if (explicit.size > 0) {
        deps = Array.from(explicit).filter((d) => serviceNames.has(d) && d !== service);
        inferred = false;
      } else {
        const guessed: string[] = [];
        for (const other of Array.from(serviceNames)) {
          if (other === service) continue;
          if (
            /(^|[-_])(db|database|postgres|postgresql|mysql|mariadb|mongo|redis|rabbitmq|kafka|elastic)([-_]|$)/i.test(
              other
            )
          ) {
            guessed.push(other);
          }
        }
        deps = guessed;
        inferred = true;
      }
      services.push({ service, containers: conts, dependsOn: deps, dependsInferred: inferred });
    }
    out.push({ project, services });
  }

  return { projects: out, ungrouped };
}

export { maskSecrets };
