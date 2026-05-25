import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).optional(),
  containerName: z.string().nullable().optional(),
  pattern: z.string().nullable().optional(),
  threshold: z.number().int().nullable().optional(),
  windowSec: z.number().int().nullable().optional(),
  severity: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).optional(),
  cooldownSec: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = ctx.params;
    const rule = await prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new Response("Not found", { status: 404 });
    const body = PatchSchema.parse(await req.json());
    const updated = await prisma.alertRule.update({
      where: { id },
      data: body as any,
    });
    await audit(u.id, "alerts.rule.update", id);
    return json({ rule: updated });
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const u = await requireRole(req, "ADMIN");
    const { id } = ctx.params;
    const rule = await prisma.alertRule.findUnique({ where: { id } });
    if (!rule) throw new Response("Not found", { status: 404 });
    if (rule.builtin)
      throw new Response("Built-in rules cannot be deleted (disable instead)", {
        status: 400,
      });
    await prisma.alertRule.delete({ where: { id } }).catch(() => {});
    await audit(u.id, "alerts.rule.delete", id);
    return json({ ok: true });
  }
);
