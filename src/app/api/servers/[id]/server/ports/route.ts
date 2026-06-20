import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { targetExec } from "@/lib/target";

export const dynamic = "force-dynamic";

interface ListeningPort {
  proto: string;
  local: string;
  port: string;
  pid?: string;
  program?: string;
}

interface DockerPort {
  container: string;
  port: string;
  binding: string;
}

interface PortAuditEntry {
  port: string;
  proto: string;
  listening: boolean;
  dockerExposed: boolean;
  firewallAllowed: boolean;
  risk: "safe" | "warning" | "danger";
  note: string;
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  // Get listening ports
  const listening: ListeningPort[] = [];
  try {
    const { stdout } = await targetExec(id, "ss -tlnp 2>/dev/null; ss -ulnp 2>/dev/null");
    for (const line of stdout.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const proto = parts[0];
      const local = parts[3];
      const portMatch = local.match(/:(\d+)$/);
      if (!portMatch) continue;
      const pidInfo = parts[parts.length - 1];
      const pidMatch = pidInfo.match(/pid=(\d+)/);
      const progMatch = pidInfo.match(/"([^"]+)"/);
      listening.push({
        proto,
        local,
        port: portMatch[1],
        pid: pidMatch?.[1],
        program: progMatch?.[1],
      });
    }
  } catch {
    // ss not available — continue with empty array
  }

  // Get Docker exposed ports
  const dockerPorts: DockerPort[] = [];
  try {
    const { stdout } = await targetExec(
      id,
      "docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null"
    );
    for (const line of stdout.split("\n").filter(Boolean)) {
      const [container, portsRaw] = line.split("\t");
      if (!portsRaw) continue;
      for (const p of portsRaw.split(", ")) {
        const m = p.match(/(\d+\.\d+\.\d+\.\d+):(\d+)->(\d+\/(tcp|udp))/);
        if (m) {
          dockerPorts.push({
            container: container.trim(),
            port: m[3].split("/")[0],
            binding: `${m[1]}:${m[2]}`,
          });
        }
      }
    }
  } catch {
    // docker not available — continue with empty array
  }

  // Get ufw allowed ports
  const ufwRules: string[] = [];
  try {
    const { stdout } = await targetExec(id, "ufw status 2>/dev/null || true");
    for (const line of stdout.split("\n")) {
      const m = line.match(/^(\d+(?:\/(?:tcp|udp))?)\s+ALLOW/i);
      if (m) ufwRules.push(m[1].split("/")[0]);
    }
  } catch {
    // ufw not available — continue with empty array
  }

  // Build audit entries
  const allPortsSet = new Set([
    ...listening.map((l) => l.port),
    ...dockerPorts.map((d) => d.port),
    ...ufwRules,
  ]);
  const allPorts = Array.from(allPortsSet);

  const auditEntries: PortAuditEntry[] = [];
  for (const port of allPorts) {
    const isListening = listening.some((l) => l.port === port);
    const isDocker = dockerPorts.some((d) => d.port === port);
    const isFirewall = ufwRules.includes(port);

    let risk: "safe" | "warning" | "danger" = "safe";
    let note = "";

    if (isListening && !isFirewall && !isDocker) {
      risk = "danger";
      note = "Port is listening but not in firewall — may be accidentally exposed";
    } else if (isFirewall && !isListening && !isDocker) {
      risk = "warning";
      note = "Firewall rule exists but nothing is listening — stale rule";
    } else if (isDocker && !isFirewall) {
      risk = "warning";
      note = "Docker exposes this port but no firewall rule exists";
    } else {
      risk = "safe";
      note = "Properly configured";
    }

    const program = listening.find((l) => l.port === port);
    const dockerContainer = dockerPorts.find((d) => d.port === port);
    if (program?.program) note += ` (${program.program})`;
    if (dockerContainer) note += ` [${dockerContainer.container}]`;

    auditEntries.push({
      port,
      proto: program?.proto || "tcp",
      listening: isListening,
      dockerExposed: isDocker,
      firewallAllowed: isFirewall,
      risk,
      note,
    });
  }

  // Sort by risk: danger first
  auditEntries.sort((a, b) => {
    const order = { danger: 0, warning: 1, safe: 2 };
    return order[a.risk] - order[b.risk];
  });

  return json({ listening, dockerPorts, ufwRules, audit: auditEntries });
});
