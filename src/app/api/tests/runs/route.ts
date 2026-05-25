import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  const type = u.searchParams.get("type");
  const status = u.searchParams.get("status");
  const commit = u.searchParams.get("commit");

  const where: any = {};
  if (from || to) {
    where.startedAt = {};
    if (from) where.startedAt.gte = new Date(from);
    if (to) where.startedAt.lte = new Date(to);
  }
  if (commit) where.commitSha = { contains: commit };
  // Filtering by case type/status: only runs that contain such a case.
  if (type || status) {
    where.cases = {
      some: {
        ...(type ? { type: type as any } : {}),
        ...(status ? { status: status as any } : {}),
      },
    };
  }

  const runs = await prisma.testRun.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: 200,
    select: {
      id: true,
      commitSha: true,
      source: true,
      ciUrl: true,
      total: true,
      passed: true,
      failed: true,
      skipped: true,
      durationMs: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  // Per-day aggregation (UTC day key).
  const byDay = new Map<
    string,
    { day: string; passed: number; failed: number; skipped: number; runs: number }
  >();
  for (const r of runs) {
    const day = r.startedAt.toISOString().slice(0, 10);
    const e =
      byDay.get(day) ||
      { day, passed: 0, failed: 0, skipped: 0, runs: 0 };
    e.passed += r.passed;
    e.failed += r.failed;
    e.skipped += r.skipped;
    e.runs += 1;
    byDay.set(day, e);
  }
  const daily = Array.from(byDay.values()).sort((a, b) =>
    a.day < b.day ? -1 : 1
  );

  return json({ runs, daily });
});
