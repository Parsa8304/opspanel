import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { hostExec, hostReadFile } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  // Read daemon.json (default location)
  let config: Record<string, unknown> = {};
  let raw = "";
  let parseError: string | null = null;
  try {
    raw = await hostReadFile("/etc/docker/daemon.json");
    config = JSON.parse(raw);
  } catch (e: any) {
    if (!e.message?.includes("No such file")) {
      parseError = e.message;
    }
  }

  // Check if backup exists
  let hasBackup = false;
  try {
    await hostExec("test -f /etc/docker/daemon.json.bak");
    hasBackup = true;
  } catch {}

  // Get docker info for current state
  let dockerInfo: Record<string, unknown> = {};
  try {
    const { stdout } = await hostExec("docker info --format '{{json .}}'");
    dockerInfo = JSON.parse(stdout.trim());
  } catch {}

  return json({ config, raw, parseError, hasBackup, dockerInfo });
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const { config, restartDocker } = await req.json();

  // Validate JSON
  const newContent = JSON.stringify(config, null, 2);
  JSON.parse(newContent); // throws if invalid

  // Backup existing
  try {
    await hostExec("cp /etc/docker/daemon.json /etc/docker/daemon.json.bak");
  } catch {}

  // Write new config
  const escaped = newContent.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
  await hostExec(`printf '%s' '${escaped}' > /etc/docker/daemon.json`);

  // Diff
  let diff = "";
  try {
    const res = await hostExec("diff /etc/docker/daemon.json.bak /etc/docker/daemon.json || true");
    diff = res.stdout;
  } catch {}

  let restarted = false;
  let dockerRunning = true;
  if (restartDocker) {
    await hostExec("systemctl restart docker");
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await hostExec("systemctl is-active docker");
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
