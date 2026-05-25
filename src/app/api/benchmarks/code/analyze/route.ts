import { NextRequest } from "next/server";
import { handler, json, getSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  analyzeRepo,
  recordCodeMetric,
  BENCHMARKS_SETTING_KEY,
  DEFAULT_BENCHMARKS_CONFIG,
  type BenchmarksConfig,
} from "@/lib/codeanalysis";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const cfg = await getSetting<BenchmarksConfig>(
    BENCHMARKS_SETTING_KEY,
    DEFAULT_BENCHMARKS_CONFIG
  );
  const dir = cfg.targetDir || DEFAULT_BENCHMARKS_CONFIG.targetDir;
  const result = await analyzeRepo(dir);
  const row = await recordCodeMetric({
    loc: result.loc,
    cyclomatic: result.cyclomatic,
    duplicationPct: result.duplicationPct,
    lintWarnings: result.lintWarnings,
    typeErrors: result.typeErrors,
  });
  await audit(user.id, "benchmarks.code.analyze", row.id, {
    dir,
    loc: result.loc,
    files: result.files,
  });
  return json({ metric: row, analysis: result }, { status: 201 });
});
