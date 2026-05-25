import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { reconcile, runReconciliationJob } from "@/lib/billing";

export const dynamic = "force-dynamic";

/** Recon history + last success per provider + unresolved drift. */
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const provider = req.nextUrl.searchParams.get("provider") || undefined;
  const where = provider ? { provider } : {};
  const runs = await prisma.reconciliationRun.findMany({
    where,
    orderBy: { forDate: "desc" },
    take: 90,
  });
  const lastSuccess = await prisma.reconciliationRun.findFirst({
    where: { ...where, status: "ok" },
    orderBy: { forDate: "desc" },
  });
  const unresolved = await prisma.reconciliationRun.findMany({
    where: { ...where, flagged: true },
    orderBy: { forDate: "desc" },
  });
  return json({ runs, lastSuccess, unresolved });
});

const Body = z.object({
  provider: z.string().min(1),
  forDate: z.string().optional(),
  async: z.boolean().optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const b = Body.parse(await req.json());
  await audit(u.id, "billing.reconcile", b.provider, b);
  if (b.async) {
    const job = await runReconciliationJob(
      b.forDate ? new Date(b.forDate) : undefined,
      b.provider
    );
    return json({ jobId: job.jobId, started: true });
  }
  const date = b.forDate
    ? new Date(b.forDate)
    : new Date(Date.now() - 86400_000);
  const r = await reconcile(b.provider, date);
  return json(r);
});
