import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { withScenarioStatus } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const rows = await prisma.accessScenario.findMany({
    orderBy: { name: "asc" },
    include: { verifiedBy: { select: { id: true, name: true } } },
  });
  const now = new Date();
  return json(rows.map((r) => withScenarioStatus(r, now)));
});

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  staleAfterDays: z.number().int().positive().optional(),
  notes: z.string().nullable().optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const actor = await requireRole(req, "ENGINEER");
  const body = createSchema.parse(await req.json());
  const s = await prisma.accessScenario.create({
    data: {
      name: body.name,
      description: body.description,
      status: "STALE",
      staleAfterDays: body.staleAfterDays ?? 30,
      notes: body.notes ?? null,
    },
    include: { verifiedBy: { select: { id: true, name: true } } },
  });
  await audit(actor.id, "access.scenario.create", s.id, { name: s.name });
  return json(withScenarioStatus(s), { status: 201 });
});
