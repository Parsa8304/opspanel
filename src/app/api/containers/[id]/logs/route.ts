import { NextRequest } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { docker, demuxDockerStream } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const { id } = ctx.params;
    const url = new URL(req.url);
    const tailRaw = url.searchParams.get("tail");
    const tail = tailRaw && tailRaw !== "all" ? parseInt(tailRaw, 10) || 500 : "all";
    const since = url.searchParams.get("since");
    const download = url.searchParams.get("download") === "1";

    const container = docker.getContainer(id);
    const opts: any = {
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
      follow: false,
    };
    if (since) {
      const n = Number(since);
      opts.since = Number.isFinite(n) && n > 0 ? n : Math.floor(new Date(since).getTime() / 1000);
    }

    const buf = (await container.logs(opts)) as unknown as Buffer;
    const text = demuxDockerStream(Buffer.from(buf));

    if (download) {
      return new Response(text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${id.slice(0, 12)}-logs.txt"`,
        },
      });
    }
    return new Response(JSON.stringify({ logs: text }), {
      headers: { "content-type": "application/json" },
    });
  }
);
