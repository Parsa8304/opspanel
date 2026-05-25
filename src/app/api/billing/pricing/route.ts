import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const sp = req.nextUrl.searchParams;
  const where: any = {};
  if (sp.get("provider")) where.provider = sp.get("provider");
  if (sp.get("model")) where.model = sp.get("model");
  const rows = await prisma.providerPricing.findMany({
    where,
    orderBy: [
      { provider: "asc" },
      { model: "asc" },
      { effectiveFrom: "desc" },
    ],
  });
  return json({ rows });
});

const Create = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  inPricePerM: z.number().nonnegative(),
  outPricePerM: z.number().nonnegative(),
  cachedInPricePerM: z.number().nonnegative().nullish(),
  effectiveFrom: z.union([z.string(), z.date()]).optional(),
  effectiveTo: z.union([z.string(), z.date()]).nullish(),
});

/** Create a NEW pricing version (history preserved; never edit in place). */
export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ENGINEER");
  const p = Create.parse(await req.json());
  const effectiveFrom = p.effectiveFrom
    ? new Date(p.effectiveFrom)
    : new Date();

  // Close the open prior version so windows don't overlap.
  await prisma.providerPricing.updateMany({
    where: {
      provider: p.provider,
      model: p.model,
      effectiveTo: null,
      effectiveFrom: { lt: effectiveFrom },
    },
    data: { effectiveTo: effectiveFrom },
  });

  const row = await prisma.providerPricing.create({
    data: {
      provider: p.provider,
      model: p.model,
      inPricePerM: p.inPricePerM,
      outPricePerM: p.outPricePerM,
      cachedInPricePerM: p.cachedInPricePerM ?? null,
      effectiveFrom,
      effectiveTo: p.effectiveTo ? new Date(p.effectiveTo) : null,
    },
  });
  await audit(u.id, "billing.pricing.create", row.id, {
    provider: p.provider,
    model: p.model,
  });
  return json(row);
});
