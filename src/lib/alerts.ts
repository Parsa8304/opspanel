import type { Readable } from "stream";
import { prisma } from "./prisma";
import { docker, listContainers } from "./docker";
import { decryptSecret } from "./crypto";
import { getSetting } from "./api";

/**
 * Section 13 — Telegram Alerting & Log-Based Error Detection.
 *
 * HONESTY: AlertEvents only come from real matched conditions on real
 * data/logs. Telegram delivery status is the REAL result of a REAL HTTP
 * call. If Telegram is unreachable we queue (status "queued") and retry on
 * recovery — never mark delivered without a real 2xx.
 */

export type Severity = "INFO" | "WARN" | "ERROR" | "CRITICAL";
const SEV_RANK: Record<Severity, number> = {
  INFO: 0,
  WARN: 1,
  ERROR: 2,
  CRITICAL: 3,
};
const SEV_EMOJI: Record<Severity, string> = {
  INFO: "ℹ️",
  WARN: "⚠️",
  ERROR: "❌",
  CRITICAL: "🔥",
};

export interface AlertsConfig {
  ingestLogs: boolean;
  defaultChatRouting?: string | null;
  panelBaseUrl?: string;
}
const CONFIG_DEFAULT: AlertsConfig = {
  ingestLogs: false,
  defaultChatRouting: null,
  panelBaseUrl: "",
};

export async function getAlertsConfig(): Promise<AlertsConfig> {
  return {
    ...CONFIG_DEFAULT,
    ...(await getSetting<Partial<AlertsConfig>>("alerts", {})),
  };
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

export interface RuleSeed {
  name: string;
  source: string;
  pattern: string;
  severity: Severity;
  cooldownSec: number;
}

/** Built-in toggleable rules (builtin=true). Pattern is a JS regex source. */
export const DEFAULT_RULES: RuleSeed[] = [
  { name: "CRITICAL keyword", source: "container_logs", pattern: "\\bCRITICAL\\b|\\bFATAL\\b", severity: "CRITICAL", cooldownSec: 300 },
  { name: "ERROR keyword", source: "container_logs", pattern: "\\bERROR\\b", severity: "ERROR", cooldownSec: 300 },
  { name: "Unhandled Exception", source: "container_logs", pattern: "\\bException\\b", severity: "ERROR", cooldownSec: 300 },
  { name: "Python Traceback", source: "container_logs", pattern: "Traceback \\(most recent call last\\)", severity: "ERROR", cooldownSec: 300 },
  { name: "Out of memory / OOM", source: "container_logs", pattern: "OutOfMemory|OOMKilled|\\bOOM\\b|Cannot allocate memory|MemoryError", severity: "CRITICAL", cooldownSec: 300 },
  { name: "HTTP 5xx", source: "container_logs", pattern: "\\\"?\\s5\\d{2}\\s|\\bHTTP\\/[0-9.]+\\\"?\\s5\\d{2}\\b|status(?:_code)?[=:\\s]+5\\d{2}\\b", severity: "ERROR", cooldownSec: 300 },
  { name: "Connection refused", source: "container_logs", pattern: "connection refused|ECONNREFUSED", severity: "ERROR", cooldownSec: 300 },
  { name: "Timeout", source: "container_logs", pattern: "\\btimed? out\\b|ETIMEDOUT|TimeoutError", severity: "WARN", cooldownSec: 300 },
  { name: "Permission denied", source: "container_logs", pattern: "permission denied|EACCES|EPERM", severity: "ERROR", cooldownSec: 300 },
];

/** Idempotent: ensure every built-in rule exists exactly once. */
export async function ensureBuiltinRules(): Promise<{ created: number; total: number }> {
  let created = 0;
  for (const seed of DEFAULT_RULES) {
    const existing = await prisma.alertRule.findFirst({
      where: { builtin: true, name: seed.name },
    });
    if (!existing) {
      await prisma.alertRule.create({
        data: {
          name: seed.name,
          source: seed.source,
          pattern: seed.pattern,
          severity: seed.severity,
          cooldownSec: seed.cooldownSec,
          enabled: true,
          builtin: true,
        },
      });
      created++;
    }
  }
  const total = await prisma.alertRule.count({ where: { builtin: true } });
  return { created, total };
}

// ---------------------------------------------------------------------------
// Log-format parsers — best-effort pure functions
// ---------------------------------------------------------------------------

export interface ParsedLine {
  ts?: string;
  level?: string;
  message: string;
  format?: string;
}

const DJANGO_RE =
  /^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]?\d*)\]?\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\b[:\s]*(.*)$/;
const CELERY_RE =
  /^\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}[.,]?\d*):?\s*(DEBUG|INFO|WARNING|ERROR|CRITICAL)\/[^\]]*\]\s*(.*)$/;
const NGINX_ERROR_RE =
  /^(\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}:\d{2})\s\[(emerg|alert|crit|error|warn|notice|info)\]\s(.*)$/;
const NGINX_ACCESS_RE =
  /^\S+\s\S+\s\S+\s\[([^\]]+)\]\s"[A-Z]+[^"]*"\s(\d{3})\s\d+/;
const POSTGRES_RE =
  /^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}(?:\.\d+)?\s?\S*)\s*\[\d+\]\s*(LOG|ERROR|FATAL|PANIC|WARNING|STATEMENT|DETAIL|HINT):\s*(.*)$/;
const REDIS_RE =
  /^\d+:[MSCX]\s+(\d{2}\s\w{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\.\d+)\s+([*#\-.])\s+(.*)$/;
const NEXT_RE = /^(error|warn|info|ready|event|wait)\s+-\s+(.*)$/i;
const ISO_LEVEL_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL|FATAL)\b[:\s]*(.*)$/i;

const REDIS_LEVEL: Record<string, string> = {
  ".": "DEBUG",
  "-": "INFO",
  "*": "INFO",
  "#": "WARNING",
};

/** Parse a single log line into {ts?, level?, message} with a format hint. */
export function parseLogLine(raw: string): ParsedLine {
  // Docker timestamps prefix (RFC3339Nano + space) — strip if present.
  let line = raw.replace(/\r$/, "");
  const dockerTs = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/);
  let outerTs: string | undefined;
  if (dockerTs) {
    outerTs = dockerTs[1];
    line = dockerTs[2];
  }

  let m: RegExpMatchArray | null;
  if ((m = line.match(CELERY_RE)))
    return { ts: m[1], level: m[2], message: m[3], format: "celery" };
  if ((m = line.match(DJANGO_RE)))
    return { ts: m[1], level: m[2], message: m[3], format: "django" };
  if ((m = line.match(NGINX_ERROR_RE)))
    return { ts: m[1], level: m[2].toUpperCase(), message: m[3], format: "nginx-error" };
  if ((m = line.match(NGINX_ACCESS_RE))) {
    const code = parseInt(m[2], 10);
    return {
      ts: m[1],
      level: code >= 500 ? "ERROR" : code >= 400 ? "WARNING" : "INFO",
      message: line,
      format: "nginx-access",
    };
  }
  if ((m = line.match(POSTGRES_RE)))
    return { ts: m[1], level: m[2], message: m[3], format: "postgres" };
  if ((m = line.match(REDIS_RE)))
    return {
      ts: m[1],
      level: REDIS_LEVEL[m[2]] ?? "INFO",
      message: m[3],
      format: "redis",
    };
  if ((m = line.match(ISO_LEVEL_RE)))
    return { ts: m[1], level: m[2].toUpperCase(), message: m[3], format: "iso" };
  if ((m = line.match(NEXT_RE)))
    return { level: m[1].toUpperCase(), message: m[2], format: "next", ts: outerTs };

  return { message: line, ts: outerTs, format: outerTs ? "docker" : "raw" };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface RuleLike {
  pattern: string | null;
  source?: string;
}

export interface MatchResult {
  matched: boolean;
  excerpt: string;
}

/** True + extracted excerpt if the rule's regex matches the line. */
export function matchLine(
  rule: RuleLike,
  line: string,
  parsed?: ParsedLine
): MatchResult {
  if (!rule.pattern) return { matched: false, excerpt: "" };
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern, "i");
  } catch {
    return { matched: false, excerpt: "" };
  }
  const hay = parsed?.message && parsed.message.length > 0 ? parsed.message : line;
  const m = hay.match(re) || line.match(re);
  if (!m) return { matched: false, excerpt: "" };
  const trimmed = line.trim();
  const excerpt =
    trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
  return { matched: true, excerpt };
}

// ---------------------------------------------------------------------------
// Raising alerts (cooldown + suppression accounting)
// ---------------------------------------------------------------------------

export interface RaiseInput {
  ruleId?: string;
  source: string;
  severity: Severity;
  title: string;
  payload?: Record<string, unknown>;
  containerName?: string;
}

export interface RaiseResult {
  suppressed: boolean;
  eventId: string;
  deliveriesEnqueued: number;
}

/**
 * Apply cooldown per (rule + containerName). Within cooldown → increment
 * suppressedCount on the most recent matching open/snoozed event (real
 * suppression accounting). Otherwise create a new AlertEvent, advance
 * rule.lastFiredAt, and enqueue deliveries to eligible enabled channels.
 */
export async function raiseAlert(input: RaiseInput): Promise<RaiseResult> {
  const rule = input.ruleId
    ? await prisma.alertRule.findUnique({ where: { id: input.ruleId } })
    : null;

  const containerName = input.containerName ?? null;
  const cooldownSec = rule?.cooldownSec ?? 0;

  if (rule && cooldownSec > 0 && rule.lastFiredAt) {
    const elapsed = Date.now() - new Date(rule.lastFiredAt).getTime();
    if (elapsed < cooldownSec * 1000) {
      // Suppress: bump the most recent event for this rule+container.
      const recent = await prisma.alertEvent.findFirst({
        where: {
          ruleId: rule.id,
          ...(containerName
            ? { payload: { path: ["containerName"], equals: containerName } }
            : {}),
        },
        orderBy: { createdAt: "desc" },
      });
      if (recent) {
        await prisma.alertEvent.update({
          where: { id: recent.id },
          data: { suppressedCount: { increment: 1 } },
        });
        return {
          suppressed: true,
          eventId: recent.id,
          deliveriesEnqueued: 0,
        };
      }
      // No prior event to attach to — fall through and create one.
    }
  }

  const payload = {
    ...(input.payload ?? {}),
    ...(containerName ? { containerName } : {}),
  };

  const event = await prisma.alertEvent.create({
    data: {
      ruleId: rule?.id,
      severity: input.severity,
      source: input.source,
      title: input.title,
      payload: Object.keys(payload).length ? payload : undefined,
    },
  });

  if (rule) {
    await prisma.alertRule.update({
      where: { id: rule.id },
      data: { lastFiredAt: new Date() },
    });
  }

  // Enqueue deliveries to enabled channels whose minSeverity <= severity.
  const channels = await prisma.alertChannel.findMany({
    where: { enabled: true },
  });
  let enqueued = 0;
  for (const ch of channels) {
    if (SEV_RANK[ch.minSeverity as Severity] > SEV_RANK[input.severity]) continue;
    const del = await prisma.alertDelivery.create({
      data: { eventId: event.id, channelId: ch.id, status: "pending" },
    });
    enqueued++;
    // Best-effort immediate delivery; failures become "queued".
    await deliver(del.id).catch(() => {});
  }

  return { suppressed: false, eventId: event.id, deliveriesEnqueued: enqueued };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface ChannelConfig {
  botToken?: string;
  chatId?: string | number;
  baseUrl?: string;
  url?: string;
}

function readChannelConfig(configEnc: string): ChannelConfig {
  const raw = decryptSecret(configEnc);
  return JSON.parse(raw) as ChannelConfig;
}

function deepLink(panelBaseUrl: string, eventId: string): string {
  const base = (panelBaseUrl || "").replace(/\/+$/, "");
  return base
    ? `${base}/alerts?event=${eventId}`
    : `/alerts?event=${eventId}`;
}

function formatTelegramText(args: {
  severity: Severity;
  source: string;
  service: string | null;
  title: string;
  line: string;
  ts: string;
  link: string;
}): string {
  const { severity, source, service, title, line, ts, link } = args;
  const lines = [
    `${SEV_EMOJI[severity]} *${severity}* — ${escapeMd(title)}`,
    `Source: \`${escapeMd(source)}\`${service ? ` · Service: \`${escapeMd(service)}\`` : ""}`,
    `Time: ${escapeMd(ts)}`,
    "",
    "```",
    line.slice(0, 600),
    "```",
    `[Open in panel](${link})`,
  ];
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return String(s).replace(/[_*`\[\]]/g, "\\$&");
}

/**
 * Deliver one AlertDelivery. Real network call. On real 2xx →
 * delivered+deliveredAt. On any failure/unreachable → queued + lastError
 * (retry later). NEVER marks delivered without a real 2xx.
 */
export async function deliver(deliveryId: string): Promise<{ status: string }> {
  const del = await prisma.alertDelivery.findUnique({
    where: { id: deliveryId },
    include: { channel: true, event: true },
  });
  if (!del) return { status: "missing" };
  if (del.status === "delivered") return { status: "delivered" };

  const ch = del.channel;
  const ev = del.event;
  const cfg = await getAlertsConfig();
  const panelBase = cfg.panelBaseUrl || "";
  const payload = (ev.payload as Record<string, unknown> | null) || {};
  const service = (payload.containerName as string) || null;
  const triggerLine =
    (payload.line as string) || (payload.excerpt as string) || ev.title;

  const fail = async (msg: string) => {
    await prisma.alertDelivery.update({
      where: { id: del.id },
      data: {
        status: "queued",
        attempts: { increment: 1 },
        lastError: msg.slice(0, 1000),
      },
    });
    return { status: "queued" };
  };

  try {
    if (ch.type === "telegram") {
      const conf = readChannelConfig(ch.configEnc);
      if (!conf.botToken || !conf.chatId)
        return fail("Telegram channel missing botToken/chatId");
      const base = (conf.baseUrl || "https://api.telegram.org").replace(/\/+$/, "");
      const link = deepLink(panelBase, ev.id);
      const text = formatTelegramText({
        severity: ev.severity as Severity,
        source: ev.source,
        service,
        title: ev.title,
        line: triggerLine,
        ts: new Date(ev.createdAt).toISOString(),
        link,
      });
      const body = {
        chat_id: conf.chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Acknowledge", callback_data: `ack:${ev.id}` },
              { text: "😴 Snooze 1h", callback_data: `snooze:${ev.id}:1` },
            ],
            [{ text: "🔗 Open in panel", url: link }],
          ],
        },
      };
      const res = await fetch(`${base}/bot${conf.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return fail(`Telegram HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const jr = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (jr.ok !== true) return fail(`Telegram responded ok=false`);
      await prisma.alertDelivery.update({
        where: { id: del.id },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      return { status: "delivered" };
    }

    if (ch.type === "webhook") {
      const conf = readChannelConfig(ch.configEnc);
      if (!conf.url) return fail("Webhook channel missing url");
      const res = await fetch(conf.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: ev.id,
          severity: ev.severity,
          source: ev.source,
          title: ev.title,
          payload: ev.payload,
          createdAt: ev.createdAt,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return fail(`Webhook HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      await prisma.alertDelivery.update({
        where: { id: del.id },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      return { status: "delivered" };
    }

    if (ch.type === "email") {
      // Honest: SMTP is not configured/implemented. Do not fake success.
      return fail("Email/SMTP delivery is not configured (unsupported)");
    }

    return fail(`Unknown channel type: ${ch.type}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Delivery error");
  }
}

/** Retry all queued deliveries. Returns real counts. */
export async function flushQueued(): Promise<{
  attempted: number;
  delivered: number;
  stillQueued: number;
}> {
  const queued = await prisma.alertDelivery.findMany({
    where: { status: "queued" },
  });
  let delivered = 0;
  let stillQueued = 0;
  for (const d of queued) {
    const r = await deliver(d.id).catch(() => ({ status: "queued" }));
    if (r.status === "delivered") delivered++;
    else stillQueued++;
  }
  return { attempted: queued.length, delivered, stillQueued };
}

export async function deliveryHealth(): Promise<{
  queued: number;
  failed: number;
  delivered: number;
  pending: number;
  delayed: boolean;
}> {
  const [queued, failed, delivered, pending] = await Promise.all([
    prisma.alertDelivery.count({ where: { status: "queued" } }),
    prisma.alertDelivery.count({ where: { status: "failed" } }),
    prisma.alertDelivery.count({ where: { status: "delivered" } }),
    prisma.alertDelivery.count({ where: { status: "pending" } }),
  ]);
  return { queued, failed, delivered, pending, delayed: queued > 0 };
}

// ---------------------------------------------------------------------------
// Telegram callback (inline buttons)
// ---------------------------------------------------------------------------

/**
 * Handle a Telegram callback_query update. Honest no-op when the event or
 * action is unknown. Returns whether an action was applied.
 */
export async function handleTelegramCallback(update: any): Promise<{
  handled: boolean;
  action?: string;
  eventId?: string;
}> {
  const data: string | undefined = update?.callback_query?.data;
  if (!data || typeof data !== "string") return { handled: false };
  const [action, eventId, arg] = data.split(":");
  if (!eventId) return { handled: false };
  const ev = await prisma.alertEvent.findUnique({ where: { id: eventId } });
  if (!ev) return { handled: false };

  if (action === "ack") {
    await prisma.alertEvent.update({
      where: { id: eventId },
      data: { ackStatus: "acked", ackedAt: new Date() },
    });
    return { handled: true, action: "ack", eventId };
  }
  if (action === "snooze") {
    const hours = Math.max(1, parseInt(arg || "1", 10) || 1);
    await prisma.alertEvent.update({
      where: { id: eventId },
      data: {
        ackStatus: "snoozed",
        snoozeUntil: new Date(Date.now() + hours * 3600_000),
      },
    });
    return { handled: true, action: "snooze", eventId };
  }
  return { handled: false };
}

// ---------------------------------------------------------------------------
// Container log ingestion (controllable subscriber)
// ---------------------------------------------------------------------------

interface Subscription {
  containerName: string;
  stream: Readable;
}

let subscriptions: Subscription[] = [];
let ingestRunning = false;
const partialBuffers = new Map<string, string>();

/**
 * Run all enabled container_logs rules against a single real log line for a
 * given container. Exposed so tests can drive ingestion deterministically.
 */
export async function processLogLine(
  containerName: string,
  line: string
): Promise<{ raised: number }> {
  const parts = line.split("\n");
  let raised = 0;
  const rules = await prisma.alertRule.findMany({
    where: { enabled: true, source: "container_logs" },
  });
  for (const ln of parts) {
    if (!ln.trim()) continue;
    const parsed = parseLogLine(ln);
    for (const rule of rules) {
      if (rule.containerName && rule.containerName !== containerName) continue;
      const m = matchLine(rule, ln, parsed);
      if (!m.matched) continue;
      const r = await raiseAlert({
        ruleId: rule.id,
        source: "container_logs",
        severity: rule.severity as Severity,
        title: `${rule.name} in ${containerName}`,
        containerName,
        payload: {
          line: m.excerpt,
          excerpt: m.excerpt,
          parsedLevel: parsed.level ?? null,
          logFormat: parsed.format ?? null,
        },
      });
      if (!r.suppressed) raised++;
    }
  }
  return { raised };
}

function demuxInto(containerName: string, chunk: Buffer): string[] {
  // Reuse the same multiplexed-frame demux strategy as the docker log route.
  let buf = chunk;
  let out = "";
  while (buf.length >= 8) {
    const type = buf[0];
    if (type > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
      out += buf.toString("utf8");
      buf = Buffer.alloc(0);
      break;
    }
    const len = buf.readUInt32BE(4);
    if (buf.length < 8 + len) break;
    out += buf.slice(8, 8 + len).toString("utf8");
    buf = buf.slice(8 + len);
  }
  const prev = partialBuffers.get(containerName) || "";
  const combined = prev + out;
  const lines = combined.split("\n");
  partialBuffers.set(containerName, lines.pop() ?? "");
  return lines;
}

/** Start subscribing to running containers' log streams (lazy, idempotent). */
export async function startIngestion(): Promise<{ subscribed: number }> {
  if (ingestRunning) return { subscribed: subscriptions.length };
  const cfg = await getAlertsConfig();
  if (!cfg.ingestLogs) return { subscribed: 0 };
  ingestRunning = true;

  let containers: { name: string; state: string }[] = [];
  try {
    containers = (await listContainers()).map((c) => ({
      name: c.name,
      state: c.state,
    }));
  } catch {
    containers = [];
  }

  for (const c of containers) {
    if (c.state !== "running") continue;
    try {
      const stream = (await docker.getContainer(c.name).logs({
        stdout: true,
        stderr: true,
        tail: 0,
        timestamps: true,
        follow: true,
      } as any)) as unknown as Readable;
      stream.on("data", (chunk: Buffer) => {
        try {
          const lines = demuxInto(c.name, Buffer.from(chunk));
          for (const ln of lines) void processLogLine(c.name, ln);
        } catch {}
      });
      stream.on("error", () => {});
      subscriptions.push({ containerName: c.name, stream });
    } catch {
      // Container not reachable — skip honestly.
    }
  }
  return { subscribed: subscriptions.length };
}

/** Stop all log subscriptions. */
export function stopIngestion(): { stopped: number } {
  const n = subscriptions.length;
  for (const s of subscriptions) {
    try {
      (s.stream as any).destroy?.();
    } catch {}
  }
  subscriptions = [];
  partialBuffers.clear();
  ingestRunning = false;
  return { stopped: n };
}

export function ingestionStatus(): { running: boolean; subscriptions: number } {
  return { running: ingestRunning, subscriptions: subscriptions.length };
}

/** Convenience used by the API: start ingestion if config enables it. */
export async function ingestContainerLogs(): Promise<{ subscribed: number }> {
  return startIngestion();
}
