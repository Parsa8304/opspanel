import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { hostExec } from "@/lib/server";

export const dynamic = "force-dynamic";

const KNOWN_SERVICES = [
  { name: "docker", displayName: "Docker" },
  { name: "nginx", displayName: "Nginx" },
  { name: "ssh", displayName: "SSH" },
  { name: "fail2ban", displayName: "Fail2ban" },
  { name: "cron", displayName: "Cron" },
  { name: "postgresql", displayName: "PostgreSQL" },
  { name: "redis-server", displayName: "Redis" },
];

const ALLOWED_SERVICES = new Set(KNOWN_SERVICES.map((s) => s.name).concat(["sshd"]));
const ALLOWED_ACTIONS = new Set(["start", "stop", "restart", "enable", "disable", "reload"]);

async function getServiceStatus(name: string) {
  try {
    const { stdout } = await hostExec(
      `systemctl show ${name} --no-pager --property=ActiveState,SubState,LoadState,MainPID,ActiveEnterTimestamp 2>/dev/null`
    );
    const props: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const k = line.slice(0, eqIdx);
        const v = line.slice(eqIdx + 1);
        props[k] = v;
      }
    }
    return {
      active: props["ActiveState"] === "active",
      enabled: props["LoadState"] !== "not-found",
      since: props["ActiveEnterTimestamp"] || undefined,
      pid: props["MainPID"] && props["MainPID"] !== "0" ? props["MainPID"] : undefined,
      subState: props["SubState"],
    };
  } catch {
    return { active: false, enabled: false };
  }
}

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  const statuses = await Promise.all(
    KNOWN_SERVICES.map(async (svc) => {
      const status = await getServiceStatus(svc.name);
      return { name: svc.name, displayName: svc.displayName, ...status };
    })
  );

  return json({ services: statuses });
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const { service, action } = (await req.json()) as { service: string; action: string };

  if (!ALLOWED_SERVICES.has(service)) {
    return json({ ok: false, error: "Service not in whitelist" }, { status: 400 });
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return json({ ok: false, error: "Action not allowed" }, { status: 400 });
  }

  const { stdout, stderr } = await hostExec(`systemctl ${action} ${service} 2>&1 || true`);
  await audit(
    u.id,
    `server.service.${action}`,
    service,
    undefined,
    req.headers.get("x-forwarded-for") || undefined
  );

  return json({ ok: true, output: (stdout + stderr).trim() });
});
