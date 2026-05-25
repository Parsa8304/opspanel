import Docker from "dockerode";

/** Shared dockerode instance bound to the configured socket. */
const socketPath = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
export const docker = new Docker({ socketPath });

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  tag: string;
  status: string; // human status string
  state: string; // running | exited | restarting | ...
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  uptimeSec: number | null;
  restartCount: number;
  health: string | null; // healthy | unhealthy | starting | null
  ports: { ip?: string; privatePort: number; publicPort?: number; type: string }[];
  mounts: { source: string; destination: string; mode: string; rw: boolean; type: string }[];
  networks: string[]; // network names this container is attached to
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

function splitImage(image: string): { repo: string; tag: string } {
  // strip digest
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

/** Best-effort dependency inference from compose labels or image names. */
function inferDeps(
  labels: Record<string, string>
): { deps: string[]; inferred: boolean } {
  const dependsLabel =
    labels["com.docker.compose.depends_on"] ||
    labels["com.docker.compose.project.depends_on"];
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

export async function listContainers(): Promise<ContainerSummary[]> {
  const list = await docker.listContainers({ all: true });
  const result: ContainerSummary[] = [];
  for (const c of list) {
    let inspect: Docker.ContainerInspectInfo | null = null;
    try {
      inspect = await docker.getContainer(c.Id).inspect();
    } catch {
      inspect = null;
    }
    const labels = (inspect?.Config?.Labels || c.Labels || {}) as Record<string, string>;
    const { repo, tag } = splitImage(c.Image);
    const startedAt =
      inspect?.State?.StartedAt && inspect.State.StartedAt !== "0001-01-01T00:00:00Z"
        ? inspect.State.StartedAt
        : null;
    const finishedAt =
      inspect?.State?.FinishedAt && inspect.State.FinishedAt !== "0001-01-01T00:00:00Z"
        ? inspect.State.FinishedAt
        : null;
    const running = inspect?.State?.Running ?? c.State === "running";
    const uptimeSec =
      running && startedAt
        ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
        : null;
    const { deps } = inferDeps(labels);
    result.push({
      id: c.Id,
      name: (c.Names?.[0] || inspect?.Name || c.Id).replace(/^\//, ""),
      image: repo,
      tag,
      status: c.Status || inspect?.State?.Status || "",
      state: inspect?.State?.Status || c.State || "unknown",
      createdAt: inspect?.Created || new Date(c.Created * 1000).toISOString(),
      startedAt,
      finishedAt,
      uptimeSec,
      restartCount: inspect?.RestartCount ?? 0,
      health: inspect?.State?.Health?.Status ?? null,
      ports: (c.Ports || []).map((p) => ({
        ip: p.IP,
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort,
        type: p.Type,
      })),
      mounts: (inspect?.Mounts || []).map((m: any) => ({
        source: m.Source || m.Name || "",
        destination: m.Destination || "",
        mode: m.Mode || "",
        rw: !!m.RW,
        type: m.Type || "",
      })),
      networks: Object.keys(inspect?.NetworkSettings?.Networks || {}),
      env: envArrayToObject(inspect?.Config?.Env),
      composeProject: labels["com.docker.compose.project"] || null,
      composeService: labels["com.docker.compose.service"] || null,
      dependsOn: deps,
    });
  }
  return result;
}

export async function inspectContainer(id: string) {
  return docker.getContainer(id).inspect();
}

/** Compute a single stats snapshot with correctly derived CPU/mem/net/block IO. */
export async function statsSnapshot(id: string): Promise<StatsSnapshot> {
  const container = docker.getContainer(id);
  const s: any = await container.stats({ stream: false });

  // CPU %
  let cpuPercent = 0;
  try {
    const cpuDelta =
      (s.cpu_stats?.cpu_usage?.total_usage ?? 0) -
      (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
    const onlineCpus =
      s.cpu_stats?.online_cpus ||
      s.cpu_stats?.cpu_usage?.percpu_usage?.length ||
      1;
    if (systemDelta > 0 && cpuDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100;
    }
  } catch {
    cpuPercent = 0;
  }

  // Memory (subtract cache like docker stats does)
  const memStats = s.memory_stats || {};
  const cache =
    memStats.stats?.cache ??
    memStats.stats?.inactive_file ??
    0;
  const memUsage = Math.max(0, (memStats.usage ?? 0) - cache);
  const memLimit = memStats.limit ?? 0;
  const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

  // Network
  let netRx = 0;
  let netTx = 0;
  for (const v of Object.values<any>(s.networks || {})) {
    netRx += v.rx_bytes ?? 0;
    netTx += v.tx_bytes ?? 0;
  }

  // Block IO
  let blkRead = 0;
  let blkWrite = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive || []) {
    if (e.op === "Read" || e.op === "read") blkRead += e.value ?? 0;
    else if (e.op === "Write" || e.op === "write") blkWrite += e.value ?? 0;
  }

  return {
    cpuPercent: Number.isFinite(cpuPercent) ? Number(cpuPercent.toFixed(2)) : 0,
    memUsage,
    memLimit,
    memPercent: Number.isFinite(memPercent) ? Number(memPercent.toFixed(2)) : 0,
    netRxBytes: netRx,
    netTxBytes: netTx,
    blockReadBytes: blkRead,
    blockWriteBytes: blkWrite,
    pids: s.pids_stats?.current ?? 0,
    readAt: s.read || new Date().toISOString(),
  };
}

/**
 * Demux a Docker multiplexed stream buffer (8-byte header frames).
 * Returns plain text. If the stream is not multiplexed (tty), returns as-is.
 */
export function demuxDockerStream(buf: Buffer): string {
  // Heuristic: multiplexed frames start with stream type 0/1/2 then 3 zero bytes.
  if (buf.length < 8 || buf[0] > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
    return buf.toString("utf8");
  }
  let offset = 0;
  const chunks: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const type = buf[offset];
    if (type > 2 || buf[offset + 1] !== 0) {
      // not a valid frame header — bail out, return remainder raw
      chunks.push(buf.slice(offset));
      break;
    }
    const len = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + len > buf.length) {
      chunks.push(buf.slice(offset));
      break;
    }
    chunks.push(buf.slice(offset, offset + len));
    offset += len;
  }
  return Buffer.concat(chunks).toString("utf8");
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

/** Group containers by compose project → service with dependency hints. */
export async function groupByCompose(): Promise<{
  projects: ComposeProject[];
  ungrouped: ContainerSummary[];
}> {
  const containers = await listContainers();
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
      // explicit deps come from labels (already on container)
      const explicit = new Set<string>();
      for (const c of conts) for (const d of c.dependsOn) explicit.add(d);

      let deps: string[];
      let inferred: boolean;
      if (explicit.size > 0) {
        deps = Array.from(explicit).filter(
          (d) => serviceNames.has(d) && d !== service
        );
        inferred = false;
      } else {
        // best-effort: if any sibling service looks like a datastore, depend on it
        const guessed: string[] = [];
        for (const other of Array.from(serviceNames)) {
          if (other === service) continue;
          if (/(^|[-_])(db|database|postgres|postgresql|mysql|mariadb|mongo|redis|rabbitmq|kafka|elastic)([-_]|$)/i.test(other)) {
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

export async function pauseContainer(id: string): Promise<void> {
  await docker.getContainer(id).pause();
}

export async function unpauseContainer(id: string): Promise<void> {
  await docker.getContainer(id).unpause();
}

export async function removeContainer(id: string): Promise<void> {
  await docker.getContainer(id).remove({ force: true });
}

export async function pruneContainers(): Promise<{ removed: string[]; spaceReclaimed: number }> {
  const result: any = await (docker as any).pruneContainers();
  return {
    removed: result.ContainersDeleted || [],
    spaceReclaimed: result.SpaceReclaimed || 0,
  };
}

export async function pullLatestForContainer(id: string): Promise<void> {
  const info = await docker.getContainer(id).inspect();
  const image = info.Config.Image;
  await new Promise<void>((resolve, reject) => {
    (docker as any).pull(image, (err: any, stream: any) => {
      if (err) { reject(err); return; }
      (docker as any).modem.followProgress(stream, (err2: any) => {
        if (err2) reject(err2); else resolve();
      });
    });
  });
}

export async function recreateContainer(id: string): Promise<string> {
  const info = await docker.getContainer(id).inspect();
  const name = info.Name.replace(/^\//, "");
  const image = info.Config.Image;
  try { await docker.getContainer(id).stop({ t: 10 } as any); } catch {}
  await docker.getContainer(id).remove({ force: true });
  const created = await docker.createContainer({
    name,
    Image: image,
    Env: (info.Config.Env as string[]) || [],
    Cmd: (info.Config.Cmd as string[]) || undefined,
    Entrypoint: (info.Config.Entrypoint as string[]) || undefined,
    WorkingDir: info.Config.WorkingDir || "",
    Labels: (info.Config.Labels as Record<string, string>) || {},
    ExposedPorts: (info.Config.ExposedPorts as any) || {},
    HostConfig: info.HostConfig as any,
  });
  await created.start();
  return created.id;
}

export interface ImageSummary {
  id: string;
  repoTags: string[];
  size: number;
  created: number;
  dangling: boolean;
}

export async function listImages(): Promise<ImageSummary[]> {
  const images = await docker.listImages({ all: false });
  return images.map((img: any) => ({
    id: img.Id,
    repoTags: img.RepoTags || [],
    size: img.Size,
    created: img.Created,
    dangling: !img.RepoTags || img.RepoTags[0] === "<none>:<none>",
  }));
}

export async function removeImage(id: string): Promise<void> {
  await (docker.getImage(id) as any).remove({ force: false });
}

export async function pullImage(image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    (docker as any).pull(image, (err: any, stream: any) => {
      if (err) { reject(err); return; }
      (docker as any).modem.followProgress(stream, (err2: any) => {
        if (err2) reject(err2); else resolve();
      });
    });
  });
}

export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  inUse: boolean;
}

export async function listVolumes(containerMounts?: string[]): Promise<VolumeSummary[]> {
  const result: any = await (docker as any).listVolumes();
  const used = new Set(containerMounts || []);
  return (result.Volumes || []).map((v: any) => ({
    name: v.Name,
    driver: v.Driver,
    mountpoint: v.Mountpoint,
    createdAt: v.CreatedAt || "",
    inUse: used.has(v.Name),
  }));
}

export async function removeVolume(name: string): Promise<void> {
  await (docker as any).getVolume(name).remove();
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachedContainers: { id: string; name: string; ipv4: string }[];
}

export async function listNetworks(): Promise<NetworkSummary[]> {
  const nets: any[] = await docker.listNetworks();
  return nets.map((n: any) => ({
    id: n.Id,
    name: n.Name,
    driver: n.Driver,
    scope: n.Scope,
    internal: n.Internal || false,
    attachedContainers: Object.entries(n.Containers || {}).map(([cid, info]: [string, any]) => ({
      id: cid.slice(0, 12),
      name: info.Name || "",
      ipv4: info.IPv4Address || "",
    })),
  }));
}
