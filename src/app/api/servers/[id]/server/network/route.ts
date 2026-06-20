import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { targetExec, targetReadFile } from "@/lib/target";

export const dynamic = "force-dynamic";

function parseInterfaces(
  ipAddrOutput: string
): { name: string; state: string; mac: string; ips: { ip: string; cidr: string }[] }[] {
  const interfaces: { name: string; state: string; mac: string; ips: { ip: string; cidr: string }[] }[] = [];
  let current: (typeof interfaces)[0] | null = null;

  for (const line of ipAddrOutput.split("\n")) {
    const ifaceMatch = line.match(/^\d+:\s+(\S+):.+state\s+(\S+)/);
    if (ifaceMatch) {
      if (current) interfaces.push(current);
      current = {
        name: ifaceMatch[1].replace(":", ""),
        state: ifaceMatch[2],
        mac: "",
        ips: [],
      };
    } else if (current) {
      const macMatch = line.match(/link\/ether\s+(\S+)/);
      if (macMatch) current.mac = macMatch[1];
      const ipMatch = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
      if (ipMatch) current.ips.push({ ip: ipMatch[1], cidr: ipMatch[2] });
    }
  }
  if (current) interfaces.push(current);
  return interfaces;
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const [publicIpRes, ipAddrRes, routeRes, resolvRes, hostnameRes] = await Promise.allSettled([
    targetExec(
      id,
      "curl -s --max-time 5 https://api.ipify.org 2>/dev/null || curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo ''"
    ),
    targetExec(id, "ip addr show 2>/dev/null"),
    targetExec(id, "ip route 2>/dev/null"),
    targetReadFile(id, "/etc/resolv.conf"),
    targetExec(id, "hostname 2>/dev/null"),
  ]);

  const publicIp =
    publicIpRes.status === "fulfilled" ? publicIpRes.value.stdout.trim() || null : null;
  const interfaces =
    ipAddrRes.status === "fulfilled" ? parseInterfaces(ipAddrRes.value.stdout) : [];

  let gateway: string | null = null;
  if (routeRes.status === "fulfilled") {
    const m = routeRes.value.stdout.match(/default via (\S+)/);
    if (m) gateway = m[1];
  }

  const dns: string[] = [];
  if (resolvRes.status === "fulfilled") {
    for (const line of resolvRes.value.split("\n")) {
      const m = line.match(/^nameserver\s+(\S+)/);
      if (m) dns.push(m[1]);
    }
  }

  const hostname =
    hostnameRes.status === "fulfilled" ? hostnameRes.value.stdout.trim() : "";

  const privateIps = interfaces
    .flatMap((i) => i.ips.map((ip) => ({ iface: i.name, ip: ip.ip, cidr: ip.cidr })))
    .filter((e) => !e.ip.startsWith("127."));

  return json({ publicIp, privateIps, gateway, dns, interfaces, hostname });
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;
  const { tool, target } = (await req.json()) as { tool: string; target: string };

  // Validate target to prevent injection
  if (!/^[a-zA-Z0-9.\-:/\[\]_]+$/.test(target)) {
    return json({ ok: false, error: "Invalid target" }, { status: 400 });
  }

  const commands: Record<string, string> = {
    ping: `ping -c 4 -W 3 ${target}`,
    curl: `curl -s -I --max-time 10 ${target}`,
    traceroute: `traceroute -m 15 -w 2 ${target} 2>&1 || tracepath ${target} 2>&1`,
    dig: `dig ${target} +short 2>/dev/null || host ${target} 2>/dev/null`,
    nslookup: `nslookup ${target} 2>/dev/null`,
  };

  const cmd = commands[tool];
  if (!cmd) return json({ ok: false, error: "Unknown tool" }, { status: 400 });

  const start = Date.now();
  try {
    const { stdout, stderr } = await targetExec(id, cmd, 30000);
    return json({ ok: true, output: (stdout + stderr).trim(), duration: Date.now() - start });
  } catch (e: any) {
    return json({
      ok: false,
      output: e.message || "Command failed",
      duration: Date.now() - start,
    });
  }
});
