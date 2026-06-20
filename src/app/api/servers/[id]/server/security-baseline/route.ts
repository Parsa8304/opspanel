import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { targetExec } from "@/lib/target";

export const dynamic = "force-dynamic";

interface BaselineCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "unknown";
  detail: string;
}

async function checkFirewall(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(
      id,
      "ufw status 2>/dev/null || iptables -n -L INPUT 2>/dev/null | head -5",
      5000
    );
    const out = stdout.toLowerCase();
    const pass = out.includes("active") || out.includes("drop") || out.includes("reject");
    return {
      id: "firewall",
      label: "Firewall",
      status: pass ? "pass" : "fail",
      detail: pass ? "Firewall is active or has DROP/REJECT rules" : "No active firewall detected",
    };
  } catch {
    return { id: "firewall", label: "Firewall", status: "unknown", detail: "Could not determine firewall status" };
  }
}

async function checkRootSsh(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(id, "sshd -T 2>/dev/null | grep \"^permitrootlogin\"", 5000);
    const value = stdout.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
    if (value === "no" || value === "prohibit-password") {
      return { id: "root-ssh", label: "Root SSH Login", status: "pass", detail: `permitrootlogin = ${value}` };
    }
    if (value === "yes") {
      return { id: "root-ssh", label: "Root SSH Login", status: "fail", detail: "Root login via SSH is permitted" };
    }
    return { id: "root-ssh", label: "Root SSH Login", status: "unknown", detail: `permitrootlogin = ${value || "not set"}` };
  } catch {
    return { id: "root-ssh", label: "Root SSH Login", status: "unknown", detail: "Could not query sshd config" };
  }
}

async function checkDockerLogs(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(id, "cat /etc/docker/daemon.json 2>/dev/null || echo {}", 5000);
    const pass = stdout.includes("log-opts") && stdout.includes("max-size");
    return {
      id: "docker-logs",
      label: "Docker Log Limits",
      status: pass ? "pass" : "warn",
      detail: pass
        ? "Log rotation configured (log-opts with max-size)"
        : "No log-opts/max-size in daemon.json — logs may grow unbounded",
    };
  } catch {
    return { id: "docker-logs", label: "Docker Log Limits", status: "unknown", detail: "Could not read /etc/docker/daemon.json" };
  }
}

async function checkFail2ban(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(
      id,
      "systemctl is-active fail2ban 2>/dev/null || service fail2ban status 2>/dev/null | head -1",
      5000
    );
    const out = stdout.toLowerCase();
    const pass = out.includes("active") || out.includes("running");
    return {
      id: "fail2ban",
      label: "fail2ban",
      status: pass ? "pass" : "warn",
      detail: pass ? "fail2ban is active" : "fail2ban is not running",
    };
  } catch {
    return { id: "fail2ban", label: "fail2ban", status: "unknown", detail: "Could not determine fail2ban status" };
  }
}

async function checkSshPort(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(id, "sshd -T 2>/dev/null | grep \"^port \"", 5000);
    const portStr = stdout.trim().split(/\s+/)[1] ?? "22";
    const port = parseInt(portStr, 10);
    if (port === 22) {
      return { id: "ssh-port", label: "SSH Port", status: "warn", detail: "SSH is on default port 22" };
    }
    return { id: "ssh-port", label: "SSH Port", status: "pass", detail: `SSH is on non-default port ${port}` };
  } catch {
    return { id: "ssh-port", label: "SSH Port", status: "unknown", detail: "Could not determine SSH port" };
  }
}

async function checkDockerSocket(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(id, "stat -c \"%a\" /var/run/docker.sock 2>/dev/null", 5000);
    const perms = stdout.trim();
    if (perms === "777") {
      return { id: "docker-socket", label: "Docker Socket Permissions", status: "warn", detail: "docker.sock is world-writable (777)" };
    }
    return { id: "docker-socket", label: "Docker Socket Permissions", status: "pass", detail: `docker.sock permissions: ${perms}` };
  } catch {
    return { id: "docker-socket", label: "Docker Socket Permissions", status: "unknown", detail: "Could not stat /var/run/docker.sock" };
  }
}

async function checkPasswordAuth(id: string): Promise<BaselineCheck> {
  try {
    const { stdout } = await targetExec(id, "sshd -T 2>/dev/null | grep \"^passwordauthentication\"", 5000);
    const value = stdout.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
    if (value === "no") {
      return { id: "password-auth", label: "SSH Password Auth", status: "pass", detail: "Password authentication is disabled" };
    }
    if (value === "yes") {
      return { id: "password-auth", label: "SSH Password Auth", status: "warn", detail: "Password authentication is enabled" };
    }
    return { id: "password-auth", label: "SSH Password Auth", status: "unknown", detail: `passwordauthentication = ${value || "not set"}` };
  } catch {
    return { id: "password-auth", label: "SSH Password Auth", status: "unknown", detail: "Could not query sshd config" };
  }
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const checks = await Promise.all([
    checkFirewall(id),
    checkRootSsh(id),
    checkDockerLogs(id),
    checkFail2ban(id),
    checkSshPort(id),
    checkDockerSocket(id),
    checkPasswordAuth(id),
  ]);

  return json({ checks, checkedAt: new Date().toISOString() });
});
