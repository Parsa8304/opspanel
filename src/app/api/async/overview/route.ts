import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import {
  readRedisConfig,
  resolveQueues,
  queueDepths,
  activeWorkers,
  jobStats,
  wsCounters,
  RedisNotReachableError,
} from "@/lib/celery";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const url = new URL(req.url);
  const windowHours =
    parseInt(url.searchParams.get("windowHours") || "", 10) || 24;

  const cfg = await readRedisConfig();
  const queues = resolveQueues(cfg);

  // Historical job stats come from real Postgres — independent of Redis.
  const stats = await jobStats(windowHours);
  const ws = await wsCounters();

  let redisOk = true;
  let redisError: string | null = null;
  let depths: { queue: string; depth: number }[] = [];
  let workers: unknown = null;

  try {
    depths = await queueDepths(queues, cfg);
    workers = await activeWorkers(cfg);
  } catch (e) {
    if (e instanceof RedisNotReachableError) {
      redisOk = false;
      redisError = e.message;
    } else {
      throw e;
    }
  }

  return json({
    windowHours,
    queues,
    redis: { ok: redisOk, error: redisError },
    queueDepths: depths,
    workers,
    taskStats: stats,
    ws,
  });
});
