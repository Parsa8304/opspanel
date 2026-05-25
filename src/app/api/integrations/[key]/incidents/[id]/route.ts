import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { key: string; id: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const i = await prisma.integration.findUnique({
      where: { key: ctx.params.key },
    });
    if (!i) return json({ error: "Not found" }, { status: 404 });
    const incident = await prisma.integrationIncident.findFirst({
      where: { id: ctx.params.id, integrationId: i.id },
    });
    if (!incident) return json({ error: "Not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const data: {
      resolvedAt?: Date | null;
      title?: string;
      description?: string | null;
      severity?: string;
    } = {};
    if ("resolve" in body) {
      data.resolvedAt = body.resolve ? new Date() : null;
    }
    if (typeof body.title === "string") data.title = body.title;
    if ("description" in body) data.description = body.description || null;
    if (
      typeof body.severity === "string" &&
      ["minor", "major", "critical"].includes(body.severity)
    )
      data.severity = body.severity;

    const updated = await prisma.integrationIncident.update({
      where: { id: incident.id },
      data,
    });
    await audit(
      u.id,
      "integration.incident.update",
      ctx.params.key,
      { incidentId: incident.id, resolved: !!updated.resolvedAt },
      req.headers.get("x-forwarded-for") || undefined
    );
    return json({ incident: updated });
  }
);
