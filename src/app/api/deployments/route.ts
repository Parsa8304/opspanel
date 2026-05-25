import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ENVS = ["DEV", "STAGING", "DEMO", "OPERATIONAL", "PROD"] as const;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const items = await prisma.deployment.findMany({
    orderBy: { deployedAt: "desc" },
    include: { deployedBy: { select: { id: true, name: true } } },
  });
  return json(items);
});

const createSchema = z.object({
  environment: z.enum(ENVS),
  commitSha: z.string().min(4),
  version: z.string().optional().nullable(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = createSchema.parse(await req.json());

  const dep = await prisma.$transaction(async (tx) => {
    // Mark previous active deployments for this env as superseded.
    await tx.deployment.updateMany({
      where: { environment: body.environment, status: "active" },
      data: { status: "superseded" },
    });
    return tx.deployment.create({
      data: {
        environment: body.environment,
        commitSha: body.commitSha,
        version: body.version ?? null,
        status: "active",
        deployedById: user.id,
      },
      include: { deployedBy: { select: { id: true, name: true } } },
    });
  });

  await audit(user.id, "deployment.create", dep.id, {
    environment: dep.environment,
    commitSha: dep.commitSha,
    version: dep.version,
  });
  return json(dep, { status: 201 });
});
