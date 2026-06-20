import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { targetExec } from "@/lib/target";

export const dynamic = "force-dynamic";

interface FirewallRule {
  number: string;
  to: string;
  action: string;
  from: string;
  comment?: string;
}

function parseUfwStatus(output: string): {
  active: boolean;
  defaultIncoming: string;
  defaultOutgoing: string;
  rules: FirewallRule[];
} {
  const lines = output.split("\n");
  const active = lines.some((l) => l.includes("Status: active"));

  let defaultIncoming = "deny";
  let defaultOutgoing = "allow";
  for (const line of lines) {
    const inMatch = line.match(/Default:\s+(\w+)\s+\(incoming\)/);
    if (inMatch) defaultIncoming = inMatch[1];
    const outMatch = line.match(/Default:\s+(\w+)\s+\(outgoing\)/);
    if (outMatch) defaultOutgoing = outMatch[1];
  }

  const rules: FirewallRule[] = [];
  for (const line of lines) {
    // Match: [ 1] 22/tcp  ALLOW IN  Anywhere
    const m = line.match(
      /^\[\s*(\d+)\]\s+(\S+)\s+(ALLOW|DENY|REJECT|LIMIT)\s*(IN|OUT|FWD)?\s+(.*)/i
    );
    if (m) {
      rules.push({
        number: m[1],
        to: m[2].trim(),
        action: (m[3] + (m[4] ? " " + m[4] : "")).trim(),
        from: m[5].trim(),
      });
    }
  }

  return { active, defaultIncoming, defaultOutgoing, rules };
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  try {
    const { stdout } = await targetExec(
      id,
      "ufw status numbered 2>&1 || echo 'Status: inactive'"
    );
    return json(parseUfwStatus(stdout));
  } catch {
    return json({
      active: false,
      defaultIncoming: "deny",
      defaultOutgoing: "allow",
      rules: [],
      error: "ufw not available",
    });
  }
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const u = await requireRole(req, "ADMIN");
  const { id } = await ctx.params;
  const body = await req.json();
  const { action, port, protocol, from, ip, ruleNumber, comment } = body;

  let cmd = "";
  switch (action) {
    case "add": {
      const proto = protocol && protocol !== "any" ? `/${protocol}` : "";
      const fromClause =
        from && from !== "Anywhere" ? ` from ${from}` : "";
      const commentClause = comment
        ? ` comment '${comment.replace(/'/g, "")}'`
        : "";
      if (port) {
        cmd = `ufw allow${fromClause} to any port ${port}${proto}${commentClause}`;
      } else {
        return json(
          { ok: false, error: "Port required for add action" },
          { status: 400 }
        );
      }
      break;
    }
    case "delete":
      cmd = `ufw --force delete ${ruleNumber}`;
      break;
    case "allow-http":
      cmd = "ufw allow 80/tcp";
      break;
    case "allow-https":
      cmd = "ufw allow 443/tcp";
      break;
    case "allow-ssh":
      cmd = "ufw allow 22/tcp";
      break;
    case "allow-ip":
      cmd = `ufw allow from ${ip}`;
      break;
    case "deny-ip":
      cmd = `ufw deny from ${ip}`;
      break;
    case "reset":
      cmd = "ufw --force reset && ufw --force enable";
      break;
    default:
      return json({ ok: false, error: "Unknown action" }, { status: 400 });
  }

  const { stdout } = await targetExec(id, cmd);
  await audit(
    u.id,
    `server.firewall.${action}`,
    port || ip || ruleNumber,
    body,
    req.headers.get("x-forwarded-for") || undefined
  );

  return json({ ok: true, output: stdout });
});
