import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeFlaky } from "@/lib/junit";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");

  const runWhere: any = {};
  if (from || to) {
    runWhere.startedAt = {};
    if (from) runWhere.startedAt.gte = new Date(from);
    if (to) runWhere.startedAt.lte = new Date(to);
  }

  const cases = await prisma.testCase.findMany({
    where: { testRun: runWhere },
    select: {
      name: true,
      status: true,
      testRun: { select: { startedAt: true } },
    },
  });

  const flaky = computeFlaky(cases as any);
  return json({ flaky });
});
