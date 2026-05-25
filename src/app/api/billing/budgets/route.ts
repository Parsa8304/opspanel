import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { budgetStatuses } from "@/lib/billing";

export const dynamic = "force-dynamic";

const Upsert = z.object({
  provider: z.string().min(1),
  period: z.enum(["daily", "weekly", "monthly"]),
  limitAmount: z.number().positive(),
  currency: z.string().default("USD"),
  thresholds: z.array(z.number().int().positive()).optional(),
  actionOnBreach: z.enum(["alert", "pause"]).default("alert"),
  enabled: z.boolean().default(true),
});

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const provider = req.nextUrl.searchParams.get("provider") || undefined;
  return json({ budgets: await budgetStatuses(provider) });
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const b = Upsert.parse(await req.json());
  const row = await prisma.billingBudget.upsert({
    where: { provider_period: { provider: b.provider, period: b.period } },
    create: {
      provider: b.provider,
      period: b.period,
      limitAmount: b.limitAmount,
      currency: b.currency,
      thresholds: b.thresholds ?? [50, 80, 100],
      actionOnBreach: b.actionOnBreach,
      enabled: b.enabled,
    },
    update: {
      limitAmount: b.limitAmount,
      currency: b.currency,
      thresholds: b.thresholds ?? [50, 80, 100],
      actionOnBreach: b.actionOnBreach,
      enabled: b.enabled,
    },
  });
  await audit(u.id, "billing.budget.upsert", row.id, {
    provider: b.provider,
    period: b.period,
  });
  return json(row);
});

const Patch = Upsert.partial().extend({ id: z.string().min(1) });

export const PATCH = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const { id, ...data } = Patch.parse(await req.json());
  const row = await prisma.billingBudget.update({
    where: { id },
    data,
  });
  await audit(u.id, "billing.budget.patch", id, data);
  return json(row);
});

export const DELETE = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const id = req.nextUrl.searchParams.get("id");
  if (!id) throw new Response("id required", { status: 400 });
  await prisma.billingBudget.delete({ where: { id } });
  await audit(u.id, "billing.budget.delete", id);
  return json({ deleted: true });
});
