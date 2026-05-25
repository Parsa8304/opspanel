import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "DONE"] as const;

export const GET = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    await requireRole(req, "READONLY");
    const item = await prisma.coverageItem.findUnique({
      where: { id: ctx.params.id },
    });
    if (!item) throw new Response("Not found", { status: 404 });
    return json(item);
  }
);

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  area: z.string().min(1).optional(),
  owner: z.string().nullable().optional(),
  status: z.enum(STATUSES).optional(),
  deadline: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
  blockers: z.string().nullable().optional(),
});

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    const b = patchSchema.parse(await req.json());
    const { deadline, ...rest } = b;
    const item = await prisma.coverageItem.update({
      where: { id: ctx.params.id },
      data: {
        ...rest,
        ...(deadline !== undefined
          ? { deadline: deadline ? new Date(deadline) : null }
          : {}),
      },
    });
    await audit(user.id, "qa.coverage.update", item.id, b);
    return json(item);
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const user = await requireRole(req, "ENGINEER");
    await prisma.coverageItem.delete({ where: { id: ctx.params.id } });
    await audit(user.id, "qa.coverage.delete", ctx.params.id);
    return json({ ok: true });
  }
);
