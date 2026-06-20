import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { targetExec, targetReadFile } from "@/lib/target";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;

  const [cpuInfoRes, memRes, dfRes, loadRes, psRes, dfInodeRes] =
    await Promise.allSettled([
      targetReadFile(id, "/proc/cpuinfo"),
      targetReadFile(id, "/proc/meminfo"),
      targetExec(
        id,
        "df -h --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2"
      ),
      targetReadFile(id, "/proc/loadavg"),
      targetExec(id, "ps aux --sort=-%cpu 2>/dev/null | tail -n +2 | head -11"),
      targetExec(
        id,
        "df -i --output=source,iused,iavail,ipcent,target 2>/dev/null | tail -n +2"
      ),
    ]);

  // CPU
  let cores = 0;
  let cpuModel = "unknown";
  if (cpuInfoRes.status === "fulfilled") {
    cores = (cpuInfoRes.value.match(/^processor\s*:/gm) || []).length;
    cpuModel =
      cpuInfoRes.value.match(/^model name\s*:\s*(.+)/m)?.[1]?.trim() || "unknown";
  }

  // Memory (in MB)
  let memory = { total: 0, used: 0, free: 0, cached: 0, buffers: 0 };
  let swap = { total: 0, used: 0, free: 0 };
  if (memRes.status === "fulfilled") {
    const val = (key: string) => {
      const m = memRes.value.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? Math.round(parseInt(m[1]) / 1024) : 0;
    };
    const memTotal = val("MemTotal");
    const memFree = val("MemFree");
    const cached = val("Cached");
    const buffers = val("Buffers");
    memory = {
      total: memTotal,
      free: memFree,
      cached,
      buffers,
      used: memTotal - memFree - cached - buffers,
    };
    const swapTotal = val("SwapTotal");
    const swapFree = val("SwapFree");
    swap = {
      total: swapTotal,
      used: swapTotal - swapFree,
      free: swapFree,
    };
  }

  // Disk
  const disk: {
    filesystem: string;
    size: string;
    used: string;
    available: string;
    usePercent: string;
    mountpoint: string;
  }[] = [];
  if (dfRes.status === "fulfilled") {
    for (const line of dfRes.value.stdout.split("\n").filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        disk.push({
          filesystem: parts[0],
          size: parts[1],
          used: parts[2],
          available: parts[3],
          usePercent: parts[4],
          mountpoint: parts[5],
        });
      }
    }
  }

  // Load average
  let load: [number, number, number] = [0, 0, 0];
  if (loadRes.status === "fulfilled") {
    const parts = loadRes.value.trim().split(" ");
    load = [
      parseFloat(parts[0]) || 0,
      parseFloat(parts[1]) || 0,
      parseFloat(parts[2]) || 0,
    ];
  }

  // Top processes
  const processes: {
    pid: string;
    user: string;
    cpu: string;
    mem: string;
    command: string;
  }[] = [];
  if (psRes.status === "fulfilled") {
    for (const line of psRes.value.stdout.split("\n").filter(Boolean).slice(0, 10)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 11) {
        processes.push({
          user: parts[0],
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          command: parts.slice(10).join(" ").slice(0, 60),
        });
      }
    }
  }

  // Inodes
  const inodes: {
    filesystem: string;
    inodeUsed: string;
    inodeFree: string;
    inodeUsePercent: string;
    mountpoint: string;
  }[] = [];
  if (dfInodeRes.status === "fulfilled") {
    for (const line of dfInodeRes.value.stdout.split("\n").filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        inodes.push({
          filesystem: parts[0],
          inodeUsed: parts[1],
          inodeFree: parts[2],
          inodeUsePercent: parts[3],
          mountpoint: parts[4],
        });
      }
    }
  }

  return json({
    cpu: { cores, model: cpuModel },
    memory,
    swap,
    disk,
    load,
    processes,
    inodes,
  });
});
