import { NextRequest } from "next/server";
import { handler, json, maskSecrets } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { listContainers } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const containers = await listContainers();
  return json(
    containers.map((c) => ({ ...c, env: maskSecrets(c.env) }))
  );
});
