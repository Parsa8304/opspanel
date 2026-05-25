import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import {
  readRedisConfig,
  resolveQueues,
  deadLetter,
  dlqKeyFor,
  RedisNotReachableError,
} from "@/lib/celery";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const url = new URL(req.url);
  const cfg = await readRedisConfig();
  const queues = resolveQueues(cfg);
  const queue = url.searchParams.get("queue") || queues[0];

  try {
    const dl = await deadLetter(queue, cfg);
    return json({
      ok: true,
      queue,
      dlqKey: dl.key,
      entries: dl.entries,
    });
  } catch (e) {
    if (e instanceof RedisNotReachableError) {
      return json({
        ok: false,
        queue,
        dlqKey: dlqKeyFor(queue, cfg),
        entries: [],
        error: e.message,
      });
    }
    throw e;
  }
});
