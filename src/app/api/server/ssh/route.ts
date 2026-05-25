import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { hostExec, hostReadFile, parseConfigLines } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  let config: Record<string, string> = {};
  try {
    const raw = await hostReadFile("/etc/ssh/sshd_config");
    config = parseConfigLines(raw);
  } catch {}

  let lastLogins: string[] = [];
  try {
    const { stdout } = await hostExec("last -n 20 -F 2>/dev/null || last -n 20");
    lastLogins = stdout
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("wtmp"))
      .slice(0, 20);
  } catch {}

  let failedAttempts: string[] = [];
  try {
    const { stdout } = await hostExec(
      "journalctl -u ssh -u sshd --since '24 hours ago' --no-pager 2>/dev/null | grep -E 'Failed|Invalid|Accepted' | tail -30"
    );
    failedAttempts = stdout.split("\n").filter(Boolean).slice(0, 30);
  } catch {}

  const sshPort = parseInt(config["Port"] || "22", 10);
  const hasPublicKey = !!(config["AuthorizedKeysFile"]);

  return json({ config, lastLogins, failedAttempts, sshPort, hasPublicKey });
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const { changes, applyNow } = (await req.json()) as {
    changes: Record<string, string>;
    applyNow: boolean;
  };

  const warnings: string[] = [];

  // Lockout protection checks
  if (changes["Port"] && changes["Port"] !== "22") {
    const newPort = changes["Port"];
    try {
      const { stdout } = await hostExec(`ufw status 2>/dev/null | grep ${newPort} || true`);
      if (!stdout.trim()) {
        warnings.push(`Port ${newPort} is not allowed in ufw. You may lock yourself out!`);
      }
    } catch {}
  }

  if (changes["PasswordAuthentication"] === "no") {
    try {
      const { stdout } = await hostExec(
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
    await hostExec("cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak");
  } catch {}

  // Apply changes
  for (const [key, value] of Object.entries(changes)) {
    await hostExec(
      `grep -q "^${key}" /etc/ssh/sshd_config ` +
        `&& sed -i "s/^${key}.*/${key} ${value}/" /etc/ssh/sshd_config ` +
        `|| echo "${key} ${value}" >> /etc/ssh/sshd_config`
    );
  }

  // Validate config
  let configTest = "";
  let configOk = true;
  try {
    const res = await hostExec("sshd -t 2>&1 || true");
    configTest = res.stdout + res.stderr;
    if (res.stderr.includes("error")) {
      configOk = false;
      // Restore backup
      await hostExec("cp /etc/ssh/sshd_config.bak /etc/ssh/sshd_config");
      return json({ ok: false, configTest, warnings, restored: true });
    }
  } catch {}

  // Suppress unused variable lint warning
  void configOk;

  let reloaded = false;
  try {
    await hostExec(
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
