"use client";
import { useState } from "react";
import useSWR from "swr";
import { useParams } from "next/navigation";
import { PageHeader, EmptyState } from "@/components/Shell";
import { fetcher } from "@/lib/fetcher";
import {
  Database,
  HardDrive,
  Settings,
  Upload,
  Layers,
  Plus,
  RefreshCw,
  Clock,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Calendar,
  Server,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type BackupStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "EXPIRED";
type BackupTargetKind = "DATABASE" | "VOLUME" | "CONFIG" | "UPLOAD" | "FULL";

type BackupJob = {
  id: string;
  scheduleId: string | null;
  schedule: { id: string; name: string } | null;
  targetKind: BackupTargetKind;
  targetRef: string;
  status: BackupStatus;
  sizeBytes: string | null;
  path: string | null;
  destination: string;
  log: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  triggeredById: string | null;
  createdAt: string;
};

type BackupSchedule = {
  id: string;
  name: string;
  targetKind: BackupTargetKind;
  targetRef: string;
  cronExpr: string;
  retainDays: number;
  destination: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  _count: { jobs: number };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function api(url: string, method: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = "Request failed";
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function fmtBytes(bytes: string | null): string {
  if (!bytes) return "—";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BackupStatus }) {
  const configs: Record<BackupStatus, { bg: string; color: string; label: string }> = {
    PENDING:  { bg: "rgba(100,116,139,0.18)", color: "var(--text-muted)", label: "Pending" },
    RUNNING:  { bg: "rgba(234,179,8,0.18)",   color: "#eab308",           label: "Running" },
    SUCCESS:  { bg: "rgba(34,197,94,0.18)",   color: "var(--success)",    label: "Success" },
    FAILED:   { bg: "rgba(239,68,68,0.18)",   color: "var(--danger)",     label: "Failed"  },
    EXPIRED:  { bg: "rgba(100,116,139,0.12)", color: "var(--text-muted)", label: "Expired" },
  };
  const { bg, color, label } = configs[status] ?? configs.PENDING;
  return (
    <span
      style={{
        background: bg,
        color,
        border: `1px solid ${color}33`,
        borderRadius: "6px",
        padding: "2px 8px",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ─── Kind Badge ───────────────────────────────────────────────────────────────

const KIND_ICON: Record<BackupTargetKind, React.ReactNode> = {
  DATABASE: <Database size={11} />,
  VOLUME:   <HardDrive size={11} />,
  CONFIG:   <Settings size={11} />,
  UPLOAD:   <Upload size={11} />,
  FULL:     <Layers size={11} />,
};

const KIND_STYLE: Record<BackupTargetKind, { bg: string; color: string }> = {
  DATABASE: { bg: "rgba(59,130,246,0.18)",  color: "#60a5fa"  },
  VOLUME:   { bg: "rgba(139,92,246,0.18)",  color: "#a78bfa"  },
  CONFIG:   { bg: "rgba(249,115,22,0.18)",  color: "#fb923c"  },
  UPLOAD:   { bg: "rgba(20,184,166,0.18)",  color: "#2dd4bf"  },
  FULL:     { bg: "rgba(100,116,139,0.18)", color: "#94a3b8"  },
};

function KindBadge({ kind }: { kind: BackupTargetKind }) {
  const { bg, color } = KIND_STYLE[kind] ?? KIND_STYLE.FULL;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        background: bg,
        color,
        border: `1px solid ${color}33`,
        borderRadius: "6px",
        padding: "2px 8px",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {KIND_ICON[kind]}
      {kind}
    </span>
  );
}

// ─── New Backup Form ──────────────────────────────────────────────────────────

function NewBackupForm({
  serverId,
  onCreated,
  initialKind,
  initialRef,
}: {
  serverId: string;
  onCreated: () => void;
  initialKind?: BackupTargetKind;
  initialRef?: string;
}) {
  const [kind, setKind] = useState<BackupTargetKind>(initialKind ?? "DATABASE");
  const [ref, setRef] = useState(initialRef ?? "");
  const [dest, setDest] = useState("local");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ref.trim()) { setErr("Target ref is required"); return; }
    setLoading(true);
    setErr(null);
    try {
      await api(`/api/servers/${serverId}/backup/jobs`, "POST", { targetKind: kind, targetRef: ref.trim(), destination: dest });
      setRef("");
      onCreated();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        padding: "16px",
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        alignItems: "flex-end",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>
          Target kind
        </label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as BackupTargetKind)}
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            color: "var(--text-main)",
            padding: "6px 10px",
            fontSize: "13px",
            outline: "none",
            minWidth: "130px",
          }}
        >
          {(["DATABASE","VOLUME","CONFIG","UPLOAD","FULL"] as BackupTargetKind[]).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "160px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>
          Target ref
        </label>
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="e.g. postgres, my_volume, /etc/app"
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            color: "var(--text-main)",
            padding: "6px 10px",
            fontSize: "13px",
            outline: "none",
            width: "100%",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>
          Destination
        </label>
        <select
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            color: "var(--text-main)",
            padding: "6px 10px",
            fontSize: "13px",
            outline: "none",
            minWidth: "100px",
          }}
        >
          <option value="local">local</option>
          <option value="s3">s3</option>
        </select>
      </div>

      <button
        type="submit"
        disabled={loading}
        style={{
          background: "var(--primary)",
          color: "var(--accent)",
          border: "none",
          borderRadius: "6px",
          padding: "7px 16px",
          fontSize: "13px",
          fontWeight: 600,
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.7 : 1,
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <Plus size={13} />
        {loading ? "Creating…" : "Create backup"}
      </button>

      {err && (
        <p style={{ width: "100%", fontSize: "12px", color: "var(--danger)", margin: 0 }}>
          {err}
        </p>
      )}
    </form>
  );
}

// ─── New Schedule Form ────────────────────────────────────────────────────────

function NewScheduleForm({ serverId, onCreated }: { serverId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BackupTargetKind>("DATABASE");
  const [ref, setRef] = useState("");
  const [cron, setCron] = useState("0 2 * * *");
  const [retain, setRetain] = useState(7);
  const [dest, setDest] = useState("local");
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name is required"); return; }
    if (!ref.trim())  { setErr("Target ref is required"); return; }
    if (!cron.trim()) { setErr("Cron expression is required"); return; }
    setLoading(true);
    setErr(null);
    try {
      await api(`/api/servers/${serverId}/backup/schedules`, "POST", {
        name: name.trim(),
        targetKind: kind,
        targetRef: ref.trim(),
        cronExpr: cron.trim(),
        retainDays: retain,
        destination: dest,
        enabled,
      });
      setName(""); setRef(""); setCron("0 2 * * *"); setRetain(7);
      onCreated();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        padding: "16px",
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        alignItems: "flex-end",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "140px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily DB backup"
          style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-main)", padding: "6px 10px", fontSize: "13px", outline: "none", width: "100%",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Kind</label>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as BackupTargetKind)}
          style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-main)", padding: "6px 10px", fontSize: "13px", outline: "none", minWidth: "120px",
          }}
        >
          {(["DATABASE","VOLUME","CONFIG","UPLOAD","FULL"] as BackupTargetKind[]).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "140px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Target ref</label>
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="e.g. postgres"
          style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-main)", padding: "6px 10px", fontSize: "13px", outline: "none", width: "100%",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "140px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Cron expression</label>
        <input
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 2 * * *"
          style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-main)", padding: "6px 10px", fontSize: "13px", outline: "none", width: "100%",
            fontFamily: "monospace",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "80px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Retain (days)</label>
        <input
          type="number"
          value={retain}
          min={1}
          onChange={(e) => setRetain(Number(e.target.value))}
          style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-main)", padding: "6px 10px", fontSize: "13px", outline: "none", width: "100%",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Destination</label>
        <select
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          style={{
            background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-main)", padding: "6px 10px", fontSize: "13px", outline: "none", minWidth: "90px",
          }}
        >
          <option value="local">local</option>
          <option value="s3">s3</option>
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 500 }}>Enabled</label>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          style={{
            background: "transparent",
            border: "none",
            padding: "4px 0",
            cursor: "pointer",
            color: enabled ? "var(--success)" : "var(--text-muted)",
            display: "flex",
            alignItems: "center",
          }}
        >
          {enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
        </button>
      </div>

      <button
        type="submit"
        disabled={loading}
        style={{
          background: "var(--primary)",
          color: "var(--accent)",
          border: "none",
          borderRadius: "6px",
          padding: "7px 16px",
          fontSize: "13px",
          fontWeight: 600,
          cursor: loading ? "not-allowed" : "pointer",
          opacity: loading ? 0.7 : 1,
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <Plus size={13} />
        {loading ? "Saving…" : "Add schedule"}
      </button>

      {err && (
        <p style={{ width: "100%", fontSize: "12px", color: "var(--danger)", margin: 0 }}>{err}</p>
      )}
    </form>
  );
}

// ─── Schedule Card ─────────────────────────────────────────────────────────────

function ScheduleCard({
  serverId,
  schedule,
  onToggle,
  onDelete,
}: {
  serverId: string;
  schedule: BackupSchedule;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`Delete schedule "${schedule.name}"? Associated jobs will be kept.`)) return;
    setDeleting(true);
    try {
      await api(`/api/servers/${serverId}/backup/schedules/${schedule.id}`, "DELETE");
      onDelete(schedule.id);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "12px",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: "14px", color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {schedule.name}
          </p>
          <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--text-muted)" }}>
            {schedule.targetRef}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <KindBadge kind={schedule.targetKind} />
          <button
            onClick={() => onToggle(schedule.id, !schedule.enabled)}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: schedule.enabled ? "var(--success)" : "var(--text-muted)",
              padding: "0",
              display: "flex",
              alignItems: "center",
            }}
            title={schedule.enabled ? "Disable schedule" : "Enable schedule"}
          >
            {schedule.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              background: "transparent",
              border: "none",
              cursor: deleting ? "not-allowed" : "pointer",
              color: "var(--danger)",
              padding: "0",
              display: "flex",
              alignItems: "center",
              opacity: deleting ? 0.5 : 1,
            }}
            title="Delete schedule"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Meta grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "8px" }}>
        <MetaCell icon={<Calendar size={12} />} label="Cron" value={<code style={{ fontFamily: "monospace", fontSize: "12px" }}>{schedule.cronExpr}</code>} />
        <MetaCell icon={<Clock size={12} />} label="Retain" value={`${schedule.retainDays} days`} />
        <MetaCell icon={<Server size={12} />} label="Destination" value={schedule.destination} />
        <MetaCell icon={<RefreshCw size={12} />} label="Jobs run" value={String(schedule._count.jobs)} />
        <MetaCell icon={<Clock size={12} />} label="Last run" value={schedule.lastRunAt ? new Date(schedule.lastRunAt!).toLocaleString() : "never"} />
        <MetaCell icon={<Clock size={12} />} label="Next run" value={schedule.nextRunAt ? new Date(schedule.nextRunAt!).toLocaleString() : "—"} />
      </div>

      {!schedule.enabled && (
        <span style={{ fontSize: "11px", color: "var(--warning)", fontStyle: "italic" }}>
          Schedule is disabled — no automatic runs until re-enabled.
        </span>
      )}
    </div>
  );
}

function MetaCell({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "10px", color: "var(--text-muted)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {icon} {label}
      </span>
      <span style={{ fontSize: "12px", color: "var(--text-main)" }}>{value}</span>
    </div>
  );
}

// ─── Jobs Tab ─────────────────────────────────────────────────────────────────

function JobsTab({
  serverId,
  prefilledKind,
  prefilledRef,
  onConsumed,
}: {
  serverId: string;
  prefilledKind?: BackupTargetKind;
  prefilledRef?: string;
  onConsumed?: () => void;
}) {
  const { data: jobs, mutate, isLoading } = useSWR<BackupJob[]>(`/api/servers/${serverId}/backup/jobs`, fetcher);
  const [showForm, setShowForm] = useState(!!prefilledKind);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
          {jobs ? `${jobs.length} job${jobs.length !== 1 ? "s" : ""}` : "Loading…"}
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => mutate()}
            style={{
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "6px",
              color: "var(--text-muted)", padding: "5px 10px", fontSize: "12px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "5px",
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            onClick={() => setShowForm((v) => !v)}
            style={{
              background: "var(--primary)", color: "var(--accent)", border: "none", borderRadius: "6px",
              padding: "5px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", gap: "5px",
            }}
          >
            <Plus size={12} /> New backup
          </button>
        </div>
      </div>

      {/* Inline new backup form */}
      {showForm && (
        <NewBackupForm
          serverId={serverId}
          initialKind={prefilledKind}
          initialRef={prefilledRef}
          onCreated={() => { setShowForm(false); onConsumed?.(); mutate(); }}
        />
      )}

      {/* Jobs table */}
      {isLoading && (
        <div style={{ padding: "32px", textAlign: "center", fontSize: "13px", color: "var(--text-muted)" }}>
          Loading jobs…
        </div>
      )}

      {!isLoading && (!jobs || jobs.length === 0) && (
        <EmptyState msg="No backup jobs yet. Click 'New backup' to create the first one." />
      )}

      {!isLoading && jobs && jobs.length > 0 && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Target", "Kind", "Status", "Size", "Destination", "Started", "Duration"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "10px 14px",
                        textAlign: "left",
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => (
                  <tr
                    key={job.id}
                    style={{
                      borderBottom: i < jobs.length - 1 ? "1px solid var(--border)" : "none",
                      background: "transparent",
                    }}
                  >
                    <td style={{ padding: "10px 14px" }}>
                      <div>
                        <span style={{ fontSize: "13px", color: "var(--text-main)", fontWeight: 500 }}>
                          {job.targetRef}
                        </span>
                        {job.schedule && (
                          <span style={{ display: "block", fontSize: "11px", color: "var(--text-muted)" }}>
                            via {job.schedule.name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <KindBadge kind={job.targetKind} />
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <StatusBadge status={job.status} />
                      {job.error && (
                        <p style={{ margin: "3px 0 0", fontSize: "11px", color: "var(--danger)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {job.error}
                        </p>
                      )}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {fmtBytes(job.sizeBytes)}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-muted)" }}>
                      {job.destination}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {job.startedAt ? new Date(job.startedAt).toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: "12px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {fmtDuration(job.startedAt, job.finishedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Schedules Tab ────────────────────────────────────────────────────────────

function SchedulesTab({ serverId }: { serverId: string }) {
  const { data: schedules, mutate, isLoading } = useSWR<BackupSchedule[]>(`/api/servers/${serverId}/backup/schedules`, fetcher);
  const [showForm, setShowForm] = useState(false);

  async function handleToggle(id: string, enabled: boolean) {
    await api(`/api/servers/${serverId}/backup/schedules/${id}`, "PATCH", { enabled });
    mutate();
  }

  function handleDelete(id: string) {
    mutate((prev) => prev?.filter((s) => s.id !== id), false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>
          {schedules ? `${schedules.length} schedule${schedules.length !== 1 ? "s" : ""}` : "Loading…"}
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => mutate()}
            style={{
              background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "6px",
              color: "var(--text-muted)", padding: "5px 10px", fontSize: "12px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "5px",
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            onClick={() => setShowForm((v) => !v)}
            style={{
              background: "var(--primary)", color: "var(--accent)", border: "none", borderRadius: "6px",
              padding: "5px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", gap: "5px",
            }}
          >
            <Plus size={12} /> Add schedule
          </button>
        </div>
      </div>

      {/* Inline add schedule form */}
      {showForm && (
        <NewScheduleForm serverId={serverId} onCreated={() => { setShowForm(false); mutate(); }} />
      )}

      {/* Cards */}
      {isLoading && (
        <div style={{ padding: "32px", textAlign: "center", fontSize: "13px", color: "var(--text-muted)" }}>
          Loading schedules…
        </div>
      )}

      {!isLoading && (!schedules || schedules.length === 0) && (
        <EmptyState msg="No backup schedules configured. Click 'Add schedule' to automate backups." />
      )}

      {!isLoading && schedules && schedules.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {schedules.map((s) => (
            <ScheduleCard
              key={s.id}
              serverId={serverId}
              schedule={s}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Discovered Tab ───────────────────────────────────────────────────────────

interface DiscoveredData {
  dbContainers: { id: string; name: string; image: string; tag: string; state: string; dbType: string }[];
  allContainers: { id: string; name: string; image: string; tag: string; state: string }[];
  volumes: { name: string; driver: string; mountpoint: string; createdAt: string; inUse: boolean }[];
}

function DiscoveredTab({ serverId, onBackupNow }: { serverId: string; onBackupNow: (kind: BackupTargetKind, ref: string) => void }) {
  const { data, isLoading, mutate } = useSWR<DiscoveredData>(`/api/servers/${serverId}/backup/discovered`, fetcher);

  if (isLoading) return (
    <div style={{ padding: "40px", textAlign: "center", fontSize: "13px", color: "var(--text-muted)" }}>
      Scanning Docker…
    </div>
  );

  if (!data) return <EmptyState msg="Could not reach Docker." />;

  const row: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 14px", borderBottom: "1px solid var(--border)", gap: "12px",
  };
  const btn = (bg: string, color = "#fff"): React.CSSProperties => ({
    background: bg, color, border: "none", borderRadius: "6px",
    padding: "4px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer", flexShrink: 0,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => mutate()} style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text-muted)", padding: "5px 10px", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* DB Containers */}
      <div>
        <p style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#60a5fa", marginBottom: "8px" }}>
          Database containers ({data.dbContainers.length})
        </p>
        {data.dbContainers.length === 0 ? (
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>No database containers found.</p>
        ) : (
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
            {data.dbContainers.map((c, i) => (
              <div key={c.id} style={{ ...row, borderBottom: i < data.dbContainers.length - 1 ? "1px solid var(--border)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                  <Database size={14} color="#60a5fa" />
                  <div>
                    <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-main)" }}>{c.name}</span>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "8px" }}>{c.image}:{c.tag}</span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "11px", color: c.state === "running" ? "var(--success)" : "var(--text-muted)" }}>
                    {c.state}
                  </span>
                  <button onClick={() => onBackupNow("DATABASE", c.name)} style={btn("var(--primary)")}>
                    Back up now
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Volumes */}
      <div>
        <p style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#a78bfa", marginBottom: "8px" }}>
          Docker volumes ({data.volumes.length})
        </p>
        {data.volumes.length === 0 ? (
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>No volumes found.</p>
        ) : (
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "10px", overflow: "hidden" }}>
            {data.volumes.map((v, i) => (
              <div key={v.name} style={{ ...row, borderBottom: i < data.volumes.length - 1 ? "1px solid var(--border)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                  <HardDrive size={14} color="#a78bfa" />
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text-main)" }}>{v.name}</span>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "8px" }}>{v.driver}</span>
                    {v.inUse && (
                      <span style={{ fontSize: "10px", color: "#10b981", background: "rgba(16,185,129,.12)", borderRadius: "4px", padding: "1px 5px", marginLeft: "6px" }}>in use</span>
                    )}
                  </div>
                </div>
                <button onClick={() => onBackupNow("VOLUME", v.name)} style={btn("#7c3aed")}>
                  Back up now
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = "jobs" | "schedules" | "discovered";

export default function ServerBackupPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [tab, setTab] = useState<Tab>("jobs");
  const [quickBackup, setQuickBackup] = useState<{ kind: BackupTargetKind; ref: string } | null>(null);

  const tabs: { key: Tab; label: string }[] = [
    { key: "jobs",       label: "Jobs"       },
    { key: "schedules",  label: "Schedules"  },
    { key: "discovered", label: "Discovered" },
  ];

  function handleBackupNow(kind: BackupTargetKind, ref: string) {
    setQuickBackup({ kind, ref });
    setTab("jobs");
  }

  if (!id) return null;

  return (
    <div>
      <PageHeader
        title="Backup & Restore"
        desc="Schedule and trigger backups for databases, volumes, configs and uploads. Monitor job status and manage retention."
      />

      <div className="p-6 space-y-6">
        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            gap: "2px",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "3px",
            width: "fit-content",
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                background: tab === t.key ? "var(--bg-card)" : "transparent",
                color: tab === t.key ? "var(--text-main)" : "var(--text-muted)",
                border: tab === t.key ? "1px solid var(--border)" : "1px solid transparent",
                borderRadius: "6px",
                padding: "5px 18px",
                fontSize: "13px",
                fontWeight: tab === t.key ? 600 : 400,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === "jobs"       && <JobsTab serverId={id} prefilledKind={quickBackup?.kind} prefilledRef={quickBackup?.ref} onConsumed={() => setQuickBackup(null)} />}
        {tab === "schedules"  && <SchedulesTab serverId={id} />}
        {tab === "discovered" && <DiscoveredTab serverId={id} onBackupNow={handleBackupNow} />}
      </div>
    </div>
  );
}
