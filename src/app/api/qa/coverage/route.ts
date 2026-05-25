import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "DONE"] as const;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const items = await prisma.coverageItem.findMany({
    orderBy: { createdAt: "asc" },
  });
  return json(items);
});

const createSchema = z.object({
  title: z.string().min(1),
  area: z.string().min(1),
  owner: z.string().optional().nullable(),
  status: z.enum(STATUSES).optional(),
  deadline: z.string().datetime().optional().nullable(),
  notes: z.string().optional().nullable(),
  blockers: z.string().optional().nullable(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const b = createSchema.parse(await req.json());
  const item = await prisma.coverageItem.create({
    data: {
      title: b.title,
      area: b.area,
      owner: b.owner ?? null,
      status: b.status ?? "NOT_STARTED",
      deadline: b.deadline ? new Date(b.deadline) : null,
      notes: b.notes ?? null,
      blockers: b.blockers ?? null,
    },
  });
  await audit(user.id, "qa.coverage.create", item.id, { title: item.title });
  return json(item, { status: 201 });
});
