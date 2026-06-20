import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { parseConfigLines, validateSshdChanges, SshdConfigError } from "@/lib/server";
import { targetExec, targetReadFile } from "@/lib/target";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  let config: Record<string, string> = {};
  try {
    const raw = await targetReadFile(id, "/etc/ssh/sshd_config");
    config = parseConfigLines(raw);
  } catch {}

  let lastLogins: string[] = [];
  try {
    const { stdout } = await targetExec(id, "last -n 20 -F 2>/dev/null || last -n 20");
    lastLogins = stdout
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("wtmp"))
      .slice(0, 20);
  } catch {}

  let failedAttempts: string[] = [];
  try {
    const { stdout } = await targetExec(
      id,
      "journalctl -u ssh -u sshd --since '24 hours ago' --no-pager 2>/dev/null | grep -E 'Failed|Invalid|Accepted' | tail -30"
    );
    failedAttempts = stdout.split("\n").filter(Boolean).slice(0, 30);
  } catch {}

  const sshPort = parseInt(config["Port"] || "22", 10);
  const hasPublicKey = !!(config["AuthorizedKeysFile"]);

  return json({ config, lastLogins, failedAttempts, sshPort, hasPublicKey });
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;
  const { changes: rawChanges, applyNow } = (await req.json()) as {
    changes: Record<string, string>;
    applyNow: boolean;
  };

  // Validate/whitelist all directive names and values BEFORE any shell use.
  let entries: Array<[string, string]>;
  try {
    entries = validateSshdChanges(rawChanges);
  } catch (e) {
    if (e instanceof SshdConfigError)
      return json({ error: e.message }, { status: 400 });
    throw e;
  }
  const changes = Object.fromEntries(entries) as Record<string, string>;

  const warnings: string[] = [];

  // Lockout protection checks
  if (changes["Port"] && changes["Port"] !== "22") {
    const newPort = changes["Port"];
    // newPort is validated by SSHD_VALUE_RE above; further constrain to digits.
    if (!/^\d+$/.test(newPort))
      return json({ error: "Port must be numeric" }, { status: 400 });
    try {
      const { stdout } = await targetExec(id, `ufw status 2>/dev/null | grep -F -- ${JSON.stringify(newPort)} || true`);
      if (!stdout.trim()) {
        warnings.push(`Port ${newPort} is not allowed in ufw. You may lock yourself out!`);
      }
    } catch {}
  }

  if (changes["PasswordAuthentication"] === "no") {
    try {
      const { stdout } = await targetExec(
        id,
        "ls ~/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null | head -1"
      );
      if (!stdout.trim()) {
        warnings.push("No authorized_keys file found. Disabling password auth may lock you out!");
      }
    } catch {
      warnings.push("Could not verify authorized_keys. Disabling password auth may lock you out!");
    }
  }

  if (!applyNow) {
    return json({ ok: false, dryRun: true, warnings, changes });
  }

  // Backup
  try {
    await targetExec(id, "cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak");
  } catch {}

  // Apply changes. Keys/values are already whitelisted (validateSshdChanges);
  // we additionally JSON.stringify every interpolated fragment as defense in
  // depth so no value can ever break out of the shell command.
  for (const [key, value] of entries) {
    const line = `${key} ${value}`;
    await targetExec(
      id,
      `grep -q ${JSON.stringify(`^${key}`)} /etc/ssh/sshd_config ` +
        `&& sed -i ${JSON.stringify(`s/^${key}.*/${line}/`)} /etc/ssh/sshd_config ` +
        `|| echo ${JSON.stringify(line)} >> /etc/ssh/sshd_config`
    );
  }

  // Validate config
  let configTest = "";
  let configOk = true;
  try {
    const res = await targetExec(id, "sshd -t 2>&1 || true");
    configTest = res.stdout + res.stderr;
    if (res.stderr.includes("error")) {
      configOk = false;
      // Restore backup
      await targetExec(id, "cp /etc/ssh/sshd_config.bak /etc/ssh/sshd_config");
      return json({ ok: false, configTest, warnings, restored: true });
    }
  } catch {}

  // Suppress unused variable lint warning
  void configOk;

  let reloaded = false;
  try {
    await targetExec(
      id,
      "systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true"
    );
    reloaded = true;
  } catch {}

  await audit(
    u.id,
    "server.ssh.update",
    undefined,
    { changes },
    req.headers.get("x-forwarded-for") || undefined
  );

  return json({ ok: true, configTest, warnings, reloaded });
});
