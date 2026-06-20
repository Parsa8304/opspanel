import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { streamLogs } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

/**
 * SSE live log tail for a container on any server (local or remote), built
 * on targetSpawn (nsenter locally, SSH remotely) running `docker logs -f`.
 * Each line received is emitted as an SSE `data:` event, matching the shape
 * the LogDrawer UI already expects from the local-only endpoint.
 */
export const GET = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; cid: string }> }) => {
    await requireRole(req, "READONLY");
    const { id, cid } = await ctx.params;
    const url = new URL(req.url);
    const tailRaw = url.searchParams.get("tail");
    const tail: number | "all" = tailRaw && tailRaw !== "all" ? parseInt(tailRaw, 10) || 200 : 200;

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: open\ndata: {}\n\n`));
        const ping = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {}
        }, 15000);

        const onLine = (line: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line })}\n\n`));
          } catch {}
        };

        streamLogs(id, cid, onLine, tail, 600000)
          .catch((err: Error) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
              );
            } catch {}
          })
          .finally(() => {
            clearInterval(ping);
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`event: end\ndata: {}\n\n`));
              controller.close();
            } catch {}
          });

        req.signal.addEventListener("abort", () => {
          closed = true;
          clearInterval(ping);
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        closed = true;
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
  }
);
