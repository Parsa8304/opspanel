import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const rules = await prisma.alertRule.findMany({
    orderBy: [{ builtin: "desc" }, { name: "asc" }],
  });
  return json({ rules });
});

const CreateSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  containerName: z.string().optional().nullable(),
  pattern: z.string().optional().nullable(),
  threshold: z.number().int().optional().nullable(),
  windowSec: z.number().int().optional().nullable(),
  severity: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).default("ERROR"),
  cooldownSec: z.number().int().min(0).default(300),
  enabled: z.boolean().default(true),
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = CreateSchema.parse(await req.json());
  const rule = await prisma.alertRule.create({
    data: {
      name: body.name,
      source: body.source,
      containerName: body.containerName ?? null,
      pattern: body.pattern ?? null,
      threshold: body.threshold ?? null,
      windowSec: body.windowSec ?? null,
      severity: body.severity,
      cooldownSec: body.cooldownSec,
      enabled: body.enabled,
      builtin: false,
    },
  });
  await audit(u.id, "alerts.rule.create", rule.id);
  return json({ rule });
});
