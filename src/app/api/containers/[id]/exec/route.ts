import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { docker, demuxDockerStream } from "@/lib/docker";

export const dynamic = "force-dynamic";

/**
 * Non-interactive command runner. Demuxes the exec output stream.
 * Interactive PTY is intentionally not implemented.
 */
export const POST = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { id } = ctx.params;
    const body = await req.json().catch(() => ({}));
    let cmd: string[] = [];
    if (Array.isArray(body?.cmd)) cmd = body.cmd.map(String);
    else if (typeof body?.cmd === "string" && body.cmd.trim())
      cmd = ["/bin/sh", "-c", body.cmd];
    if (cmd.length === 0)
      return json({ error: "cmd is required" }, { status: 400 });

    const container = docker.getContainer(id);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream: any = await exec.start({ hijack: true, stdin: false });

    const chunks: Buffer[] = [];
    const output: string = await new Promise((resolve, reject) => {
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", () => resolve(demuxDockerStream(Buffer.concat(chunks))));
      stream.on("error", reject);
    });

    const info = await exec.inspect();
    await audit(
      u.id,
      "container.exec",
      id,
      { cmd },
      req.headers.get("x-forwarded-for") || undefined
    );
    return json({ output, exitCode: info.ExitCode ?? null });
  }
);
