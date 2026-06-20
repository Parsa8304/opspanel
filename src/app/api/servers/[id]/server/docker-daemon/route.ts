import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { targetExec, targetReadFile } from "@/lib/target";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  // Read daemon.json (default location)
  let config: Record<string, unknown> = {};
  let raw = "";
  let parseError: string | null = null;
  try {
    raw = await targetReadFile(id, "/etc/docker/daemon.json");
    config = JSON.parse(raw);
  } catch (e: any) {
    if (!e.message?.includes("No such file")) {
      parseError = e.message;
    }
  }

  // Check if backup exists
  let hasBackup = false;
  try {
    await targetExec(id, "test -f /etc/docker/daemon.json.bak");
    hasBackup = true;
  } catch {}

  // Get docker info for current state
  let dockerInfo: Record<string, unknown> = {};
  try {
    const { stdout } = await targetExec(id, "docker info --format '{{json .}}'");
    dockerInfo = JSON.parse(stdout.trim());
  } catch {}

  return json({ config, raw, parseError, hasBackup, dockerInfo });
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;
  const { config, restartDocker } = await req.json();

  // Validate JSON
  const newContent = JSON.stringify(config, null, 2);
  JSON.parse(newContent); // throws if invalid

  // Backup existing
  try {
    await targetExec(id, "cp /etc/docker/daemon.json /etc/docker/daemon.json.bak");
  } catch {}

  // Write new config
  const escaped = newContent.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  await targetExec(id, `printf '%s' '${escaped}' > /etc/docker/daemon.json`);

  // Diff
  let diff = "";
  try {
    const res = await targetExec(id, "diff /etc/docker/daemon.json.bak /etc/docker/daemon.json || true");
    diff = res.stdout;
  } catch {}

  let restarted = false;
  let dockerRunning = true;
  if (restartDocker) {
    await targetExec(id, "systemctl restart docker");
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await targetExec(id, "systemctl is-active docker");
      dockerRunning = true;
    } catch {
      dockerRunning = false;
    }
    restarted = true;
  }

  await audit(
    u.id,
    "server.docker-daemon.update",
    undefined,
    { restarted },
    req.headers.get("x-forwarded-for") || undefined
  );

  return json({ ok: true, diff, restarted, dockerRunning });
});
