import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import {
  runDeploy,
  envRequiresAdmin,
  DeployRefusedError,
  GitNotConfiguredError,
  type Env,
  type Strategy,
} from "@/lib/deploy";

export const dynamic = "force-dynamic";

interface Body {
  env: Env;
  commit: string;
  service?: string | null;
  strategy?: Strategy;
  approveDestructive?: boolean;
  maintenanceWindow?: boolean;
}

export const POST = handler(async (req: NextRequest) => {
  const body = (await req.json()) as Body;
  if (!body?.env || !body?.commit) {
    return json({ error: "env and commit are required" }, { status: 400 });
  }
  // Per-environment role gating: PROD/OPERATIONAL → ADMIN, else ENGINEER+.
  const u = await requireRole(req, envRequiresAdmin(body.env) ? "ADMIN" : "ENGINEER");

  try {
    const result = await runDeploy(body.env, body.commit, body.service ?? null, {
      strategy: body.strategy,
      approveDestructive: !!body.approveDestructive,
      maintenanceWindow: !!body.maintenanceWindow,
      triggeredById: u.id,
    });
    await audit(
      u.id,
      "deploy.run",
      result.deployRunId,
      { env: body.env, commit: body.commit, service: body.service ?? null },
      req.headers.get("x-forwarded-for") ?? undefined
    );
    return json(result);
  } catch (e) {
    if (e instanceof DeployRefusedError) {
      return json({ error: e.message, code: e.code, reasons: e.reasons }, { status: 422 });
    }
    if (e instanceof GitNotConfiguredError) {
      return json({ error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
});
