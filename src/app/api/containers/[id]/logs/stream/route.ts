import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { docker } from "@/lib/docker";
import type { Readable } from "stream";

export const dynamic = "force-dynamic";

/**
 * SSE live log tail. Demuxes Docker's multiplexed stream frame-by-frame
 * and emits each log line as an SSE `data:` event.
 */
export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const { id } = ctx.params;
    const url = new URL(req.url);
    const tailRaw = url.searchParams.get("tail");
    const tail = tailRaw && tailRaw !== "all" ? parseInt(tailRaw, 10) || 200 : 200;
    const follow = url.searchParams.get("follow") !== "0";

    const container = docker.getContainer(id);
    const logStream = (await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
      follow,
    } as any)) as unknown as Readable;

    const encoder = new TextEncoder();
    let pending = Buffer.alloc(0);
    let lineBuf = "";

    function pushDemuxed(controller: ReadableStreamDefaultController, chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      let out = "";
      // Try multiplexed framing; fall back to raw if header invalid.
      while (pending.length >= 8) {
        const type = pending[0];
        if (type > 2 || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) {
          out += pending.toString("utf8");
          pending = Buffer.alloc(0);
          break;
        }
        const len = pending.readUInt32BE(4);
        if (pending.length < 8 + len) break; // wait for more
        out += pending.slice(8, 8 + len).toString("utf8");
        pending = pending.slice(8 + len);
      }
      if (!out) return;
      lineBuf += out;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const ln of lines) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ line: ln })}\n\n`)
        );
      }
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: open\ndata: {}\n\n`));
        const ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {}
        }, 15000);

        logStream.on("data", (chunk: Buffer) => {
          try {
            pushDemuxed(controller, Buffer.from(chunk));
          } catch {}
        });
        logStream.on("end", () => {
          if (lineBuf)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ line: lineBuf })}\n\n`)
            );
          clearInterval(ping);
          controller.enqueue(encoder.encode(`event: end\ndata: {}\n\n`));
          try {
            controller.close();
          } catch {}
        });
        logStream.on("error", (err: Error) => {
          clearInterval(ping);
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`
            )
          );
          try {
            controller.close();
          } catch {}
        });

        req.signal.addEventListener("abort", () => {
          clearInterval(ping);
          try {
            (logStream as any).destroy?.();
          } catch {}
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        try {
          (logStream as any).destroy?.();
        } catch {}
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
