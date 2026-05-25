import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { key: string } }) => {
    await requireRole(req, "READONLY");
    const i = await prisma.integration.findUnique({
      where: { key: ctx.params.key },
    });
    if (!i) return json({ error: "Not found" }, { status: 404 });
    const incidents = await prisma.integrationIncident.findMany({
      where: { integrationId: i.id },
      orderBy: { startedAt: "desc" },
    });
    return json({ incidents });
  }
);

export const POST = handler(
  async (req: NextRequest, ctx: { params: { key: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const i = await prisma.integration.findUnique({
      where: { key: ctx.params.key },
    });
    if (!i) return json({ error: "Not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    if (!body.title || typeof body.title !== "string")
      return json({ error: "title required" }, { status: 400 });
    const incident = await prisma.integrationIncident.create({
      data: {
        integrationId: i.id,
        title: body.title,
        description: body.description || null,
        severity: ["minor", "major", "critical"].includes(body.severity)
          ? body.severity
          : "minor",
        startedAt: body.startedAt ? new Date(body.startedAt) : new Date(),
      },
    });
    await audit(
      u.id,
      "integration.incident.create",
      ctx.params.key,
      { incidentId: incident.id },
      req.headers.get("x-forwarded-for") || undefined
    );
    return json({ incident });
  }
);
