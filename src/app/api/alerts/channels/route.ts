import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret, masterKeyConfigured, maskSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

function safeView(ch: any) {
  let cfg: any = {};
  try {
    cfg = JSON.parse(
      ch.configEnc.startsWith("v1:") ? "{}" : ch.configEnc
    );
  } catch {}
  return {
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
    minSeverity: ch.minSeverity,
    createdAt: ch.createdAt,
    config: {
      chatId: cfg.chatId ?? null,
      baseUrl: cfg.baseUrl ?? null,
      url: cfg.url ?? null,
      botTokenMasked: cfg.botToken ? maskSecret(String(cfg.botToken)) : "",
      hasToken: !!cfg.botToken,
    },
  };
}

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const channels = await prisma.alertChannel.findMany({
    orderBy: { createdAt: "asc" },
  });
  // Decrypt only to mask — never return the raw token.
  const out = await Promise.all(
    channels.map(async (ch) => {
      try {
        const { decryptSecret } = await import("@/lib/crypto");
        const raw = decryptSecret(ch.configEnc);
        return safeView({ ...ch, configEnc: raw });
      } catch {
        return safeView(ch);
      }
    })
  );
  return json({ channels: out });
});

const CreateSchema = z.object({
  type: z.enum(["telegram", "webhook", "email"]),
  name: z.string().min(1),
  minSeverity: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).default("INFO"),
  enabled: z.boolean().default(true),
  config: z.object({
    botToken: z.string().optional(),
    chatId: z.union([z.string(), z.number()]).optional(),
    baseUrl: z.string().optional(),
    url: z.string().optional(),
  }),
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  if (!masterKeyConfigured())
    throw new Response("PANEL_MASTER_KEY not configured", { status: 400 });
  const body = CreateSchema.parse(await req.json());
  const configEnc = encryptSecret(JSON.stringify(body.config));
  const ch = await prisma.alertChannel.create({
    data: {
      type: body.type,
      name: body.name,
      minSeverity: body.minSeverity,
      enabled: body.enabled,
      configEnc,
    },
  });
  await audit(u.id, "alerts.channel.create", ch.id, { type: body.type });
  return json({ channel: safeView({ ...ch, configEnc: JSON.stringify(body.config) }) });
});
