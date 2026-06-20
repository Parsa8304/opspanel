import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { targetExec } from "@/lib/target";

export const dynamic = "force-dynamic";

// Shell-escape a hostname for safe interpolation into a single-quoted arg.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function checkSsl(
  serverId: string,
  hostname: string
): Promise<{ status: string; expiry: Date | null; issuer: string | null }> {
  const host = shQuote(hostname);
  // Connect from the target server's own network stack, fetch the leaf cert,
  // and print just the two lines we need. `timeout 8` bounds a hung TLS
  // handshake the same way the local check's 8000ms socket timeout did.
  const cmd =
    `timeout 8 openssl s_client -connect ${host}:443 -servername ${host} ` +
    `</dev/null 2>/dev/null | openssl x509 -noout -enddate -issuer 2>/dev/null`;

  let stdout = "";
  try {
    const res = await targetExec(serverId, cmd, 12000);
    stdout = res.stdout;
  } catch {
    return { status: "UNKNOWN", expiry: null, issuer: null };
  }

  if (!stdout.trim()) return { status: "INVALID", expiry: null, issuer: null };

  const enddateMatch = stdout.match(/notAfter=(.+)/);
  if (!enddateMatch) return { status: "INVALID", expiry: null, issuer: null };

  const expiry = new Date(enddateMatch[1].trim());
  if (isNaN(expiry.getTime())) return { status: "INVALID", expiry: null, issuer: null };

  const daysLeft = (expiry.getTime() - Date.now()) / 86400000;
  let status = "VALID";
  if (daysLeft < 0) status = "EXPIRED";
  else if (daysLeft < 14) status = "EXPIRING_SOON";

  // issuer= line looks like: issuer=C = US, O = Let's Encrypt, CN = R3
  const issuerMatch = stdout.match(/issuer=(.+)/);
  let issuer: string | null = null;
  if (issuerMatch) {
    const issuerLine = issuerMatch[1].trim();
    const oMatch = issuerLine.match(/O\s*=\s*([^,]+)/);
    const cnMatch = issuerLine.match(/CN\s*=\s*([^,]+)/);
    issuer = (oMatch?.[1] ?? cnMatch?.[1] ?? issuerLine).trim() || null;
  }

  return { status, expiry, issuer };
}

async function checkDns(serverId: string, hostname: string): Promise<{ status: string; ip: string | null }> {
  const host = shQuote(hostname);
  try {
    const { stdout } = await targetExec(serverId, `getent hosts ${host} 2>/dev/null`, 10000);
    const line = stdout.trim().split("\n")[0] ?? "";
    const ip = line.split(/\s+/)[0] || null;
    if (!ip) return { status: "UNREACHABLE", ip: null };
    return { status: "OK", ip };
  } catch {
    return { status: "UNREACHABLE", ip: null };
  }
}

export const POST = handler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string; domainId: string }> }) => {
    await requireRole(req, "ENGINEER");
    const { id, domainId } = await ctx.params;

    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain || domain.serverId !== id) return json({ error: "Domain not found" }, { status: 404 });

    const [ssl, dns_] = await Promise.all([
      checkSsl(id, domain.name).catch(() => ({ status: "UNKNOWN", expiry: null, issuer: null })),
      checkDns(id, domain.name).catch(() => ({ status: "UNKNOWN", ip: null })),
    ]);

    const updated = await prisma.domain.update({
      where: { id: domainId },
      data: {
        sslStatus: ssl.status as any,
        sslExpiry: ssl.expiry,
        sslIssuer: ssl.issuer,
        dnsStatus: dns_.status as any,
        dnsResolvesTo: dns_.ip,
        lastCheckedAt: new Date(),
      },
    });
    return json(updated);
  }
);
