import { prisma } from "./prisma";

/**
 * Lightweight DB-backed background job runner (panel is JS-only; no separate
 * worker process). Jobs run in-process on the Next server; progress/log are
 * persisted to BackgroundJob so the UI can stream them via SSE and they
 * survive a page reload. Cancellation is cooperative via the registry.
 */

type Ctx = {
  jobId: string;
  log: (line: string) => Promise<void>;
  progress: (pct: number) => Promise<void>;
  cancelled: () => boolean;
};

const cancelRegistry = new Set<string>();
const running = new Set<string>();

export function requestCancel(jobId: string) {
  cancelRegistry.add(jobId);
}

export async function createJob(input: {
  kind: string;
  label: string;
  params?: unknown;
  createdById?: string | null;
}) {
  return prisma.backgroundJob.create({
    data: {
      kind: input.kind,
      label: input.label,
      params: (input.params as object) ?? undefined,
      createdById: input.createdById ?? undefined,
      state: "QUEUED",
    },
  });
}

/** Start a job's async work. Returns immediately; work continues in-process. */
export function runJob(
  jobId: string,
  fn: (ctx: Ctx) => Promise<unknown>
): void {
  if (running.has(jobId)) return;
  running.add(jobId);

  const append = async (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    // Prisma has no string-append; read-modify-write (jobs are low-frequency).
    const cur = await prisma.backgroundJob.findUnique({
      where: { id: jobId },
      select: { log: true },
    });
    await prisma.backgroundJob
      .update({
        where: { id: jobId },
        data: { log: (cur?.log ?? "") + stamped },
      })
      .catch(() => {});
  };

  const ctx: Ctx = {
    jobId,
    log: append,
    progress: async (pct) => {
      await prisma.backgroundJob
        .update({
          where: { id: jobId },
          data: { progress: Math.max(0, Math.min(100, Math.round(pct))) },
        })
        .catch(() => {});
    },
    cancelled: () => cancelRegistry.has(jobId),
  };

  (async () => {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: { state: "RUNNING", startedAt: new Date() },
    });
    try {
      const result = await fn(ctx);
      const cancelled = cancelRegistry.has(jobId);
      await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          state: cancelled ? "CANCELLED" : "SUCCEEDED",
          progress: cancelled ? undefined : 100,
          result: (result as object) ?? undefined,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await prisma.backgroundJob.update({
        where: { id: jobId },
        data: {
          state: "FAILED",
          error: e instanceof Error ? e.message : String(e),
          finishedAt: new Date(),
        },
      });
    } finally {
      running.delete(jobId);
      cancelRegistry.delete(jobId);
    }
  })();
}

/** SSE Response that streams a job's progress/log until terminal state. */
export function jobStreamResponse(jobId: string): Response {
  const enc = new TextEncoder();
  let sentLen = 0;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let done = false;
      while (!done) {
        const j = await prisma.backgroundJob.findUnique({
          where: { id: jobId },
        });
        if (!j) {
          send({ error: "job not found" });
          break;
        }
        const delta = j.log.slice(sentLen);
        sentLen = j.log.length;
        send({
          state: j.state,
          progress: j.progress,
          logDelta: delta,
          error: j.error,
        });
        if (
          ["SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"].includes(j.state)
        ) {
          done = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
