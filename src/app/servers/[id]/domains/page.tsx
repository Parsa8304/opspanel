"use client";
import useSWR from "swr";
import { useState } from "react";
import { useParams } from "next/navigation";
import { fetcher } from "@/lib/fetcher";
import { PageHeader } from "@/components/Shell";
import { Globe, ShieldCheck, ShieldAlert, ShieldX, RefreshCw, Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";

type SslStatus = "UNKNOWN" | "VALID" | "EXPIRING_SOON" | "EXPIRED" | "INVALID";
type DnsStatus = "UNKNOWN" | "OK" | "MISMATCH" | "UNREACHABLE";

interface Domain {
  id: string;
  name: string;
  service: string | null;
  proxyTarget: string | null;
  sslStatus: SslStatus;
  sslExpiry: string | null;
  sslIssuer: string | null;
  sslAutoRenew: boolean;
  dnsStatus: DnsStatus;
  dnsResolvesTo: string | null;
  lastCheckedAt: string | null;
  notes: string | null;
}

const SSL_BADGE: Record<SslStatus, { label: string; bg: string; color: string; icon: React.ReactNode }> = {
  VALID:         { label: "Valid",          bg: "rgba(16,185,129,.15)", color: "#10b981", icon: <ShieldCheck size={12} /> },
  EXPIRING_SOON: { label: "Expiring soon",  bg: "rgba(245,158,11,.15)", color: "#f59e0b", icon: <ShieldAlert size={12} /> },
  EXPIRED:       { label: "Expired",        bg: "rgba(239,68,68,.15)",  color: "#ef4444", icon: <ShieldX size={12} /> },
  INVALID:       { label: "Invalid",        bg: "rgba(239,68,68,.15)",  color: "#ef4444", icon: <ShieldX size={12} /> },
  UNKNOWN:       { label: "Unknown",        bg: "rgba(107,114,128,.15)",color: "#6b7280", icon: <ShieldCheck size={12} /> },
};

const DNS_BADGE: Record<DnsStatus, { label: string; color: string }> = {
  OK:          { label: "OK",          color: "#10b981" },
  MISMATCH:    { label: "Mismatch",    color: "#f59e0b" },
  UNREACHABLE: { label: "Unreachable", color: "#ef4444" },
  UNKNOWN:     { label: "Unknown",     color: "#6b7280" },
};

function daysUntil(dateStr: string | null): string {
  if (!dateStr) return "—";
  const diff = Math.floor((new Date(dateStr).getTime() - Date.now()) / 86400000);
  if (diff < 0) return `Expired ${Math.abs(diff)}d ago`;
  return `Expires in ${diff}d`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diff < 1) return "Just now";
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

const EMPTY_FORM = { name: "", service: "", proxyTarget: "", sslAutoRenew: false, notes: "" };

export default function ServerDomainsPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data, mutate } = useSWR<Domain[]>(id ? `/api/servers/${id}/domains` : null, fetcher);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const domains = data ?? [];
  const urgent = domains.filter((d) => d.sslStatus === "EXPIRED" || d.sslStatus === "EXPIRING_SOON");

  const sorted = [...domains].sort((a, b) => {
    const order: Record<SslStatus, number> = { EXPIRED: 0, EXPIRING_SOON: 1, INVALID: 2, VALID: 3, UNKNOWN: 4 };
    return order[a.sslStatus] - order[b.sslStatus];
  });

  const openCreate = () => { setForm(EMPTY_FORM); setEditId(null); setShowForm(true); };
  const openEdit = (d: Domain) => {
    setForm({ name: d.name, service: d.service ?? "", proxyTarget: d.proxyTarget ?? "", sslAutoRenew: d.sslAutoRenew, notes: d.notes ?? "" });
    setEditId(d.id);
    setShowForm(true);
  };

  const save = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const body = { ...form, service: form.service || null, proxyTarget: form.proxyTarget || null, notes: form.notes || null };
      if (editId) {
        await fetch(`/api/servers/${id}/domains/${editId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await fetch(`/api/servers/${id}/domains`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      }
      await mutate();
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (domainId: string) => {
    if (!id) return;
    if (!confirm("Delete this domain?")) return;
    await fetch(`/api/servers/${id}/domains/${domainId}`, { method: "DELETE" });
    await mutate();
  };

  const check = async (domainId: string) => {
    if (!id) return;
    setChecking((c) => ({ ...c, [domainId]: true }));
    try {
      await fetch(`/api/servers/${id}/domains/${domainId}/check`, { method: "POST" });
      await mutate();
    } finally {
      setChecking((c) => ({ ...c, [domainId]: false }));
    }
  };

  const card: React.CSSProperties = { background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "12px", padding: "16px" };
  const input: React.CSSProperties = { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "8px", padding: "8px 10px", color: "var(--text-main)", width: "100%", fontSize: "13px" };
  const btn = (bg: string, color = "#fff"): React.CSSProperties => ({ background: bg, color, border: "none", borderRadius: "7px", padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" });

  return (
    <div>
      <PageHeader title="Domains & SSL" desc="Monitor domain DNS, SSL certificate expiry, and reverse proxy configuration — checked from this server." />
      <div className="p-6 space-y-5">

        {urgent.length > 0 && (
          <div style={{ background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)", borderRadius: "10px", padding: "12px 16px", display: "flex", alignItems: "center", gap: "10px" }}>
            <AlertTriangle size={16} color="#ef4444" />
            <span style={{ fontSize: "13px", color: "#ef4444", fontWeight: 600 }}>
              {urgent.length} domain{urgent.length > 1 ? "s" : ""} with SSL issues: {urgent.map((d) => d.name).join(", ")}
            </span>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "14px", color: "var(--text-muted)" }}>{domains.length} domain{domains.length !== 1 ? "s" : ""}</span>
          <button onClick={openCreate} style={btn("var(--primary)")}>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><Plus size={14} /> Add domain</span>
          </button>
        </div>

        {showForm && (
          <div style={{ ...card, borderColor: "var(--primary)" }}>
            <p style={{ fontWeight: 700, marginBottom: "14px", color: "var(--text-main)", fontSize: "14px" }}>
              {editId ? "Edit domain" : "Add domain"}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Domain name *</label>
                <input style={input} placeholder="app.example.com" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Service</label>
                <input style={input} placeholder="panel-app" value={form.service} onChange={(e) => setForm((f) => ({ ...f, service: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Proxy target</label>
                <input style={input} placeholder="http://localhost:3000" value={form.proxyTarget} onChange={(e) => setForm((f) => ({ ...f, proxyTarget: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: "11px", color: "var(--text-muted)", display: "block", marginBottom: "4px" }}>Notes</label>
                <input style={input} placeholder="Optional notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px" }}>
              <input type="checkbox" id="ssl-auto" checked={form.sslAutoRenew} onChange={(e) => setForm((f) => ({ ...f, sslAutoRenew: e.target.checked }))} />
              <label htmlFor="ssl-auto" style={{ fontSize: "12px", color: "var(--text-muted)" }}>SSL auto-renew</label>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
              <button onClick={save} disabled={saving || !form.name} style={btn("var(--primary)")}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => setShowForm(false)} style={btn("transparent", "var(--text-muted)")}>Cancel</button>
            </div>
          </div>
        )}

        {sorted.length === 0 && !showForm && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)", fontSize: "14px" }}>
            No domains configured yet. Add your first domain above.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "14px" }}>
          {sorted.map((d) => {
            const ssl = SSL_BADGE[d.sslStatus];
            const dns_ = DNS_BADGE[d.dnsStatus];
            return (
              <div key={d.id} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Globe size={16} color="var(--text-muted)" />
                    <span style={{ fontWeight: 700, fontSize: "15px", color: "var(--text-main)" }}>{d.name}</span>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button onClick={() => check(d.id)} disabled={checking[d.id]} title="Check now" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "2px" }}>
                      <RefreshCw size={14} style={checking[d.id] ? { animation: "spin 1s linear infinite" } : {}} />
                    </button>
                    <button onClick={() => openEdit(d)} title="Edit" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "2px" }}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => remove(d.id)} title="Delete" style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: "2px" }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {(d.service || d.proxyTarget) && (
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "10px" }}>
                    {d.service && <span>{d.service}</span>}
                    {d.service && d.proxyTarget && <span style={{ margin: "0 6px" }}>→</span>}
                    {d.proxyTarget && <span>{d.proxyTarget}</span>}
                  </p>
                )}

                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", background: ssl.bg, color: ssl.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px", fontWeight: 600 }}>
                    {ssl.icon} SSL: {ssl.label}
                  </span>
                  <span style={{ background: `${dns_.color}22`, color: dns_.color, borderRadius: "6px", padding: "3px 8px", fontSize: "11px", fontWeight: 600 }}>
                    DNS: {dns_.label}
                  </span>
                </div>

                <div style={{ fontSize: "12px", color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span>{daysUntil(d.sslExpiry)}{d.sslIssuer ? ` · ${d.sslIssuer}` : ""}</span>
                  {d.dnsResolvesTo && <span>Resolves to {d.dnsResolvesTo}</span>}
                  <span>Last checked: {timeAgo(d.lastCheckedAt)}</span>
                  {d.sslAutoRenew && <span style={{ color: "#10b981" }}>Auto-renew enabled</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
