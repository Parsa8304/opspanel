"use client";
import useSWR from "swr";
import { useState } from "react";
import { useParams } from "next/navigation";
import { fetcher } from "@/lib/fetcher";
import { PageHeader } from "@/components/Shell";
import { Clock, Plus, Trash2, RefreshCw, Terminal, Info } from "lucide-react";

interface CronEntry {
  id: string;
  source: string;
  schedule: string;
  user: string | null;
  command: string;
  comment: string | null;
  enabled: boolean;
}

const CRON_PRESETS = [
  { label: "Every minute",    value: "* * * * *" },
  { label: "Every 5 min",     value: "*/5 * * * *" },
  { label: "Every hour",      value: "0 * * * *" },
  { label: "Daily at 2am",    value: "0 2 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekly (Sun 3am)", value: "0 3 * * 0" },
  { label: "Monthly (1st)",   value: "0 0 1 * *" },
];

function scheduleHuman(s: string): string {
  const match = CRON_PRESETS.find((p) => p.value === s);
  if (match) return match.label;
  const parts = s.split(" ");
  if (parts.length !== 5) return s;
  const [min, hour, dom, , dow] = parts;
  if (min === "*" && hour === "*") return "Every minute";
  if (min.startsWith("*/")) return `Every ${min.slice(2)}min`;
  if (dom === "*" && dow === "*") return `Daily ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  return s;
}

function sourceColor(source: string): string {
  if (source === "root crontab") return "#60a5fa";
  if (source === "/etc/crontab") return "#a78bfa";
  return "#fb923c";
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  padding: "14px 16px",
};

const input: React.CSSProperties = {
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: "7px",
  padding: "7px 10px",
  color: "var(--text-main)",
  fontSize: "13px",
  width: "100%",
  outline: "none",
};

export default function ServerCronsPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, mutate, isLoading } = useSWR<{ entries: CronEntry[] }>(
    id ? `/api/servers/${id}/crons` : null,
    fetcher
  );
  const [showForm, setShowForm] = useState(false);
  const [schedule, setSchedule] = useState("0 2 * * *");
  const [command, setCommand] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const entries = data?.entries ?? [];
  const systemEntries = entries.filter((e) => e.source !== "root crontab");
  const myEntries = entries.filter((e) => e.source === "root crontab");

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!schedule.trim() || !command.trim() || !id) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/servers/${id}/crons`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedule: schedule.trim(), command: command.trim(), comment: comment.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed");
      }
      setCommand(""); setComment(""); setShowForm(false);
      await mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(cmd: string) {
    if (!id) return;
    if (!confirm("Remove this cron entry from root crontab?")) return;
    setDeleting(cmd);
    try {
      const res = await fetch(`/api/servers/${id}/crons?command=${encodeURIComponent(cmd)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      await mutate();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      <PageHeader title="Cron Jobs" desc="View system-level scheduled tasks and manage root crontab entries." />
      <div className="p-6 space-y-6">

        {/* Toolbar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            {entries.length} entr{entries.length !== 1 ? "ies" : "y"} across all sources
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => mutate()}
              style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "7px", color: "var(--text-muted)", padding: "6px 12px", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              onClick={() => setShowForm((v) => !v)}
              style={{ background: "var(--primary)", color: "var(--accent)", border: "none", borderRadius: "7px", padding: "6px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <Plus size={13} /> Add entry
            </button>
          </div>
        </div>

        {/* Add form */}
        {showForm && (
          <form onSubmit={submit} style={{ ...card, borderColor: "var(--primary)" }}>
            <p style={{ fontWeight: 700, fontSize: "13px", color: "var(--text-main)", marginBottom: "12px" }}>
              New cron entry (added to root crontab)
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px", marginBottom: "10px" }}>
              <div>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Schedule (5 fields)</label>
                <input
                  list="cron-presets"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="0 2 * * *"
                  style={{ ...input, fontFamily: "monospace" }}
                />
                <datalist id="cron-presets">
                  {CRON_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </datalist>
              </div>
              <div>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Command *</label>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="/usr/local/bin/backup.sh >> /var/log/backup.log 2>&1"
                  style={{ ...input, fontFamily: "monospace" }}
                />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Comment (optional)</label>
                <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Daily backup job" style={input} />
              </div>
            </div>
            {schedule && (
              <p style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "10px" }}>
                → {scheduleHuman(schedule)}
              </p>
            )}
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <button type="submit" disabled={saving || !command.trim()} style={{ background: "var(--primary)", color: "var(--accent)", border: "none", borderRadius: "7px", padding: "7px 16px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                {saving ? "Adding…" : "Add"}
              </button>
              <button type="button" onClick={() => setShowForm(false)} style={{ background: "transparent", color: "var(--text-muted)", border: "none", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
              {err && <span style={{ fontSize: "12px", color: "var(--danger)" }}>{err}</span>}
            </div>
          </form>
        )}

        {isLoading && (
          <div style={{ textAlign: "center", padding: "40px", color: "var(--text-muted)", fontSize: "13px" }}>Loading crontabs…</div>
        )}

        {/* Managed (root crontab) */}
        {myEntries.length > 0 && (
          <section>
            <h2 style={{ fontSize: "12px", fontWeight: 700, color: "#60a5fa", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "10px" }}>
              Root crontab — managed
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {myEntries.map((e) => (
                <EntryRow key={e.id} entry={e} canDelete onDelete={() => remove(e.command)} deleting={deleting === e.command} />
              ))}
            </div>
          </section>
        )}

        {/* System crontabs (read-only) */}
        {systemEntries.length > 0 && (
          <section>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" }}>
              <h2 style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: 0 }}>
                System crontabs — read-only
              </h2>
              <span title="From /etc/crontab and /etc/cron.d/*"><Info size={12} color="var(--text-muted)" /></span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {systemEntries.map((e) => (
                <EntryRow key={e.id} entry={e} canDelete={false} onDelete={() => {}} deleting={false} />
              ))}
            </div>
          </section>
        )}

        {!isLoading && entries.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px", color: "var(--text-muted)", fontSize: "14px", border: "1px dashed var(--border)", borderRadius: "10px" }}>
            No cron entries found. Add the first one above.
          </div>
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  canDelete,
  onDelete,
  deleting,
}: {
  entry: CronEntry;
  canDelete: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const color = sourceColor(entry.source);
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${color}`,
        borderRadius: "8px",
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <Clock size={14} color={color} style={{ flexShrink: 0 }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <code style={{ fontSize: "12px", fontFamily: "monospace", color: color, background: `${color}18`, padding: "2px 7px", borderRadius: "5px" }}>
            {entry.schedule}
          </code>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {scheduleHuman(entry.schedule)}
          </span>
          {entry.user && (
            <span style={{ fontSize: "11px", color: "var(--text-muted)", background: "var(--bg-panel)", padding: "1px 6px", borderRadius: "4px" }}>
              {entry.user}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "5px" }}>
          <Terminal size={11} color="var(--text-muted)" />
          <code style={{ fontSize: "12px", fontFamily: "monospace", color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "500px" }}>
            {entry.command}
          </code>
        </div>
        {entry.comment && (
          <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "4px 0 0", fontStyle: "italic" }}>
            {entry.comment}
          </p>
        )}
      </div>

      <span style={{ fontSize: "10px", color: `${color}cc`, background: `${color}12`, padding: "2px 8px", borderRadius: "5px", flexShrink: 0, maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {entry.source}
      </span>

      {canDelete && (
        <button
          onClick={onDelete}
          disabled={deleting}
          title="Remove from crontab"
          style={{ background: "none", border: "none", cursor: deleting ? "not-allowed" : "pointer", color: "var(--danger)", padding: "2px", flexShrink: 0, opacity: deleting ? 0.4 : 1 }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}
