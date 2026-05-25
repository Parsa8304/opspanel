import net from "net";
import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { prisma } from "./prisma";
import { createJob, runJob } from "./jobs";
import { listContainers, type ContainerSummary } from "./docker";
import { maskSecrets } from "./api";

/**
 * Section 14 — Auto-Discovery of Services & Dependencies.
 *
 * HONESTY: this module only reports what it actually observed via the real
 * Docker API, a real compose-file parse, or a real network probe. Anything it
 * cannot determine is reported as honestly unknown — never guessed. It only
 * PROPOSES configuration as DiscoveryProposal rows; nothing is trusted or
 * applied until a human ADMIN explicitly accepts a proposal. It cannot infer
 * business semantics (e.g. which database is "the main one") — proposals say so.
 */

export interface DiscoveryConfig {
  composePaths?: string[];
  scanIntervalSec?: number;
  probePaths?: string[];
}

const DEFAULT_PROBE_PATHS = ["/health", "/healthz", "/api/health", "/_health"];

/** Env var KEYS that indicate an external integration is wired in.
 *  We only ever record that the KEY EXISTS — never its value. */
const INTEGRATION_KEYS = [
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "CRUNCHBASE_API_KEY",
  "CRUNCHBASE_KEY",
  "TRACXN_API_KEY",
  "TRACXN_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

/** Connection-string env var names that imply an inferred dependency edge. */
const CONNECTION_ENV = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "PG_URL",
  "REDIS_URL",
  "CELERY_BROKER_URL",
  "CELERY_RESULT_BACKEND",
  "MEILI_URL",
  "MEILISEARCH_URL",
  "MINIO_ENDPOINT",
  "S3_ENDPOINT",
  "AMQP_URL",
  "RABBITMQ_URL",
  "MONGO_URL",
  "MONGODB_URI",
];

/** Well-known datastore ports → service signature. */
const PORT_SIGNATURES: Record<number, { kind: string; name: string }> = {
  5432: { kind: "database", name: "PostgreSQL" },
  3306: { kind: "database", name: "MySQL/MariaDB" },
  27017: { kind: "database", name: "MongoDB" },
  6379: { kind: "cache", name: "Redis" },
  7700: { kind: "search", name: "Meilisearch" },
  9200: { kind: "search", name: "Elasticsearch" },
  9000: { kind: "storage", name: "MinIO/S3" },
  5672: { kind: "queue", name: "RabbitMQ/AMQP" },
};

/** Heuristic image → role classification (best-effort, reported as such). */
function classifyImage(image: string): {
  kind: string;
  name: string;
} | null {
  const i = image.toLowerCase();
  if (/postgres|postgis/.test(i)) return { kind: "database", name: "PostgreSQL" };
  if (/mysql|mariadb/.test(i)) return { kind: "database", name: "MySQL/MariaDB" };
  if (/mongo/.test(i)) return { kind: "database", name: "MongoDB" };
  if (/redis|valkey/.test(i)) return { kind: "cache", name: "Redis" };
  if (/meilisearch/.test(i)) return { kind: "search", name: "Meilisearch" };
  if (/elasticsearch|opensearch/.test(i))
    return { kind: "search", name: "Elasticsearch" };
  if (/minio/.test(i)) return { kind: "storage", name: "MinIO" };
  if (/rabbitmq/.test(i)) return { kind: "queue", name: "RabbitMQ" };
  if (/nginx/.test(i)) return { kind: "service", name: "Nginx" };
  if (/celery/.test(i)) return { kind: "queue", name: "Celery worker" };
  if (/daphne/.test(i)) return { kind: "service", name: "Daphne (ASGI)" };
  return null;
}

// ─────────────────────────── Docker discovery ───────────────────────────

export interface DiscoveredContainer {
  id: string;
  name: string;
  image: string;
  tag: string;
  state: string;
  health: string | null;
  composeProject: string | null;
  composeService: string | null;
  dependsOn: string[];
  ports: { privatePort: number; publicPort?: number; type: string }[];
  mounts: { source: string; destination: string; type: string }[];
  /** env with secret-looking values masked — never store plaintext secrets */
  envMasked: Record<string, string>;
  /** integration env var KEYS detected present (value NOT recorded) */
  integrationKeys: string[];
  /** connection-string env var KEYS detected present (value NOT recorded) */
  connectionKeys: string[];
  classification: { kind: string; name: string } | null;
}

export interface DockerDiscovery {
  reachable: boolean;
  error: string | null;
  containers: DiscoveredContainer[];
}

function envKeysPresent(env: Record<string, string>, names: string[]): string[] {
  return names.filter((n) => env[n] != null && String(env[n]).length > 0);
}

export async function discoverDocker(): Promise<DockerDiscovery> {
  let raw: ContainerSummary[];
  try {
    raw = await listContainers();
  } catch (e) {
    return {
      reachable: false,
      error: e instanceof Error ? e.message : "Docker not reachable",
      containers: [],
    };
  }
  const containers: DiscoveredContainer[] = raw.map((c) => ({
    id: c.id,
    name: c.name,
    image: c.image,
    tag: c.tag,
    state: c.state,
    health: c.health,
    composeProject: c.composeProject,
    composeService: c.composeService,
    dependsOn: c.dependsOn,
    ports: c.ports.map((p) => ({
      privatePort: p.privatePort,
      publicPort: p.publicPort,
      type: p.type,
    })),
    mounts: c.mounts.map((m) => ({
      source: m.source,
      destination: m.destination,
      type: m.type,
    })),
    // Mask anything secret-looking before it can be stored as evidence.
    envMasked: maskSecrets(c.env),
    integrationKeys: envKeysPresent(c.env, INTEGRATION_KEYS),
    connectionKeys: envKeysPresent(c.env, CONNECTION_ENV),
    classification: classifyImage(`${c.image}:${c.tag}`),
  }));
  return { reachable: true, error: null, containers };
}

// ──────────────────────── Compose-file discovery ────────────────────────

export interface ComposeServiceDef {
  service: string;
  image: string | null;
  tag: string | null;
  dependsOn: string[];
  ports: string[];
  networks: string[];
  volumes: string[];
}

export interface ComposeFileDiscovery {
  path: string;
  parsed: boolean;
  error: string | null;
  services: ComposeServiceDef[];
}

export interface ComposeReconcileItem {
  service: string;
  composeImage: string | null;
  composeTag: string | null;
  runningImage: string | null;
  runningTag: string | null;
  state: "running" | "missing" | "orphan";
  versionDrift: boolean;
}

export interface ComposeDiscovery {
  files: ComposeFileDiscovery[];
  reconcile: ComposeReconcileItem[];
  orphans: string[]; // running containers not present in any compose file
  missing: string[]; // services in compose but no running container
  versionDrift: ComposeReconcileItem[];
}

const COMPOSE_GLOB_DIRS = [
  "/opt",
  "/home/parsa/panel",
];

async function autoDetectComposeFiles(): Promise<string[]> {
  const found = new Set<string>();
  const names = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ];
  // /home/parsa/panel/docker-compose.yml — known panel file (depth 0)
  for (const n of names) {
    const p = path.join("/home/parsa/panel", n);
    try {
      await fs.access(p);
      found.add(p);
    } catch {
      /* not present — honest skip */
    }
  }
  // /opt/<project>/docker-compose.y*ml and /home/<user>/<project>/...
  const roots = ["/opt", "/home"];
  for (const root of roots) {
    let lvl1: string[] = [];
    try {
      lvl1 = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const d1 of lvl1) {
      const base1 = path.join(root, d1);
      for (const n of names) {
        const p = path.join(base1, n);
        try {
          await fs.access(p);
          found.add(p);
        } catch {
          /* skip */
        }
      }
      // one level deeper for /home/<user>/<project>/
      let lvl2: string[] = [];
      try {
        lvl2 = await fs.readdir(base1);
      } catch {
        continue;
      }
      for (const d2 of lvl2) {
        for (const n of names) {
          const p = path.join(base1, d2, n);
          try {
            await fs.access(p);
            found.add(p);
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  void COMPOSE_GLOB_DIRS;
  return Array.from(found);
}

function splitImageTag(image: string): { repo: string; tag: string } {
  const noDigest = image.split("@")[0];
  const lastColon = noDigest.lastIndexOf(":");
  const lastSlash = noDigest.lastIndexOf("/");
  if (lastColon > lastSlash && lastColon !== -1)
    return {
      repo: noDigest.slice(0, lastColon),
      tag: noDigest.slice(lastColon + 1),
    };
  return { repo: noDigest, tag: "latest" };
}

function parseComposeYaml(text: string): ComposeServiceDef[] {
  const doc = yaml.load(text) as any;
  const out: ComposeServiceDef[] = [];
  const services = doc?.services || {};
  for (const [name, def] of Object.entries<any>(services)) {
    let deps: string[] = [];
    const d = def?.depends_on;
    if (Array.isArray(d)) deps = d.map(String);
    else if (d && typeof d === "object") deps = Object.keys(d);
    const image: string | null = def?.image ?? null;
    const { repo, tag } = image
      ? splitImageTag(String(image))
      : { repo: null as any, tag: null as any };
    const ports: string[] = Array.isArray(def?.ports)
      ? def.ports.map((p: any) => String(p))
      : [];
    const networks: string[] = Array.isArray(def?.networks)
      ? def.networks.map(String)
      : def?.networks && typeof def.networks === "object"
        ? Object.keys(def.networks)
        : [];
    const volumes: string[] = Array.isArray(def?.volumes)
      ? def.volumes.map((v: any) => String(v))
      : [];
    out.push({
      service: name,
      image: image ? repo : null,
      tag: image ? tag : null,
      dependsOn: deps,
      ports,
      networks,
      volumes,
    });
  }
  return out;
}

export async function discoverComposeFiles(
  paths?: string[]
): Promise<ComposeDiscovery> {
  let target = paths && paths.length ? paths : undefined;
  if (!target) {
    const cfg = await getDiscoveryConfig();
    if (cfg.composePaths && cfg.composePaths.length)
      target = cfg.composePaths;
  }
  if (!target) target = await autoDetectComposeFiles();

  const files: ComposeFileDiscovery[] = [];
  for (const p of target) {
    try {
      const text = await fs.readFile(p, "utf8");
      files.push({
        path: p,
        parsed: true,
        error: null,
        services: parseComposeYaml(text),
      });
    } catch (e) {
      files.push({
        path: p,
        parsed: false,
        error: e instanceof Error ? e.message : "read/parse failed",
        services: [],
      });
    }
  }

  // Reconcile against running containers (real Docker state).
  const docker = await discoverDocker();
  const running = docker.containers;

  const reconcile: ComposeReconcileItem[] = [];
  const composeServiceNames = new Set<string>();

  for (const f of files) {
    for (const s of f.services) {
      composeServiceNames.add(s.service);
      // Match running container by compose service label OR by name.
      const match = running.find(
        (c) =>
          c.composeService === s.service ||
          c.name === s.service ||
          c.name.endsWith(`_${s.service}`) ||
          c.name.endsWith(`-${s.service}`)
      );
      if (!match) {
        reconcile.push({
          service: s.service,
          composeImage: s.image,
          composeTag: s.tag,
          runningImage: null,
          runningTag: null,
          state: "missing",
          versionDrift: false,
        });
        continue;
      }
      const drift =
        !!s.tag && !!match.tag && s.tag !== match.tag && s.image === match.image;
      reconcile.push({
        service: s.service,
        composeImage: s.image,
        composeTag: s.tag,
        runningImage: match.image,
        runningTag: match.tag,
        state: "running",
        versionDrift: drift,
      });
    }
  }

  // Orphans: running containers that belong to no compose service we parsed.
  const orphans: string[] = [];
  for (const c of running) {
    const svc = c.composeService || c.name;
    const matched =
      composeServiceNames.has(svc) ||
      Array.from(composeServiceNames).some(
        (n) => c.name === n || c.name.endsWith(`_${n}`) || c.name.endsWith(`-${n}`)
      );
    if (!matched) orphans.push(c.name);
  }

  const missing = reconcile
    .filter((r) => r.state === "missing")
    .map((r) => r.service);
  const versionDrift = reconcile.filter((r) => r.versionDrift);

  return { files, reconcile, orphans, missing, versionDrift };
}

// ───────────────────────────── Probe (real) ─────────────────────────────

export interface ProbeResult {
  host: string;
  port: number;
  tcpOpen: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  httpPath: string | null;
  signature: string | null;
  note: string | null;
}

function tcpConnect(
  host: string,
  port: number,
  timeoutMs = 1500
): Promise<{ open: boolean; ms: number | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* noop */
      }
      resolve({ open, ms: open ? Date.now() - start : null });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

async function httpHealth(
  host: string,
  port: number,
  paths: string[]
): Promise<{ status: number; path: string } | null> {
  for (const pth of paths) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`http://${host}:${port}${pth}`, {
        signal: ctrl.signal,
        redirect: "manual",
      });
      clearTimeout(to);
      return { status: r.status, path: pth };
    } catch {
      /* try next path */
    }
  }
  return null;
}

/**
 * Real TCP connect + best-effort HTTP health probe + datastore signature.
 * Only meaningful for the LOCAL host — remote probing requires SSH, which is
 * an honest limitation reported in the result note.
 */
export async function probeService(
  host: string,
  port: number,
  probePaths: string[] = DEFAULT_PROBE_PATHS
): Promise<ProbeResult> {
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  const result: ProbeResult = {
    host,
    port,
    tcpOpen: false,
    latencyMs: null,
    httpStatus: null,
    httpPath: null,
    signature: null,
    note: null,
  };
  if (!isLocal) {
    result.note =
      "Remote host not probed — SSH-based remote probing not performed (honest limitation).";
    return result;
  }
  const tcp = await tcpConnect(host, port);
  result.tcpOpen = tcp.open;
  result.latencyMs = tcp.ms;
  if (!tcp.open) {
    result.note = "TCP connect failed — port closed or service down.";
    return result;
  }
  const sig = PORT_SIGNATURES[port];
  if (sig) result.signature = sig.name;
  const http = await httpHealth(host, port, probePaths);
  if (http) {
    result.httpStatus = http.status;
    result.httpPath = http.path;
  } else if (!sig) {
    result.note =
      "TCP open but no known health endpoint responded — service type unknown.";
  }
  return result;
}

// ───────────────────────── Dependency graph ─────────────────────────

export type DetectionType = "explicit" | "inferred" | "observed";
export type NodeStatus = "green" | "yellow" | "red" | "unknown";

export interface GraphNode {
  id: string;
  label: string;
  kind: string; // service | database | cache | queue | search | storage | external
  status: NodeStatus;
  detail: string | null;
}
export interface GraphEdge {
  from: string;
  to: string;
  detectionType: DetectionType;
  label: string | null;
}
export interface DependencyGraph {
  dockerReachable: boolean;
  dockerError: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function statusFromContainer(c: DiscoveredContainer): NodeStatus {
  if (c.state !== "running") return "red";
  if (c.health === "unhealthy") return "red";
  if (c.health === "starting") return "yellow";
  if (c.health === "healthy") return "green";
  return c.state === "running" ? "green" : "unknown";
}

export async function buildDependencyGraph(): Promise<DependencyGraph> {
  const docker = await discoverDocker();
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  if (!docker.reachable) {
    return {
      dockerReachable: false,
      dockerError: docker.error,
      nodes: [],
      edges: [],
    };
  }

  for (const c of docker.containers) {
    const kind = c.classification?.kind || "service";
    nodes.set(c.name, {
      id: c.name,
      label: c.composeService || c.name,
      kind,
      status: statusFromContainer(c),
      detail: c.classification
        ? `${c.classification.name} (${c.image}:${c.tag})`
        : `${c.image}:${c.tag}`,
    });
  }

  // Explicit edges from compose depends_on labels.
  for (const c of docker.containers) {
    for (const dep of c.dependsOn) {
      const target =
        docker.containers.find(
          (x) => x.composeService === dep || x.name === dep
        )?.name || dep;
      if (!nodes.has(target)) {
        nodes.set(target, {
          id: target,
          label: target,
          kind: "service",
          status: "unknown",
          detail: "Referenced by depends_on but not observed running.",
        });
      }
      edges.push({
        from: c.name,
        to: target,
        detectionType: "explicit",
        label: "depends_on",
      });
    }
  }

  // Inferred edges from connection-string env var KEYS (value never read).
  for (const c of docker.containers) {
    for (const key of c.connectionKeys) {
      let kind = "service";
      if (/REDIS/.test(key)) kind = "cache";
      else if (/DATABASE|POSTGRES|PG_|MONGO/.test(key)) kind = "database";
      else if (/CELERY|AMQP|RABBIT/.test(key)) kind = "queue";
      else if (/MEILI|ELASTIC/.test(key)) kind = "search";
      else if (/MINIO|S3/.test(key)) kind = "storage";
      // Try to point at a real observed datastore of that kind.
      const target = docker.containers.find(
        (x) => x.classification?.kind === kind && x.name !== c.name
      );
      const targetId = target ? target.name : `${kind}:external`;
      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          label: target ? target.name : `external ${kind}`,
          kind: target ? kind : "external",
          status: "unknown",
          detail: `Inferred from env var ${key} — exact target not certain.`,
        });
      }
      edges.push({
        from: c.name,
        to: targetId,
        detectionType: "inferred",
        label: key,
      });
    }
  }

  return {
    dockerReachable: true,
    dockerError: null,
    nodes: Array.from(nodes.values()),
    edges,
  };
}

// ──────────────────────────── Proposals ────────────────────────────

interface ProposalDraft {
  kind: string;
  title: string;
  description: string;
  proposed: Record<string, unknown>;
  evidence: Record<string, unknown>;
  /** stable identity used for dedupe / supersede */
  dedupeKey: string;
}

const HUMAN_CAVEAT =
  "Auto-discovery cannot infer business semantics — a human ADMIN must confirm " +
  "this is correct (e.g. which database is the primary/main one). Nothing is " +
  "applied until you explicitly accept this proposal.";

function localHostName(): string {
  return process.env.PANEL_LOCAL_HOST || "local";
}

/** Build proposal drafts from real discovery. Never fabricates. */
export async function planProposals(): Promise<ProposalDraft[]> {
  const drafts: ProposalDraft[] = [];
  const docker = await discoverDocker();
  if (!docker.reachable) return drafts;

  const host = localHostName();

  // 1. Register the local host (we observed Docker locally).
  drafts.push({
    kind: "service",
    title: `Register local host "${host}"`,
    description:
      `Discovery ran against the local Docker daemon. Proposing to register ` +
      `host "${host}" (isLocal). ${HUMAN_CAVEAT}`,
    proposed: {
      effect: "upsertHost",
      host: {
        name: host,
        address: "127.0.0.1",
        isLocal: true,
      },
    },
    evidence: {
      dockerReachable: true,
      containerCount: docker.containers.length,
    },
    dedupeKey: `host:${host}`,
  });

  // 2. Datastores / infra services (real classified containers).
  for (const c of docker.containers) {
    if (!c.classification) continue;
    const { kind, name } = c.classification;
    if (!["database", "cache", "queue", "search", "storage", "service"].includes(kind))
      continue;
    if (kind === "service" && !/nginx|daphne|celery/i.test(c.image)) continue;
    drafts.push({
      kind,
      title: `Register ${name} — container "${c.name}"`,
      description:
        `Observed a running "${name}" (${c.image}:${c.tag}) as container ` +
        `"${c.name}". Proposing to register it as a known ${kind}. ` +
        HUMAN_CAVEAT,
      proposed: {
        effect: "setSetting",
        settingKey: `discovery.service.${c.name}`,
        settingValue: {
          kind,
          name,
          container: c.name,
          image: `${c.image}:${c.tag}`,
          ports: c.ports,
        },
      },
      evidence: {
        container: c.name,
        image: `${c.image}:${c.tag}`,
        state: c.state,
        health: c.health,
        ports: c.ports,
        envMasked: c.envMasked,
      },
      dedupeKey: `service:${c.name}`,
    });

    // Published ports → PortAllocation proposal.
    for (const p of c.ports) {
      if (p.publicPort == null) continue;
      drafts.push({
        kind: "service",
        title: `Register port ${p.publicPort}/${p.type} on "${host}" (${c.name})`,
        description:
          `Container "${c.name}" publishes ${p.publicPort}→${p.privatePort}/` +
          `${p.type}. Proposing a PortAllocation record. ${HUMAN_CAVEAT}`,
        proposed: {
          effect: "upsertPortAllocation",
          port: {
            hostName: host,
            port: p.publicPort,
            protocol: p.type || "tcp",
            iface: "0.0.0.0",
            containerName: c.name,
            serviceName: c.composeService || c.name,
            discoveredVia: "docker",
            isPublic: true,
          },
        },
        evidence: {
          container: c.name,
          publicPort: p.publicPort,
          privatePort: p.privatePort,
          type: p.type,
        },
        dedupeKey: `port:${host}:${p.publicPort}:${p.type || "tcp"}`,
      });
    }
  }

  // 3. External integrations — only that a KEY exists, never the value.
  const seenIntegration = new Set<string>();
  for (const c of docker.containers) {
    for (const key of c.integrationKeys) {
      if (seenIntegration.has(key)) continue;
      seenIntegration.add(key);
      drafts.push({
        kind: "integration",
        title: `External integration detected: ${key}`,
        description:
          `Environment variable "${key}" is present in container "${c.name}". ` +
          `Only the FACT that this key exists is recorded — its value is NEVER ` +
          `stored or read. Proposing to flag the related integration as in-use. ` +
          HUMAN_CAVEAT,
        proposed: {
          effect: "noteIntegration",
          envKey: key,
          observedInContainer: c.name,
        },
        evidence: {
          envKeyPresent: key,
          container: c.name,
          // explicitly NOT including the value
          valueStored: false,
        },
        dedupeKey: `integration:${key}`,
      });
    }
  }

  return drafts;
}

/**
 * Persist drafts as DiscoveryProposal rows. Dedupes against existing
 * pending/accepted proposals by dedupeKey (stored in proposed.__key). Stale
 * pending proposals whose dedupeKey is no longer produced are superseded.
 */
export async function generateProposals(): Promise<{
  created: number;
  superseded: number;
  proposals: { id: string; dedupeKey: string }[];
}> {
  const drafts = await planProposals();
  const draftKeys = new Set(drafts.map((d) => d.dedupeKey));

  const existing = await prisma.discoveryProposal.findMany({
    where: { status: { in: ["pending", "accepted"] } },
  });
  const existingByKey = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    const k = (e.proposed as any)?.__key as string | undefined;
    if (k) existingByKey.set(k, e);
  }

  let created = 0;
  const out: { id: string; dedupeKey: string }[] = [];

  for (const d of drafts) {
    const prior = existingByKey.get(d.dedupeKey);
    if (prior) {
      // Already known (pending or accepted) — do not duplicate.
      out.push({ id: prior.id, dedupeKey: d.dedupeKey });
      continue;
    }
    const row = await prisma.discoveryProposal.create({
      data: {
        kind: d.kind,
        title: d.title,
        description: d.description,
        proposed: { ...d.proposed, __key: d.dedupeKey } as object,
        evidence: d.evidence as object,
        status: "pending",
      },
    });
    created++;
    out.push({ id: row.id, dedupeKey: d.dedupeKey });
  }

  // Supersede stale pending proposals no longer produced by discovery.
  const stale = existing.filter(
    (e) =>
      e.status === "pending" &&
      (e.proposed as any)?.__key &&
      !draftKeys.has((e.proposed as any).__key)
  );
  if (stale.length) {
    await prisma.discoveryProposal.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: "superseded" },
    });
  }

  return { created, superseded: stale.length, proposals: out };
}

/**
 * Apply an accepted proposal's effect. Idempotent upserts. For integrations we
 * only flip enabled / note an endpoint reference — NEVER store the secret.
 */
export async function applyProposalEffect(
  proposed: Record<string, any>
): Promise<{ applied: string; ref: string }> {
  const effect = proposed.effect;
  switch (effect) {
    case "upsertHost": {
      const h = proposed.host;
      await prisma.host.upsert({
        where: { name: h.name },
        create: {
          name: h.name,
          address: h.address ?? "127.0.0.1",
          isLocal: !!h.isLocal,
          lastSeenAt: new Date(),
        },
        update: { lastSeenAt: new Date(), address: h.address ?? undefined },
      });
      return { applied: "host", ref: h.name };
    }
    case "upsertPortAllocation": {
      const p = proposed.port;
      // Ensure host exists (FK).
      await prisma.host.upsert({
        where: { name: p.hostName },
        create: {
          name: p.hostName,
          address: "127.0.0.1",
          isLocal: true,
          lastSeenAt: new Date(),
        },
        update: {},
      });
      await prisma.portAllocation.upsert({
        where: {
          hostName_port_protocol_iface: {
            hostName: p.hostName,
            port: p.port,
            protocol: p.protocol || "tcp",
            iface: p.iface || "0.0.0.0",
          },
        },
        create: {
          hostName: p.hostName,
          port: p.port,
          protocol: p.protocol || "tcp",
          iface: p.iface || "0.0.0.0",
          containerName: p.containerName ?? null,
          serviceName: p.serviceName ?? null,
          discoveredVia: p.discoveredVia || "docker",
          isPublic: !!p.isPublic,
          status: "active",
        },
        update: {
          containerName: p.containerName ?? null,
          serviceName: p.serviceName ?? null,
          lastSeen: new Date(),
          status: "active",
        },
      });
      return {
        applied: "portAllocation",
        ref: `${p.hostName}:${p.port}/${p.protocol || "tcp"}`,
      };
    }
    case "setSetting": {
      await prisma.setting.upsert({
        where: { key: proposed.settingKey },
        create: { key: proposed.settingKey, value: proposed.settingValue },
        update: { value: proposed.settingValue },
      });
      return { applied: "setting", ref: proposed.settingKey };
    }
    case "noteIntegration": {
      // Only note the endpoint reference / usage — never the secret value.
      const key = `discovery.integration.${proposed.envKey}`;
      await prisma.setting.upsert({
        where: { key },
        create: {
          key,
          value: {
            envKey: proposed.envKey,
            observedInContainer: proposed.observedInContainer,
            secretStored: false,
            notedAt: new Date().toISOString(),
          },
        },
        update: {
          value: {
            envKey: proposed.envKey,
            observedInContainer: proposed.observedInContainer,
            secretStored: false,
            notedAt: new Date().toISOString(),
          },
        },
      });
      // Best-effort: if a matching Integration row exists, flip enabled.
      const map: Record<string, string> = {
        OPENROUTER_API_KEY: "openrouter",
        GEMINI_API_KEY: "gemini",
        OPENAI_API_KEY: "openai",
        ANTHROPIC_API_KEY: "anthropic",
      };
      const ik = map[proposed.envKey];
      if (ik) {
        await prisma.integration
          .updateMany({ where: { key: ik }, data: { enabled: true } })
          .catch(() => {});
      }
      return { applied: "integration", ref: proposed.envKey };
    }
    default:
      return { applied: "none", ref: "unknown effect — nothing applied" };
  }
}

// ─────────────────────────── Config ───────────────────────────

export async function getDiscoveryConfig(): Promise<DiscoveryConfig> {
  const row = await prisma.setting.findUnique({ where: { key: "discovery" } });
  return (row?.value as DiscoveryConfig) ?? {};
}

export async function setDiscoveryConfig(
  cfg: DiscoveryConfig
): Promise<DiscoveryConfig> {
  const clean: DiscoveryConfig = {
    composePaths: Array.isArray(cfg.composePaths)
      ? cfg.composePaths.filter(Boolean)
      : undefined,
    scanIntervalSec:
      typeof cfg.scanIntervalSec === "number" && cfg.scanIntervalSec > 0
        ? Math.floor(cfg.scanIntervalSec)
        : undefined,
    probePaths: Array.isArray(cfg.probePaths)
      ? cfg.probePaths.filter(Boolean)
      : undefined,
  };
  await prisma.setting.upsert({
    where: { key: "discovery" },
    create: { key: "discovery", value: clean as object },
    update: { value: clean as object },
  });
  return clean;
}

// ─────────────────────────── Job runner ───────────────────────────

export async function runDiscoveryJob(
  createdById?: string | null
): Promise<string> {
  const job = await createJob({
    kind: "discovery",
    label: "Service & dependency auto-discovery",
    createdById: createdById ?? null,
  });
  runJob(job.id, async (ctx) => {
    await ctx.log("Starting auto-discovery (honest: only observed facts).");
    await ctx.progress(5);

    await ctx.log("Enumerating running Docker containers…");
    const docker = await discoverDocker();
    if (!docker.reachable) {
      await ctx.log(
        `Docker not reachable: ${docker.error} — reporting honestly, no fabrication.`
      );
    } else {
      await ctx.log(`Observed ${docker.containers.length} container(s).`);
    }
    await ctx.progress(30);
    if (ctx.cancelled()) return { cancelled: true };

    await ctx.log("Parsing & reconciling compose files…");
    const compose = await discoverComposeFiles();
    await ctx.log(
      `Parsed ${compose.files.length} compose file(s); ` +
        `${compose.orphans.length} orphan(s), ${compose.missing.length} missing, ` +
        `${compose.versionDrift.length} version-drift.`
    );
    await ctx.progress(55);
    if (ctx.cancelled()) return { cancelled: true };

    await ctx.log("Building dependency graph from real container state…");
    const graph = await buildDependencyGraph();
    await ctx.log(
      `Graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s).`
    );
    await ctx.progress(75);
    if (ctx.cancelled()) return { cancelled: true };

    await ctx.log("Generating proposals (pending — require human accept)…");
    const gen = await generateProposals();
    await ctx.log(
      `Created ${gen.created} new proposal(s); superseded ${gen.superseded} stale.`
    );
    await ctx.progress(100);

    return {
      dockerReachable: docker.reachable,
      containers: docker.containers.length,
      composeFiles: compose.files.length,
      orphans: compose.orphans,
      missing: compose.missing,
      versionDrift: compose.versionDrift.length,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      proposalsCreated: gen.created,
      proposalsSuperseded: gen.superseded,
    };
  });
  return job.id;
}
