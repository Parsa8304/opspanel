import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  readRedisConfig,
  resolveQueues,
  discardDeadLetter,
  RedisNotReachableError,
} from "@/lib/celery";

export const dynamic = "force-dynamic";

const schema = z.object({
  queue: z.string().optional(),
  /** Exact raw payload string to LREM from the DLQ list. */
  raw: z.string().min(1),
});

/** Discard a dead-letter entry against REAL Redis (LREM). */
export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const body = schema.parse(await req.json());
    const cfg = await readRedisConfig();
    const queue = body.queue || resolveQueues(cfg)[0];

    try {
      const res = await discardDeadLetter(queue, body.raw, cfg);
      await audit(user.id, "async.dlq.discard", `${queue}#${ctx.params.id}`, {
        removed: res.removed,
      });
      return json({ ok: true, queue, ...res });
    } catch (e) {
      if (e instanceof RedisNotReachableError)
        return json({ ok: false, error: e.message }, { status: 503 });
      throw e;
    }
  }
);
