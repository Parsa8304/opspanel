import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  readRedisConfig,
  resolveQueues,
  queueDepths,
  RedisNotReachableError,
} from "@/lib/celery";

export const dynamic = "force-dynamic";

/**
 * SSE: every ~2s push live queue depths (real Redis) and the newest
 * JobRecords (real Postgres). Honest redis-down marker, never fabricated.
 */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await readRedisConfig();
  const queues = resolveQueues(cfg);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };

      const tick = async () => {
        if (closed) return;
        let depths: { queue: string; depth: number }[] = [];
        let redisOk = true;
        let redisError: string | null = null;
        try {
          depths = await queueDepths(queues, cfg);
        } catch (e) {
          redisOk = false;
          redisError =
            e instanceof RedisNotReachableError ? e.message : "redis error";
        }
        let jobs: unknown[] = [];
        try {
          jobs = await prisma.jobRecord.findMany({
            orderBy: { createdAt: "desc" },
            take: 25,
          });
        } catch {
          jobs = [];
        }
        safeEnqueue(
          `data: ${JSON.stringify({
            ts: new Date().toISOString(),
            redis: { ok: redisOk, error: redisError },
            queueDepths: depths,
            jobs,
          })}\n\n`
        );
      };

      safeEnqueue(`event: open\ndata: {}\n\n`);
      tick();
      const interval = setInterval(tick, 2000);
      const ping = setInterval(() => safeEnqueue(`: ping\n\n`), 15000);

      const shutdown = () => {
        closed = true;
        clearInterval(interval);
        clearInterval(ping);
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
