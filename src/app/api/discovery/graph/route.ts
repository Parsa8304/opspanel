import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { buildDependencyGraph, discoverComposeFiles } from "@/lib/discovery";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const graph = await buildDependencyGraph();
  const compose = await discoverComposeFiles();
  return json({
    graph,
    reconcile: {
      orphans: compose.orphans,
      missing: compose.missing,
      versionDrift: compose.versionDrift,
      files: compose.files.map((f) => ({
        path: f.path,
        parsed: f.parsed,
        error: f.error,
        serviceCount: f.services.length,
      })),
    },
  });
});
