import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { hostExec } from "@/lib/server";

export const dynamic = "force-dynamic";

// Deploy target directory on the host. Override with INFRA_DEPLOY_DIR.
const DEPLOY_DIR = process.env.INFRA_DEPLOY_DIR || "/opt/app";
const COMPOSE_FILE = `${DEPLOY_DIR}/docker-compose.yml`;

export const GET = handler(async (req: NextRequest) => {
  await requireRole(req, "READONLY");

  const [psResult, gitResult] = await Promise.allSettled([
    hostExec(
      `docker compose -f ${COMPOSE_FILE} ps --format json 2>/dev/null || docker compose -f ${COMPOSE_FILE} ps 2>&1`,
      15000
    ),
    hostExec(
      `git -C ${DEPLOY_DIR} log -1 --format='%H|%h|%an|%ai|%s' 2>/dev/null`,
      10000
    ),
  ]);

  // Parse docker compose ps output (may be JSON array or plain text)
  let containers: {
    name: string;
    image: string;
    status: string;
    running: boolean;
  }[] = [];

  if (psResult.status === "fulfilled") {
    const raw = psResult.value.stdout.trim();
    try {
      // Docker Compose v2 --format json outputs one JSON object per line
      const lines = raw.split("\n").filter((l) => l.startsWith("{"));
      if (lines.length > 0) {
        containers = lines.map((l) => {
          const obj = JSON.parse(l);
          return {
            name: obj.Name ?? obj.Service ?? "?",
            image: obj.Image ?? "?",
            status: obj.Status ?? obj.State ?? "?",
            running: (obj.State ?? obj.Status ?? "").toLowerCase().includes("running") ||
                     (obj.Status ?? "").toLowerCase().startsWith("up"),
          };
        });
      } else {
        // Plain text fallback — parse lines like "NAME   IMAGE   STATUS ..."
        const textLines = raw.split("\n").filter(Boolean);
        for (const line of textLines.slice(1)) {
          const parts = line.split(/\s{2,}/);
          if (parts.length >= 3) {
            containers.push({
              name: parts[0]?.trim() ?? "?",
              image: parts[1]?.trim() ?? "?",
              status: parts[3]?.trim() ?? parts[2]?.trim() ?? "?",
              running: (parts[3] ?? parts[2] ?? "").toLowerCase().includes("up"),
            });
          }
        }
      }
    } catch {
      containers = [{ name: "parse-error", image: "?", status: raw.slice(0, 120), running: false }];
    }
  }

  // Parse git log
  let commit: { sha: string; shortSha: string; author: string; date: string; message: string } | null = null;
  if (gitResult.status === "fulfilled") {
    const parts = gitResult.value.stdout.trim().split("|");
    if (parts.length >= 5) {
      commit = {
        sha: parts[0],
        shortSha: parts[1],
        author: parts[2],
        date: parts[3],
        message: parts.slice(4).join("|"),
      };
    }
  }

  return json({ containers, commit, dir: DEPLOY_DIR });
});
