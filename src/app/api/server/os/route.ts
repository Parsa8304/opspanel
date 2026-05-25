import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { hostExec, hostReadFile } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  const [osRelRes, kernelRes, uptimeRes, rebootRes, updatesRes, historyRes] =
    await Promise.allSettled([
      hostReadFile("/etc/os-release"),
      hostExec("uname -r 2>/dev/null"),
      hostExec("uptime -p 2>/dev/null"),
      hostExec("test -f /var/run/reboot-required && echo yes || echo no"),
      hostExec("apt list --upgradable 2>/dev/null | tail -n +2 | head -50"),
      hostExec("tail -50 /var/log/apt/history.log 2>/dev/null || echo ''"),
    ]);

  // Parse OS release
  let os = "Unknown";
  if (osRelRes.status === "fulfilled") {
    const name = osRelRes.value.match(/^NAME="?([^"\n]+)"?/m)?.[1] || "";
    const version = osRelRes.value.match(/^VERSION="?([^"\n]+)"?/m)?.[1] || "";
    os = `${name} ${version}`.trim();
  }

  const kernel =
    kernelRes.status === "fulfilled" ? kernelRes.value.stdout.trim() : "unknown";
  const uptime =
    uptimeRes.status === "fulfilled" ? uptimeRes.value.stdout.trim() : "";
  const rebootRequired =
    rebootRes.status === "fulfilled"
      ? rebootRes.value.stdout.trim() === "yes"
      : false;

  const updates = { security: 0, total: 0 };
  if (updatesRes.status === "fulfilled") {
    const lines = updatesRes.value.stdout.split("\n").filter(Boolean);
    updates.total = lines.length;
    updates.security = lines.filter((l) => l.includes("security")).length;
  }

  let updateHistory: string[] = [];
  if (historyRes.status === "fulfilled") {
    updateHistory = historyRes.value.stdout
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("Start-Date") ||
          l.startsWith("Commandline") ||
          l.startsWith("Install") ||
          l.startsWith("Upgrade")
      )
      .slice(-20);
  }

  const arch = (
    await hostExec("uname -m 2>/dev/null").catch(() => ({ stdout: "" }))
  ).stdout.trim();

  return json({ os, kernel, arch, uptime, rebootRequired, updates, updateHistory });
});
