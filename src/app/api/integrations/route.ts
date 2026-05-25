import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  stats,
  quotaUsage,
  readConfig,
  expiryInfo,
  STAT_WINDOWS,
} from "@/lib/integrations";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const integrations = await prisma.integration.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const out = await Promise.all(
    integrations.map(async (i) => {
      const cfg = readConfig(i.config);
      const configured = !!cfg.baseUrl;
      const windows: Record<string, unknown> = {};
      for (const w of STAT_WINDOWS) {
        windows[w.key] = await stats(i.key, w.hours);
      }
      const quota = await quotaUsage(i.key);
      const exp = expiryInfo(i.credentialExpiresAt);
      return {
        key: i.key,
        name: i.name,
        category: i.category,
        enabled: i.enabled,
        configured,
        config: maskSecrets(cfg),
        credentialExpiresAt: i.credentialExpiresAt,
        credentialExpiry: exp,
        stats: windows,
        quota,
        lastSuccessAt: (windows["30d"] as any)?.lastSuccessAt ?? null,
        lastCallAt: (windows["30d"] as any)?.lastCallAt ?? null,
      };
    })
  );

  return json({ integrations: out });
});
