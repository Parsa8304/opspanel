import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import {
  readinessScore,
  activeAlerts,
  trends,
  lastDeployment,
  quickStats,
  phase2Signals,
  deployGate,
  topBlockers,
  recentChangesTimeline,
  environmentHealthSummary,
} from "@/lib/overview";

export const dynamic = "force-dynamic";

// GET /api/overview — aggregated, honest Overview payload.
// Every sub-source is internally guarded (per-source try/catch in the lib), so a
// down Docker/Redis/etc never throws the whole endpoint; it surfaces as honest
// "unavailable / unknown" markers instead.
export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  const readiness = await readinessScore();
  const alerts = await activeAlerts();
  const gate = deployGate(alerts);
  const blockers = topBlockers(alerts, 5);
  const [trendData, lastDep, stats, phase2, timeline, environments] = await Promise.all([
    trends(),
    lastDeployment(),
    quickStats(alerts.length),
    // phase2Signals is internally per-source guarded; still wrap so a total
    // failure can never throw the endpoint (honest null fallback).
    phase2Signals().catch(() => null),
    recentChangesTimeline().catch(() => []),
    environmentHealthSummary().catch(() => []),
  ]);

  return json({
    score: readiness.score,
    band: readiness.band,
    breakdown: readiness.components,
    unavailableComponents: readiness.unavailableComponents,
    partial: readiness.partial,
    gate,
    blockers,
    lastDeployment: lastDep,
    alerts,
    trends: trendData,
    quickStats: stats,
    phase2,
    timeline,
    environments,
  });
});
