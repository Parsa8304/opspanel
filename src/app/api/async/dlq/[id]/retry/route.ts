import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  readRedisConfig,
  resolveQueues,
  retryDeadLetter,
  RedisNotReachableError,
} from "@/lib/celery";

export const dynamic = "force-dynamic";

const schema = z.object({
  queue: z.string().optional(),
  /** Exact raw payload string to LREM-match and re-push. */
  raw: z.string().min(1),
});

/**
 * Retry a dead-letter entry against REAL Redis: remove the exact payload
 * from the DLQ list and re-push it onto its originating queue list.
 * `[id]` is the list position the client observed (audit only).
 */
export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const body = schema.parse(await req.json());
    const cfg = await readRedisConfig();
    const queue = body.queue || resolveQueues(cfg)[0];

    try {
      const res = await retryDeadLetter(queue, body.raw, cfg);
      await audit(user.id, "async.dlq.retry", `${queue}#${ctx.params.id}`, {
        requeued: res.requeued,
      });
      return json({ ok: true, queue, ...res });
    } catch (e) {
      if (e instanceof RedisNotReachableError)
        return json({ ok: false, error: e.message }, { status: 503 });
      throw e;
    }
  }
);
