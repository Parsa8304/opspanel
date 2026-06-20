import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { targetExec } from "@/lib/target";
import { listContainers } from "@/lib/remoteDocker";

export const dynamic = "force-dynamic";

interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  inUse: boolean;
}

async function listVolumesForServer(serverId: string): Promise<VolumeInfo[]> {
  const { stdout } = await targetExec(serverId, `docker volume ls --format '{{json .}}'`, 20000);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v): v is any => v !== null)
    .map((v) => ({
      name: v.Name || "",
      driver: v.Driver || "",
      mountpoint: v.Mountpoint || "",
      createdAt: v.CreatedAt || "",
      inUse: false,
    }));
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const [containers, volumes] = await Promise.all([
    listContainers(id).catch(() => []),
    listVolumesForServer(id).catch(() => []),
  ]);

  const usedVolumeNames = new Set<string>();
  for (const c of containers) {
    for (const m of c.mounts) {
      if (m.type === "volume") usedVolumeNames.add(m.source);
    }
  }

  const dbContainers = containers
    .filter((c) =>
      /(postgres|mysql|mariadb|mongo|redis|mssql|oracle|elastic|cassandra)/i.test(c.image)
    )
    .map((c) => ({
      id: c.id.slice(0, 12),
      name: c.name,
      image: c.image,
      tag: c.tag,
      state: c.state,
      dbType:
        c.image.match(/(postgres|mysql|mariadb|mongo|redis|mssql|elastic|cassandra)/i)?.[1]?.toLowerCase() ??
        "database",
    }));

  const allContainers = containers.map((c) => ({
    id: c.id.slice(0, 12),
    name: c.name,
    image: c.image,
    tag: c.tag,
    state: c.state,
  }));

  const volumeList = volumes.map((v) => ({
    name: v.name,
    driver: v.driver,
    mountpoint: v.mountpoint,
    createdAt: v.createdAt,
    inUse: usedVolumeNames.has(v.name),
  }));

  return json({ dbContainers, allContainers, volumes: volumeList });
});
