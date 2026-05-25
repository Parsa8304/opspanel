import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const u = new URL(req.url);
  const moduleQ = u.searchParams.get("module");

  const where: any = {};
  if (moduleQ) where.module = moduleQ;

  const points = await prisma.coverageMetric.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: 1000,
  });
  const distinct = await prisma.coverageMetric.findMany({
    select: { module: true },
    distinct: ["module"],
    orderBy: { module: "asc" },
  });
  const modules = distinct.map((m) => m.module);

  return json({ points, modules });
});

const schema = z.object({
  module: z.string().min(1),
  linesPct: z.number().min(0).max(100),
  commitSha: z.string().optional().nullable(),
  createdAt: z.string().optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  const point = await prisma.coverageMetric.create({
    data: {
      module: body.module,
      linesPct: body.linesPct,
      commitSha: body.commitSha || null,
      ...(body.createdAt ? { createdAt: new Date(body.createdAt) } : {}),
    },
  });
  await audit(user.id, "tests.coverage.record", point.id, {
    module: point.module,
    linesPct: point.linesPct,
  });
  return json(point, { status: 201 });
});
