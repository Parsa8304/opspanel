import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole, audit } from "@/lib/auth";
import { getDeployConfig, setDeployConfig, type DeployConfig } from "@/lib/deploy";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const cfg = await getDeployConfig();
  // Never leak the encrypted vault password blob to the UI.
  const { vaultPasswordEnc, ...safe } = cfg;
  return json({ ...safe, vaultConfigured: !!vaultPasswordEnc });
});

export const PUT = handler(async (req: NextRequest) => {
  const u = await requireRole(req, "ADMIN");
  const body = (await req.json()) as Partial<DeployConfig>;
  const saved = await setDeployConfig(body);
  await audit(
    u.id,
    "deploy.config.update",
    "deploy",
    { ...saved, vaultPasswordEnc: undefined },
    req.headers.get("x-forwarded-for") ?? undefined
  );
  const { vaultPasswordEnc, ...safe } = saved;
  return json({ ...safe, vaultConfigured: !!vaultPasswordEnc });
});
