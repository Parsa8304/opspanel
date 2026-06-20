import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { targetExec } from "@/lib/target";

export const dynamic = "force-dynamic";

function parseKV(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

function parseDriftMs(output: string): number | null {
  // timedatectl timesync-status format: "Offset: +123ms" or "Offset: +1.234s"
  const offsetMatch = output.match(/Offset:\s*([+-]?\d+(?:\.\d+)?)(ms|s|us)/);
  if (offsetMatch) {
    const val = parseFloat(offsetMatch[1]);
    const unit = offsetMatch[2];
    if (unit === "ms") return Math.abs(val);
    if (unit === "s") return Math.abs(val * 1000);
    if (unit === "us") return Math.abs(val / 1000);
  }
  // chronyc tracking format: "System time     :   0.000123456 seconds slow"
  const chronyMatch = output.match(/System time\s*:\s*([+-]?\d+\.\d+)\s*seconds/);
  if (chronyMatch) return Math.abs(parseFloat(chronyMatch[1]) * 1000);
  return null;
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const [tdRes, syncRes, confRes] = await Promise.allSettled([
    targetExec(id, "timedatectl show --no-pager 2>/dev/null"),
    targetExec(
      id,
      "timedatectl timesync-status --no-pager 2>/dev/null || chronyc tracking 2>/dev/null || ntpstat 2>/dev/null || true"
    ),
    targetExec(
      id,
      "cat /etc/systemd/timesyncd.conf 2>/dev/null || cat /etc/ntp.conf 2>/dev/null || echo ''"
    ),
  ]);

  const kv =
    tdRes.status === "fulfilled" ? parseKV(tdRes.value.stdout) : {};

  const timezone = kv["Timezone"] || "UTC";
  const ntpSync =
    kv["NTPSynchronized"] === "yes" || kv["NTP"] === "yes";

  // Determine NTP service
  let ntpService = "none";
  try {
    const { stdout } = await targetExec(
      id,
      "systemctl is-active systemd-timesyncd 2>/dev/null || true"
    );
    if (stdout.trim() === "active") {
      ntpService = "systemd-timesyncd";
    } else {
      const { stdout: c } = await targetExec(
        id,
        "systemctl is-active chronyd 2>/dev/null || true"
      );
      if (c.trim() === "active") {
        ntpService = "chrony";
      } else {
        const { stdout: n } = await targetExec(
          id,
          "systemctl is-active ntp 2>/dev/null || true"
        );
        if (n.trim() === "active") ntpService = "ntp";
      }
    }
  } catch {
    // ignore
  }

  // Parse NTP servers from config
  const ntpServers: string[] = [];
  if (confRes.status === "fulfilled") {
    const raw = confRes.value.stdout;
    for (const line of raw.split("\n")) {
      const m = line.match(/^(?:NTP|server)\s*=?\s*(.+)/i);
      if (m) ntpServers.push(...m[1].trim().split(/\s+/).filter(Boolean));
    }
  }

  const syncOutput =
    syncRes.status === "fulfilled" ? syncRes.value.stdout : "";
  const clockDrift = parseDriftMs(syncOutput);
  const driftWarning = clockDrift !== null && clockDrift > 500;

  const now = new Date();

  return json({
    timezone,
    localTime: now.toISOString(),
    utcTime: now.toUTCString(),
    ntpSync,
    ntpService,
    ntpServers,
    clockDrift,
    driftWarning,
  });
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;
  const { action, timezone, server } = (await req.json()) as {
    action: string;
    timezone?: string;
    server?: string;
  };

  switch (action) {
    case "set-timezone": {
      if (!timezone)
        return json({ ok: false, error: "timezone required" }, { status: 400 });
      // Validate timezone
      const { stdout: tzList } = await targetExec(
        id,
        "timedatectl list-timezones 2>/dev/null"
      );
      if (!tzList.split("\n").map((s) => s.trim()).includes(timezone.trim())) {
        return json({ ok: false, error: "Invalid timezone" }, { status: 400 });
      }
      await targetExec(id, `timedatectl set-timezone ${timezone}`);
      await audit(
        u.id,
        "server.time.set-timezone",
        timezone,
        undefined,
        req.headers.get("x-forwarded-for") || undefined
      );
      return json({ ok: true });
    }
    case "enable-ntp":
      await targetExec(id, "timedatectl set-ntp true");
      await audit(
        u.id,
        "server.time.enable-ntp",
        undefined,
        undefined,
        req.headers.get("x-forwarded-for") || undefined
      );
      return json({ ok: true });
    case "disable-ntp":
      await targetExec(id, "timedatectl set-ntp false");
      await audit(
        u.id,
        "server.time.disable-ntp",
        undefined,
        undefined,
        req.headers.get("x-forwarded-for") || undefined
      );
      return json({ ok: true });
    case "set-ntp-server": {
      if (!server)
        return json({ ok: false, error: "server required" }, { status: 400 });
      // Validate server name (no injection)
      if (!/^[a-zA-Z0-9.\-]+$/.test(server))
        return json({ ok: false, error: "Invalid server" }, { status: 400 });
      await targetExec(
        id,
        `grep -q "^NTP=" /etc/systemd/timesyncd.conf ` +
          `&& sed -i "s/^NTP=.*/NTP=${server}/" /etc/systemd/timesyncd.conf ` +
          `|| echo "NTP=${server}" >> /etc/systemd/timesyncd.conf`
      );
      await targetExec(id, "systemctl restart systemd-timesyncd 2>/dev/null || true");
      await audit(
        u.id,
        "server.time.set-ntp-server",
        server,
        undefined,
        req.headers.get("x-forwarded-for") || undefined
      );
      return json({ ok: true });
    }
    default:
      return json({ ok: false, error: "Unknown action" }, { status: 400 });
  }
});
