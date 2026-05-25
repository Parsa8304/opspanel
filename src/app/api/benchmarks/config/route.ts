import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, json, getSetting, setSetting } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  BENCHMARKS_SETTING_KEY,
  DEFAULT_BENCHMARKS_CONFIG,
  type BenchmarksConfig,
} from "@/lib/codeanalysis";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await getSetting<BenchmarksConfig>(
    BENCHMARKS_SETTING_KEY,
    DEFAULT_BENCHMARKS_CONFIG
  );
  return json(cfg);
});

const schema = z.object({
  targetDir: z.string().min(1),
  buildCmd: z.string().min(1),
  endpoints: z
    .array(z.object({ name: z.string().min(1), url: z.string().url() }))
    .default([]),
});

export const PUT = handler(async (req: NextRequest) => {
  const user = await requireRole(req, "ENGINEER");
  const body = schema.parse(await req.json());
  await setSetting(BENCHMARKS_SETTING_KEY, body);
  await audit(user.id, "benchmarks.config.update", BENCHMARKS_SETTING_KEY, {
    targetDir: body.targetDir,
    endpoints: body.endpoints.length,
  });
  return json(body);
});
