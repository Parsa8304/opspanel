import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { planDeploy, GitNotConfiguredError, type Env } from "@/lib/deploy";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const url = new URL(req.url);
  const env = url.searchParams.get("env") as Env | null;
  const commit = url.searchParams.get("commit");
  const service = url.searchParams.get("service");
  if (!env || !commit) {
    return json({ error: "env and commit are required" }, { status: 400 });
  }
  try {
    const plan = await planDeploy(env, commit, service || null);
    return json(plan);
  } catch (e) {
    if (e instanceof GitNotConfiguredError) {
      return json({ error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
});
