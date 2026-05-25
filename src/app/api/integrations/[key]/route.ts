import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  stats,
  quotaUsage,
  readConfig,
  expiryInfo,
  STAT_WINDOWS,
  IntegrationConfig,
} from "@/lib/integrations";

export const dynamic = "force-dynamic";

export const GET = handler(
  async (req: NextRequest, ctx: { params: { key: string } }) => {
    await requireRole(req, "READONLY");
    const { key } = ctx.params;
    const i = await prisma.integration.findUnique({
      where: { key },
      include: {
        calls: { orderBy: { createdAt: "desc" }, take: 100 },
        incidents: { orderBy: { startedAt: "desc" } },
      },
    });
    if (!i) return json({ error: "Not found" }, { status: 404 });

    const cfg = readConfig(i.config);
    const windows: Record<string, unknown> = {};
    for (const w of STAT_WINDOWS) windows[w.key] = await stats(i.key, w.hours);

    return json({
      key: i.key,
      name: i.name,
      category: i.category,
      enabled: i.enabled,
      configured: !!cfg.baseUrl,
      config: maskSecrets(cfg),
      credentialExpiresAt: i.credentialExpiresAt,
      credentialExpiry: expiryInfo(i.credentialExpiresAt),
      stats: windows,
      quota: await quotaUsage(i.key),
      recentCalls: i.calls.map((c) => ({
        id: c.id,
        success: c.success,
        statusCode: c.statusCode,
        latencyMs: c.latencyMs,
        costUsd: c.costUsd,
        error: c.error,
        createdAt: c.createdAt,
      })),
      incidents: i.incidents,
    });
  }
);

export const PATCH = handler(
  async (req: NextRequest, ctx: { params: { key: string } }) => {
    const u = await requireRole(req, "ENGINEER");
    const { key } = ctx.params;
    const existing = await prisma.integration.findUnique({ where: { key } });
    if (!existing) return json({ error: "Not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const data: {
      enabled?: boolean;
      config?: object;
      credentialExpiresAt?: Date | null;
    } = {};

    if (typeof body.enabled === "boolean") data.enabled = body.enabled;

    if (body.config && typeof body.config === "object") {
      const prev = readConfig(existing.config);
      const incoming = body.config as IntegrationConfig;
      const merged: IntegrationConfig = { ...prev };
      const assign = (k: keyof IntegrationConfig, v: any) => {
        if (v === undefined) return;
        if (v === null || v === "") delete (merged as any)[k];
        else (merged as any)[k] = v;
      };
      assign("baseUrl", incoming.baseUrl);
      assign("healthPath", incoming.healthPath);
      assign("authHeader", incoming.authHeader);
      assign("apiKey", incoming.apiKey);
      assign(
        "monthlyQuota",
        incoming.monthlyQuota == null ? incoming.monthlyQuota : Number(incoming.monthlyQuota)
      );
      assign(
        "rateLimitPerMin",
        incoming.rateLimitPerMin == null
          ? incoming.rateLimitPerMin
          : Number(incoming.rateLimitPerMin)
      );
      data.config = merged as object;
    }

    if ("credentialExpiresAt" in body) {
      data.credentialExpiresAt = body.credentialExpiresAt
        ? new Date(body.credentialExpiresAt)
        : null;
    }

    const updated = await prisma.integration.update({
      where: { key },
      data,
    });
    await audit(
      u.id,
      "integration.update",
      key,
      { fields: Object.keys(data) },
      req.headers.get("x-forwarded-for") || undefined
    );
    return json({
      ok: true,
      enabled: updated.enabled,
      config: maskSecrets(readConfig(updated.config)),
      credentialExpiresAt: updated.credentialExpiresAt,
    });
  }
);
