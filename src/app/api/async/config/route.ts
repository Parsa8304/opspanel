import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json, setSetting, maskSecrets } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  readRedisConfig,
  resolveQueues,
  REDIS_SETTING_KEY,
  DEFAULT_REDIS_URL,
  type RedisConfig,
} from "@/lib/celery";

export const dynamic = "force-dynamic";

/** Mask the password component of a redis:// URL for safe display. */
function maskUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.password) u.password = "••••";
    return u.toString();
  } catch {
    return url;
  }
}

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await readRedisConfig();
  const effectiveUrl = process.env.REDIS_URL || cfg.url || DEFAULT_REDIS_URL;
  return json({
    config: {
      ...maskSecrets(cfg as unknown as Record<string, unknown>),
      url: maskUrl(cfg.url),
    },
    resolved: {
      url: maskUrl(effectiveUrl),
      queues: resolveQueues(cfg),
      envOverride: !!process.env.REDIS_URL,
      defaultUrl: DEFAULT_REDIS_URL,
    },
  });
});

const schema = z.object({
  url: z.string().optional().nullable(),
  queues: z.array(z.string()).optional().nullable(),
  dlq: z.string().optional().nullable(),
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const prev = await readRedisConfig();

  // Preserve the stored URL if the incoming one is the masked placeholder.
  const incomingUrl = body.url ?? undefined;
  const looksMasked =
    typeof incomingUrl === "string" && incomingUrl.includes("••••");
  const url = looksMasked
    ? prev.url
    : incomingUrl?.trim() || undefined;

  const next: RedisConfig = {
    url,
    queues:
      body.queues && body.queues.length
        ? body.queues.map((q) => q.trim()).filter(Boolean)
        : undefined,
    dlq: body.dlq?.trim() || undefined,
  };
  await setSetting(REDIS_SETTING_KEY, next);
  await audit(user.id, "async.config.update", REDIS_SETTING_KEY, {
    queues: next.queues ?? null,
    dlq: next.dlq ?? null,
  });
  return json({
    config: {
      ...maskSecrets(next as unknown as Record<string, unknown>),
      url: maskUrl(next.url),
    },
  });
});
