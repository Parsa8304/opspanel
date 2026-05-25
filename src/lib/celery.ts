import Redis from "ioredis";
import { prisma } from "./prisma";
import { getSetting } from "./api";

/** Setting key holding the Redis/Celery broker config. */
export const REDIS_SETTING_KEY = "redis";

/** The 6 product Celery task types. */
export const TASK_TYPES = [
  "quick_report",
  "decision_engine",
  "gtm_strategy",
  "pitch_deck",
  "find_experts",
  "ai_research_assistant",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface RedisConfig {
  /** Broker URL, e.g. redis://localhost:6390 */
  url?: string;
  /** Celery queue list keys to inspect. Defaults to ["celery"]. */
  queues?: string[];
  /** Optional explicit dead-letter list key. Defaults to "<queue>.dlq". */
  dlq?: string;
}

export const DEFAULT_REDIS_URL = "redis://localhost:6390";

/** Honest typed error when the broker cannot be reached. */
export class RedisNotReachableError extends Error {
  code = "REDIS_UNREACHABLE" as const;
  constructor(msg = "Redis broker is not reachable") {
    super(msg);
    this.name = "RedisNotReachableError";
  }
}

export async function readRedisConfig(): Promise<RedisConfig> {
  const cfg = await getSetting<RedisConfig>(REDIS_SETTING_KEY, {});
  return cfg || {};
}

/** Effective broker URL: env override > Setting > default. */
export async function resolveRedisUrl(cfg?: RedisConfig): Promise<string> {
  const c = cfg ?? (await readRedisConfig());
  return process.env.REDIS_URL || c.url || DEFAULT_REDIS_URL;
}

/** Discover the Celery queue list keys to inspect. */
export function resolveQueues(cfg: RedisConfig): string[] {
  const qs = (cfg.queues || []).map((q) => q.trim()).filter(Boolean);
  return qs.length ? qs : ["celery"];
}

/**
 * Lazily build an ioredis client and verify it is reachable.
 * Throws RedisNotReachableError (never fabricates a working client).
 * Caller is responsible for quit()-ing the returned client.
 */
export async function getRedis(cfg?: RedisConfig): Promise<Redis> {
  const url = await resolveRedisUrl(cfg);
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // do not auto-retry; fail fast and honestly
    enableOfflineQueue: false,
  });
  // Swallow async error events so an unreachable broker doesn't crash the process.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
  } catch (e) {
    try {
      client.disconnect();
    } catch {}
    throw new RedisNotReachableError(
      e instanceof Error ? e.message : "connect failed"
    );
  }
  return client;
}

/** Run a function with a live client, always cleaning up. */
async function withRedis<T>(
  fn: (r: Redis) => Promise<T>,
  cfg?: RedisConfig
): Promise<T> {
  const r = await getRedis(cfg);
  try {
    return await fn(r);
  } finally {
    try {
      await r.quit();
    } catch {
      try {
        r.disconnect();
      } catch {}
    }
  }
}

export interface QueueDepth {
  queue: string;
  depth: number;
}

/**
 * LLEN per Celery queue list key. The default Celery Redis broker stores
 * pending messages as a Redis list named after the queue (default "celery").
 */
export async function queueDepths(
  queues?: string[],
  cfg?: RedisConfig
): Promise<QueueDepth[]> {
  const c = cfg ?? (await readRedisConfig());
  const qs = queues && queues.length ? queues : resolveQueues(c);
  return withRedis(async (r) => {
    const out: QueueDepth[] = [];
    for (const q of qs) {
      // A queue key may legitimately not exist yet -> depth 0 (honest).
      let depth = 0;
      try {
        const type = await r.type(q);
        if (type === "list") depth = await r.llen(q);
        else if (type === "none") depth = 0;
        else depth = 0; // wrong type -> not a Celery list; report 0, not a guess
      } catch {
        depth = 0;
      }
      out.push({ queue: q, depth });
    }
    return out;
  }, c);
}

export interface WorkerSignal {
  /**
   * Coarse / inferred — Celery does not write a standard worker registry to
   * Redis. We surface real signals that are observable from the broker only.
   */
  inferred: true;
  connectedClients: number | null;
  /** Heartbeat-style keys if a result/heartbeat backend writes them. */
  workerKeys: string[];
  /** Unacked (in-flight) message counts per known unacked structure. */
  unacked: { key: string; count: number }[];
  /** True when no worker telemetry of any kind is observable. */
  noTelemetry: boolean;
  note: string;
}

/**
 * Best-effort, clearly-labelled worker signal. There is NO standard Celery
 * key for live workers in the Redis broker, so this returns only real,
 * observable broker facts (connected clients, any celery@* heartbeat keys,
 * unacked in-flight structures) and never fabricates worker identities.
 */
export async function activeWorkers(
  cfg?: RedisConfig
): Promise<WorkerSignal> {
  const c = cfg ?? (await readRedisConfig());
  return withRedis(async (r) => {
    let connectedClients: number | null = null;
    try {
      const info = await r.info("clients");
      const m = /connected_clients:(\d+)/.exec(info);
      if (m) connectedClients = parseInt(m[1], 10);
    } catch {
      connectedClients = null;
    }

    // celery@<host> keys are written by some result/heartbeat backends.
    const workerKeys: string[] = [];
    try {
      let cursor = "0";
      do {
        const [next, keys] = await r.scan(
          cursor,
          "MATCH",
          "celery@*",
          "COUNT",
          200
        );
        cursor = next;
        workerKeys.push(...keys);
      } while (cursor !== "0");
    } catch {
      /* ignore */
    }

    // Unacked / in-flight structures used by the Redis transport.
    const unacked: { key: string; count: number }[] = [];
    for (const key of ["unacked", "unacked_index", "unacked_mutex"]) {
      try {
        const type = await r.type(key);
        if (type === "none") continue;
        let count = 0;
        if (type === "hash") count = await r.hlen(key);
        else if (type === "zset") count = await r.zcard(key);
        else if (type === "list") count = await r.llen(key);
        else if (type === "set") count = await r.scard(key);
        unacked.push({ key, count });
      } catch {
        /* ignore */
      }
    }

    const noTelemetry =
      workerKeys.length === 0 && unacked.length === 0;

    return {
      inferred: true as const,
      connectedClients,
      workerKeys,
      unacked,
      noTelemetry,
      note:
        "Celery does not publish a live worker registry to the Redis broker. " +
        "Values are coarse broker-level signals (connected clients, heartbeat keys, " +
        "in-flight unacked structures). Run `celery inspect` for authoritative worker state.",
    };
  }, c);
}

/** Resolve the dead-letter list key for a queue. */
export function dlqKeyFor(queue: string, cfg: RedisConfig): string {
  return cfg.dlq || `${queue}.dlq`;
}

export interface DeadLetterEntry {
  index: number;
  raw: string;
  /** Parsed JSON when the payload is valid JSON, else null (honest). */
  parsed: unknown | null;
}

/** LRANGE the dead-letter list for a queue. */
export async function deadLetter(
  queue: string,
  cfg?: RedisConfig
): Promise<{ key: string; entries: DeadLetterEntry[] }> {
  const c = cfg ?? (await readRedisConfig());
  const key = dlqKeyFor(queue, c);
  return withRedis(async (r) => {
    let raws: string[] = [];
    try {
      const type = await r.type(key);
      if (type === "list") raws = await r.lrange(key, 0, -1);
    } catch {
      raws = [];
    }
    const entries: DeadLetterEntry[] = raws.map((raw, index) => {
      let parsed: unknown | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      return { index, raw, parsed };
    });
    return { key, entries };
  }, c);
}

/**
 * Retry a dead-letter entry: remove it from the DLQ list and re-push the
 * exact payload onto its originating queue list. Operates on REAL Redis.
 */
export async function retryDeadLetter(
  queue: string,
  raw: string,
  cfg?: RedisConfig
): Promise<{ requeued: boolean }> {
  const c = cfg ?? (await readRedisConfig());
  const key = dlqKeyFor(queue, c);
  return withRedis(async (r) => {
    const removed = await r.lrem(key, 1, raw);
    if (removed < 1) return { requeued: false };
    await r.rpush(queue, raw);
    return { requeued: true };
  }, c);
}

/** Discard a dead-letter entry: LREM it from the DLQ list. */
export async function discardDeadLetter(
  queue: string,
  raw: string,
  cfg?: RedisConfig
): Promise<{ removed: number }> {
  const c = cfg ?? (await readRedisConfig());
  const key = dlqKeyFor(queue, c);
  return withRedis(async (r) => {
    const removed = await r.lrem(key, 1, raw);
    return { removed };
  }, c);
}

export type JobStatusStr =
  | "PENDING"
  | "STARTED"
  | "SUCCESS"
  | "FAILURE"
  | "RETRY"
  | "DEAD";

export interface JobEvent {
  taskId: string;
  taskType: string;
  queue?: string;
  status: JobStatusStr;
  workerName?: string | null;
  durationMs?: number | null;
  error?: string | null;
  payloadMeta?: unknown;
}

const FINISHED: JobStatusStr[] = ["SUCCESS", "FAILURE", "DEAD"];

/** Upsert a JobRecord by its unique taskId from a reported job event. */
export async function recordJob(ev: JobEvent) {
  const finishedAt = FINISHED.includes(ev.status) ? new Date() : null;
  return prisma.jobRecord.upsert({
    where: { taskId: ev.taskId },
    create: {
      taskId: ev.taskId,
      taskType: ev.taskType,
      queue: ev.queue || "default",
      status: ev.status,
      workerName: ev.workerName ?? null,
      durationMs: ev.durationMs ?? null,
      error: ev.error ?? null,
      payloadMeta: (ev.payloadMeta as object) ?? undefined,
      finishedAt: finishedAt ?? undefined,
    },
    update: {
      taskType: ev.taskType,
      queue: ev.queue || undefined,
      status: ev.status,
      workerName: ev.workerName ?? undefined,
      durationMs: ev.durationMs ?? undefined,
      error: ev.error ?? undefined,
      payloadMeta:
        ev.payloadMeta !== undefined
          ? ((ev.payloadMeta as object) ?? undefined)
          : undefined,
      finishedAt: finishedAt ?? undefined,
    },
  });
}

/** Patch an existing JobRecord by taskId. */
export async function updateJob(
  taskId: string,
  patch: Partial<Omit<JobEvent, "taskId">>
) {
  const finishedAt =
    patch.status && FINISHED.includes(patch.status) ? new Date() : undefined;
  return prisma.jobRecord.update({
    where: { taskId },
    data: {
      taskType: patch.taskType ?? undefined,
      queue: patch.queue ?? undefined,
      status: patch.status ?? undefined,
      workerName: patch.workerName ?? undefined,
      durationMs: patch.durationMs ?? undefined,
      error: patch.error ?? undefined,
      payloadMeta:
        patch.payloadMeta !== undefined
          ? ((patch.payloadMeta as object) ?? undefined)
          : undefined,
      finishedAt,
    },
  });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)];
}

export interface TaskTypeStat {
  taskType: string;
  total: number;
  success: number;
  failure: number;
  retry: number;
  dead: number;
  pending: number;
  /** success / (success+failure+dead); null when no terminal jobs. */
  successRate: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  lastJobAt: string | null;
}

/**
 * Per-taskType statistics computed purely from REAL JobRecord rows in the
 * window. Always returns a row for each of the 6 product task types so the
 * UI can honestly show "0 / no data" rather than hide the task.
 */
export async function jobStats(
  windowHours: number
): Promise<TaskTypeStat[]> {
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows = await prisma.jobRecord.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });

  const byType = new Map<string, typeof rows>();
  for (const tt of TASK_TYPES) byType.set(tt, []);
  for (const r of rows) {
    if (!byType.has(r.taskType)) byType.set(r.taskType, []);
    byType.get(r.taskType)!.push(r);
  }

  const out: TaskTypeStat[] = [];
  for (const [taskType, list] of Array.from(byType.entries())) {
    const success = list.filter((r) => r.status === "SUCCESS").length;
    const failure = list.filter((r) => r.status === "FAILURE").length;
    const retry = list.filter((r) => r.status === "RETRY").length;
    const dead = list.filter((r) => r.status === "DEAD").length;
    const pending = list.filter(
      (r) => r.status === "PENDING" || r.status === "STARTED"
    ).length;
    const terminal = success + failure + dead;
    const durations = list
      .map((r) => r.durationMs)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    const last = list[0] ?? null;
    out.push({
      taskType,
      total: list.length,
      success,
      failure,
      retry,
      dead,
      pending,
      successRate: terminal ? success / terminal : null,
      avgDurationMs: durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : null,
      p95DurationMs: percentile(durations, 95),
      lastJobAt: last ? last.createdAt.toISOString() : null,
    });
  }
  // Stable order: the 6 product types first (config order), then any extras.
  const rank = new Map<string, number>(
    TASK_TYPES.map((t, i) => [t, i])
  );
  out.sort(
    (a, b) =>
      (rank.get(a.taskType) ?? 999) - (rank.get(b.taskType) ?? 999) ||
      a.taskType.localeCompare(b.taskType)
  );
  return out;
}

export interface WsCounters {
  reported: boolean;
  connections: number | null;
  messagesPerMin: number | null;
  updatedAt: string | null;
}

/**
 * WebSocket telemetry is only surfaced if the product reports it into the
 * Setting "ws" blob. Never fabricated.
 */
export async function wsCounters(): Promise<WsCounters> {
  const raw = await getSetting<{
    connections?: number;
    messagesPerMin?: number;
    updatedAt?: string;
  } | null>("ws", null);
  if (!raw || typeof raw !== "object") {
    return {
      reported: false,
      connections: null,
      messagesPerMin: null,
      updatedAt: null,
    };
  }
  return {
    reported: true,
    connections:
      typeof raw.connections === "number" ? raw.connections : null,
    messagesPerMin:
      typeof raw.messagesPerMin === "number" ? raw.messagesPerMin : null,
    updatedAt: raw.updatedAt ?? null,
  };
}
