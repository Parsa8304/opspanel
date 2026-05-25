import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { audit, hashPassword } from "@/lib/auth";
import { requireAdminAudited, canDeleteUser, canDemoteUser } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.enum(["ADMIN", "ENGINEER", "REVIEWER", "READONLY"]).optional(),
    password: z.string().min(6).optional(),
  })
  .refine((d) => d.name || d.role || d.password, {
    message: "Nothing to update",
  });

function conflict(error: string) {
  return new Response(JSON.stringify({ error }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });
}

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const actor = await requireAdminAudited(req, "access.user.update");
    const id = ctx.params.id;
    const body = patchSchema.parse(await req.json());

    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) throw new Response("Not found", { status: 404 });

    if (body.role && body.role !== before.role) {
      const guard = await canDemoteUser(id, body.role);
      if (!guard.allowed)
        throw conflict(
          guard.reason === "last_admin"
            ? "Cannot demote the last remaining ADMIN"
            : "Cannot change role"
        );
    }

    const data: Record<string, unknown> = {};
    if (body.name) data.name = body.name;
    if (body.role) data.role = body.role;
    if (body.password) data.passwordHash = await hashPassword(body.password);

    const user = await prisma.user.update({
      where: { id },
      data,
      select: userSelect,
    });

    await audit(actor.id, "access.user.update", id, {
      name: body.name ? { from: before.name, to: body.name } : undefined,
      role:
        body.role && body.role !== before.role
          ? { from: before.role, to: body.role }
          : undefined,
      passwordReset: body.password ? true : undefined,
    });
    return json(user);
  }
);

export const DELETE = handler(
  async (req: NextRequest, ctx: { params: { id: string } }) => {
    const actor = await requireAdminAudited(req, "access.user.delete");
    const id = ctx.params.id;
    const guard = await canDeleteUser(id);
    if (!guard.allowed) {
      if (guard.reason === "not_found")
        throw new Response("Not found", { status: 404 });
      throw conflict("Cannot delete the last remaining ADMIN");
    }
    const target = await prisma.user.findUnique({ where: { id } });
    // Detach audit rows so the append-only log survives the user deletion.
    await prisma.auditLog.updateMany({
      where: { userId: id },
      data: { userId: null },
    });
    await prisma.user.delete({ where: { id } });
    await audit(actor.id, "access.user.delete", id, {
      email: target?.email,
      role: target?.role,
    });
    return json({ ok: true });
  }
);
