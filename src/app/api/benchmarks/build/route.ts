import { NextRequest } from "next/server";
import { handler, json, getSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  measureBuild,
  recordCodeMetric,
  BENCHMARKS_SETTING_KEY,
  DEFAULT_BENCHMARKS_CONFIG,
  type BenchmarksConfig,
} from "@/lib/codeanalysis";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const cfg = await getSetting<BenchmarksConfig>(
    BENCHMARKS_SETTING_KEY,
    DEFAULT_BENCHMARKS_CONFIG
  );
  const dir = cfg.targetDir || DEFAULT_BENCHMARKS_CONFIG.targetDir;
  const build = await measureBuild(
    dir,
    cfg.buildCmd || DEFAULT_BENCHMARKS_CONFIG.buildCmd
  );
  const row = await recordCodeMetric({
    buildTimeMs: build.buildTimeMs,
    bundleBytes: build.bundleBytes,
  });
  await audit(user.id, "benchmarks.build", row.id, {
    dir,
    ok: build.ok,
    buildTimeMs: build.buildTimeMs,
    bundleBytes: build.bundleBytes,
  });
  return json(
    {
      metric: row,
      ok: build.ok,
      buildTimeMs: build.buildTimeMs,
      bundleBytes: build.bundleBytes,
      output: build.output,
    },
    { status: 201 }
  );
});
