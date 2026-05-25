import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { listContainers, listVolumes } from "@/lib/docker";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");
  const containers = await listContainers();
  // collect all volume names currently mounted
  const mountedNames = containers.flatMap((c) =>
    c.mounts.filter((m) => m.type === "volume").map((m) => m.source)
  );
  const volumes = await listVolumes(mountedNames);
  return json(volumes);
});
