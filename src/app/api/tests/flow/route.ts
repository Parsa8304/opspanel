import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const TYPES = [
  "UNIT",
  "INTEGRATION",
  "API",
  "FRONTEND",
  "WORKER",
  "E2E",
] as const;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");

  const where: any = {};
  if (from || to) {
    where.testRun = { startedAt: {} };
    if (from) where.testRun.startedAt.gte = new Date(from);
    if (to) where.testRun.startedAt.lte = new Date(to);
  }

  const grouped = await prisma.testCase.groupBy({
    by: ["type", "status"],
    where,
    _count: { _all: true },
  });

  const map = new Map<string, { passed: number; failed: number; skipped: number }>();
  for (const t of TYPES) map.set(t, { passed: 0, failed: 0, skipped: 0 });
  for (const g of grouped) {
    const e = map.get(g.type)!;
    if (g.status === "PASSED") e.passed += g._count._all;
    else if (g.status === "FAILED") e.failed += g._count._all;
    else e.skipped += g._count._all;
  }

  const nodes = TYPES.map((type) => {
    const e = map.get(type)!;
    const total = e.passed + e.failed + e.skipped;
    const ran = e.passed + e.failed;
    return {
      type,
      total,
      passed: e.passed,
      failed: e.failed,
      skipped: e.skipped,
      passRate: ran > 0 ? e.passed / ran : null,
    };
  });

  return json({ nodes });
});
