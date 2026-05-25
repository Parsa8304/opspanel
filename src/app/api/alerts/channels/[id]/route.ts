import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  minSeverity: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).optional(),
  config: z
    .object({
      botToken: z.string().optional(),
      chatId: z.union([z.string(), z.number()]).optional(),
      baseUrl: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = ctx.params;
    const ch = await prisma.alertChannel.findUnique({ where: { id } });
    if (!ch) throw new Response("Not found", { status: 404 });
    const body = PatchSchema.parse(await req.json());

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.minSeverity !== undefined) data.minSeverity = body.minSeverity;
    if (body.config) {
      // Merge into existing config; keep prior botToken if blank/omitted.
      let current: any = {};
      try {
        current = JSON.parse(decryptSecret(ch.configEnc));
      } catch {}
      const merged = { ...current };
      if (body.config.chatId !== undefined) merged.chatId = body.config.chatId;
      if (body.config.baseUrl !== undefined) merged.baseUrl = body.config.baseUrl;
      if (body.config.url !== undefined) merged.url = body.config.url;
      if (body.config.botToken) merged.botToken = body.config.botToken;
      data.configEnc = encryptSecret(JSON.stringify(merged));
    }

    const updated = await prisma.alertChannel.update({ where: { id }, data });
    await audit(u.id, "alerts.channel.update", id);
    return json({ ok: true, id: updated.id });
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = ctx.params;
    await prisma.alertChannel.delete({ where: { id } }).catch(() => {});
    await audit(u.id, "alerts.channel.delete", id);
    return json({ ok: true });
  }
);
