import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, hashPassword, audit } from "@/lib/auth";
import { requireAdminAudited } from "@/lib/access";
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

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const users = await prisma.user.findMany({
    select: userSelect,
    orderBy: { createdAt: "asc" },
  });
  return json(users);
});

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["ADMIN", "ENGINEER", "REVIEWER", "READONLY"]),
  password: z.string().min(6),
});

export const POST = handler(async (req: NextRequest) => {
  const actor = await requireAdminAudited(req, "access.user.create");
  const body = createSchema.parse(await req.json());
  const existing = await prisma.user.findUnique({
    where: { email: body.email },
  });
  if (existing)
    throw new Response(JSON.stringify({ error: "Email already in use" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  const user = await prisma.user.create({
    data: {
      email: body.email,
      name: body.name,
      role: body.role,
      passwordHash: await hashPassword(body.password),
    },
    select: userSelect,
  });
  await audit(actor.id, "access.user.create", user.id, {
    email: user.email,
    role: user.role,
  });
  return json(user, { status: 201 });
});
