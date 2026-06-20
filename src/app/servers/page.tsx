"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { fetcher } from "@/lib/fetcher";
import {
  RefreshCw, Plus, Trash2, Plug,
  ChevronDown, ChevronRight, Server as ServerIcon, ArrowRight,
} from "lucide-react";

interface RemoteServer {
  id: string; name: string; host: string; port: number; sshUser: string;
  fingerprint: string | null; tags: string[];
  lastOkAt: string | null; lastError: string | null;
  createdAt: string;
}

// ─── Add server form ─────────────────────────────────────────────────────────

function AddServerForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", host: "", port: "22", sshUser: "root", privateKey: "", passphrase: "", tags: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name, host: form.host, port: Number(form.port) || 22,
        sshUser: form.sshUser, privateKey: form.privateKey,
        passphrase: form.passphrase || undefined,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      }),
    });
    const body = await res.json();
    setSaving(false);
    if (!res.ok) { setError(body.error || "Failed to add server"); return; }
    setForm({ name: "", host: "", port: "22", sshUser: "root", privateKey: "", passphrase: "", tags: "" });
    setOpen(false);
    onAdded();
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-medium"
      >
        <span className="flex items-center gap-2"><Plus size={14} /> Add server</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-sm" />
            <input placeholder="Tags (comma separated)" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })}
              className="bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-sm" />
            <input placeholder="Host / IP" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })}
              className="bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-sm" />
            <div className="flex gap-2">
              <input placeholder="Port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })}
                className="w-20 bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-sm" />
              <input placeholder="SSH user" value={form.sshUser} onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
                className="flex-1 bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-sm" />
            </div>
          </div>
          <textarea
            placeholder="Private key (PEM, e.g. contents of id_ed25519) — stored encrypted"
            value={form.privateKey}
            onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
            rows={5}
            className="w-full bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono"
          />
          <input placeholder="Passphrase (optional)" type="password" value={form.passphrase}
            onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
            className="w-full bg-transparent border border-zinc-700 rounded px-2 py-1.5 text-sm" />

          {error && <div className="text-xs text-red-400">{error}</div>}

          <div className="flex items-center gap-3">
            <button
              onClick={submit}
              disabled={saving || !form.name || !form.host || !form.sshUser || !form.privateKey}
              className="flex items-center gap-1.5 bg-[#09637E] hover:bg-[#088395] text-white rounded px-3 py-1.5 text-xs disabled:opacity-50"
            >
              <Plus size={12} /> {saving ? "Adding…" : "Add server"}
            </button>
            <span className="text-xs text-zinc-500">Key never leaves the server unencrypted; it's stored with AES-256-GCM.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ServersPage() {
  useUI();
  const { data, mutate, isLoading } = useSWR<{ servers: RemoteServer[] }>("/api/servers", fetcher);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  async function testServer(id: string) {
    setTesting(id);
    const res = await fetch(`/api/servers/${id}/test`, { method: "POST" });
    const body = await res.json();
    setTesting(null);
    setTestResult((prev) => ({ ...prev, [id]: body }));
    mutate();
  }

  async function deleteServer(id: string, name: string) {
    if (!confirm(`Remove server "${name}"? This deletes its stored credentials.`)) return;
    await fetch(`/api/servers/${id}`, { method: "DELETE" });
    mutate();
  }

  return (
    <div>
      <PageHeader
        title="Remote Servers"
        desc="Register SSH access to other servers to monitor and run commands on them from this panel."
      />

      <div className="p-6 space-y-6">
        <AddServerForm onAdded={mutate} />

        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium flex items-center justify-between">
            <span className="flex items-center gap-1.5"><ServerIcon size={13} /> Registered servers</span>
            <button onClick={() => mutate()} className="text-zinc-400 hover:text-zinc-200 p-1 rounded">
              <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
            </button>
          </div>

          {!data || data.servers.length === 0 ? (
            <div className="px-4 py-6 text-sm text-zinc-500">No servers registered yet.</div>
          ) : (
            <div>
              {data.servers.map((s) => {
                const result = testResult[s.id];
                return (
                  <div key={s.id} className="border-b border-zinc-100 dark:border-zinc-900 last:border-0">
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <Link href={`/servers/${s.id}`} className="flex-1 min-w-0 group">
                        <div className="text-sm font-medium flex items-center gap-2 group-hover:text-emerald-400">
                          {s.name}
                          {s.tags.map((t) => (
                            <span key={t} className="text-[10px] uppercase tracking-wide text-zinc-500 border border-zinc-700 rounded px-1">{t}</span>
                          ))}
                        </div>
                        <div className="text-xs text-zinc-500 font-mono">
                          {s.id === "local" ? "local machine" : `${s.sshUser}@${s.host}:${s.port}`}
                        </div>
                      </Link>
                      <div className="text-xs text-zinc-500 w-44 shrink-0">
                        {result ? (
                          <span className={result.ok ? "text-emerald-400" : "text-red-400"}>
                            {result.ok ? "OK: " : "Failed: "}{result.message.slice(0, 40)}
                          </span>
                        ) : s.lastOkAt ? (
                          <span className="text-emerald-400">Last OK {new Date(s.lastOkAt).toLocaleString()}</span>
                        ) : s.lastError ? (
                          <span className="text-red-400">{s.lastError.slice(0, 40)}</span>
                        ) : (
                          <span>Not tested yet</span>
                        )}
                      </div>
                      <button
                        onClick={() => testServer(s.id)}
                        disabled={testing === s.id}
                        className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-1 disabled:opacity-50"
                      >
                        <Plug size={11} className={testing === s.id ? "animate-pulse" : ""} /> Test
                      </button>
                      {s.id !== "local" && (
                        <button
                          onClick={() => deleteServer(s.id, s.name)}
                          className="text-zinc-500 hover:text-red-400 p-1"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                      <Link href={`/servers/${s.id}`} className="text-zinc-500 hover:text-zinc-200 p-1">
                        <ArrowRight size={13} />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
