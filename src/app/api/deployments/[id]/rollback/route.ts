import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Roll back: create a NEW active deployment for the same environment that
 * points at the commit of the target (rolled-back-to) deployment, recording
 * rollbackOfId. The current active deployment is superseded.
 */
export const POST = handler(async (req: NextRequest, ctx: any) => {
  const user = await requireRole(req, "ENGINEER");
  const id = ctx?.params?.id as string;

  const target = await prisma.deployment.findUnique({ where: { id } });
  if (!target)
    return json({ error: "Deployment not found." }, { status: 404 });

  const dep = await prisma.$transaction(async (tx) => {
    await tx.deployment.updateMany({
      where: { environment: target.environment, status: "active" },
      data: { status: "superseded" },
    });
    return tx.deployment.create({
      data: {
        environment: target.environment,
        commitSha: target.commitSha,
        version: target.version,
        status: "active",
        deployedById: user.id,
        rollbackOfId: target.id,
      },
      include: { deployedBy: { select: { id: true, name: true } } },
    });
  });

  await audit(user.id, "deployment.rollback", dep.id, {
    environment: dep.environment,
    rolledBackTo: target.id,
    commitSha: dep.commitSha,
  });
  return json(dep, { status: 201 });
});
