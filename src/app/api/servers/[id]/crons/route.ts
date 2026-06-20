import { NextRequest } from "next/server";
import { handler, json } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { targetExec } from "@/lib/target";

export const dynamic = "force-dynamic";

interface CronEntry {
  id: string;
  source: string;
  schedule: string;
  user: string | null;
  command: string;
  comment: string | null;
  enabled: boolean;
}

function parseCronFile(content: string, source: string, hasUserField: boolean): CronEntry[] {
  const entries: CronEntry[] = [];
  let pendingComment: string | null = null;
  let idx = 0;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) { pendingComment = null; continue; }

    if (line.startsWith("#")) {
      pendingComment = line.slice(1).trim() || null;
      continue;
    }

    // VARIABLE=value lines (e.g. SHELL, PATH, MAILTO)
    if (/^[A-Z_]+=/.test(line)) { pendingComment = null; continue; }

    const parts = line.split(/\s+/);
    // need at least: min hour dom month dow [user] cmd
    const minFields = hasUserField ? 7 : 6;
    if (parts.length < minFields) { pendingComment = null; continue; }

    const schedule = parts.slice(0, 5).join(" ");
    let user: string | null = null;
    let command: string;

    if (hasUserField) {
      user = parts[5];
      command = parts.slice(6).join(" ");
    } else {
      command = parts.slice(5).join(" ");
    }

    entries.push({
      id: `${source}:${idx++}`,
      source,
      schedule,
      user,
      command,
      comment: pendingComment,
      enabled: true,
    });
    pendingComment = null;
  }

  return entries;
}

async function readCrontabs(serverId: string): Promise<CronEntry[]> {
  const all: CronEntry[] = [];

  // Root's personal crontab
  try {
    const { stdout } = await targetExec(serverId, "crontab -l 2>/dev/null || true");
    if (stdout.trim()) {
      all.push(...parseCronFile(stdout, "root crontab", false));
    }
  } catch {}

  // /etc/crontab (system-wide, has user field)
  try {
    const { stdout } = await targetExec(serverId, "cat /etc/crontab 2>/dev/null || true");
    if (stdout.trim()) {
      all.push(...parseCronFile(stdout, "/etc/crontab", true));
    }
  } catch {}

  // /etc/cron.d/* (each file has user field)
  try {
    const { stdout: files } = await targetExec(
      serverId,
      "ls /etc/cron.d/ 2>/dev/null | grep -v '.placeholder' || true"
    );
    for (const file of files.split("\n").map((f) => f.trim()).filter(Boolean)) {
      try {
        const { stdout } = await targetExec(serverId, `cat /etc/cron.d/${file} 2>/dev/null || true`);
        if (stdout.trim()) {
          all.push(...parseCronFile(stdout, `/etc/cron.d/${file}`, true));
        }
      } catch {}
    }
  } catch {}

  return all;
}

export const GET = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "READONLY");
  const { id } = await ctx.params;
  const entries = await readCrontabs(id);
  return json({ entries });
});

export const POST = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;
  const body = (await req.json()) as { schedule: string; command: string; comment?: string };

  if (!body.schedule?.trim() || !body.command?.trim()) {
    return json({ error: "schedule and command are required" }, { status: 400 });
  }

  const parts = body.schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return json({ error: "schedule must be 5 fields (min hour dom month dow)" }, { status: 400 });
  }

  const commentLine = body.comment?.trim() ? `# ${body.comment.trim()}\n` : "";
  const newLine = `${commentLine}${body.schedule.trim()} ${body.command.trim()}`;

  // Append to root crontab
  const { stdout: existing } = await targetExec(id, "crontab -l 2>/dev/null || true");
  const updated = (existing.trimEnd() + "\n" + newLine + "\n").trimStart();
  const escaped = updated.replace(/'/g, "'\\''");
  await targetExec(id, `echo '${escaped}' | crontab -`);

  return json({ ok: true });
});

export const DELETE = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole(req, "ENGINEER");
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const command = url.searchParams.get("command");

  if (!command) return json({ error: "command param required" }, { status: 400 });

  const { stdout: existing } = await targetExec(id, "crontab -l 2>/dev/null || true");
  const lines = existing.split("\n");
  const escaped_cmd = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Remove the matching command line and any preceding comment line
  const filtered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(escaped_cmd).test(line) && !line.trimStart().startsWith("#")) {
      // Also remove preceding comment if it was added by us
      if (filtered.length > 0 && filtered[filtered.length - 1].trimStart().startsWith("#")) {
        filtered.pop();
      }
      continue;
    }
    filtered.push(line);
  }

  const updated = filtered.join("\n").trim() + "\n";
  const escaped = updated.replace(/'/g, "'\\''");
  await targetExec(id, `echo '${escaped}' | crontab -`);

  return json({ ok: true });
});
