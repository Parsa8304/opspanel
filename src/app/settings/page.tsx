"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  Sun, Moon, Globe, ShieldCheck, ShieldAlert, GitBranch,
  Network, CheckCircle2, XCircle, KeyRound, Save,
} from "lucide-react";

const CARD = "rounded-lg border border-zinc-200 dark:border-zinc-800";
const CARD_HEAD =
  "px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 font-semibold flex items-center gap-2";
const INPUT =
  "w-full bg-transparent border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5 text-sm";
const BTN =
  "px-4 py-2 text-sm rounded bg-[#09637E] hover:bg-[#088395] text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2";
const LABEL = "text-xs text-zinc-500 mb-1 block";

/* ─── Security status ───────────────────────────────────────────────────── */
interface SecurityStatus {
  jwtSecretSet: boolean;
  masterKeySet: boolean;
  isProd: boolean;
  totpEnabled: boolean;
  activeSessions: number;
  role: string;
}

function StatusRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 size={15} className="text-emerald-400" />
        ) : (
          <XCircle size={15} className="text-red-400" />
        )}
        {label}
      </span>
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </div>
  );
}

function SecuritySection() {
  const { data } = useSWR<SecurityStatus>("/api/settings/security", fetcher);
  const allGood =
    data && data.jwtSecretSet && data.masterKeySet && data.totpEnabled;

  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        {allGood ? (
          <ShieldCheck size={16} className="text-emerald-400" />
        ) : (
          <ShieldAlert size={16} className="text-amber-400" />
        )}
        Security status
      </div>
      <div className="p-5">
        {!data ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            <StatusRow
              ok={data.jwtSecretSet}
              label="JWT secret configured"
              hint={data.jwtSecretSet ? "≥32 chars" : "set JWT_SECRET (≥32 chars)"}
            />
            <StatusRow
              ok={data.masterKeySet}
              label="Master encryption key configured"
              hint={
                data.masterKeySet ? "≥16 chars" : "set PANEL_MASTER_KEY (≥16 chars)"
              }
            />
            <StatusRow
              ok={data.totpEnabled}
              label="Two-factor authentication (your account)"
              hint={data.totpEnabled ? "enabled" : "enroll in Access & Audit"}
            />
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="flex items-center gap-2">
                <KeyRound size={15} className="text-zinc-400" />
                Active sessions (yours)
              </span>
              <span className="text-xs text-zinc-500">{data.activeSessions}</span>
            </div>
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="flex items-center gap-2">
                <Globe size={15} className="text-zinc-400" />
                Environment
              </span>
              <span className="text-xs text-zinc-500">
                {data.isProd ? "production" : "development"}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Appearance & language ─────────────────────────────────────────────── */
function AppearanceSection() {
  const { lang, theme, setLang, setTheme } = useUI();
  const pill = (active: boolean) =>
    `px-3 py-1.5 text-sm rounded border inline-flex items-center gap-2 ${
      active
        ? "border-[#09637E] bg-[#09637E]/10 text-[#0b86a8]"
        : "border-zinc-300 dark:border-zinc-700 text-zinc-500"
    }`;
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <Sun size={16} className="text-amber-400" />
        Appearance &amp; language
      </div>
      <div className="p-5 space-y-4">
        <div>
          <span className={LABEL}>Theme</span>
          <div className="flex gap-2">
            <button className={pill(theme === "dark")} onClick={() => setTheme("dark")}>
              <Moon size={14} /> Dark
            </button>
            <button className={pill(theme === "light")} onClick={() => setTheme("light")}>
              <Sun size={14} /> Light
            </button>
          </div>
        </div>
        <div>
          <span className={LABEL}>Language</span>
          <div className="flex gap-2">
            <button className={pill(lang === "en")} onClick={() => setLang("en")}>
              English
            </button>
            <button className={pill(lang === "fa")} onClick={() => setLang("fa")}>
              فارسی
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Git config ────────────────────────────────────────────────────────── */
interface GitConfig {
  provider: "github" | "gitlab" | "gitea" | "local";
  repoPath?: string | null;
  repoUrl?: string | null;
  branch?: string | null;
  token?: string | null;
}

function GitSection({ canEdit }: { canEdit: boolean }) {
  const { data, mutate } = useSWR<GitConfig>("/api/git/config", fetcher);
  const [form, setForm] = useState<GitConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data && !form) setForm({ ...data, provider: data.provider ?? "local" });
  }, [data, form]);

  if (!form) {
    return (
      <div className={CARD}>
        <div className={CARD_HEAD}>
          <GitBranch size={16} className="text-zinc-400" /> Git repository
        </div>
        <div className="p-5 text-sm text-zinc-500">Loading…</div>
      </div>
    );
  }

  const set = (k: keyof GitConfig, v: string) => setForm({ ...form, [k]: v });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch("/api/git/config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Save failed");
      setMsg("Saved");
      mutate();
    } catch (e: any) {
      setMsg(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <GitBranch size={16} className="text-zinc-400" /> Git repository
      </div>
      <div className="p-5 grid gap-4 md:grid-cols-2">
        <div>
          <span className={LABEL}>Provider</span>
          <select
            className={INPUT}
            value={form.provider}
            disabled={!canEdit}
            onChange={(e) => set("provider", e.target.value)}
          >
            <option value="local">Local</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="gitea">Gitea</option>
          </select>
        </div>
        <div>
          <span className={LABEL}>Default branch</span>
          <input
            className={INPUT}
            value={form.branch ?? ""}
            disabled={!canEdit}
            placeholder="main"
            onChange={(e) => set("branch", e.target.value)}
          />
        </div>
        <div className="md:col-span-2">
          <span className={LABEL}>Local repo path</span>
          <input
            className={INPUT}
            value={form.repoPath ?? ""}
            disabled={!canEdit}
            placeholder="/srv/app"
            onChange={(e) => set("repoPath", e.target.value)}
          />
        </div>
        <div className="md:col-span-2">
          <span className={LABEL}>Remote URL</span>
          <input
            className={INPUT}
            value={form.repoUrl ?? ""}
            disabled={!canEdit}
            placeholder="https://github.com/org/repo.git"
            onChange={(e) => set("repoUrl", e.target.value)}
          />
        </div>
        <div className="md:col-span-2">
          <span className={LABEL}>Access token (write-only — leave masked to keep)</span>
          <input
            className={INPUT}
            type="password"
            value={form.token ?? ""}
            disabled={!canEdit}
            placeholder="••••"
            onChange={(e) => set("token", e.target.value)}
          />
        </div>
      </div>
      {canEdit && (
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
          <button className={BTN} disabled={saving} onClick={save}>
            <Save size={14} /> {saving ? t("loading", "en") : "Save git config"}
          </button>
          {msg && (
            <span className={msg === "Saved" ? "text-emerald-400 text-sm" : "text-red-400 text-sm"}>
              {msg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Port ranges ───────────────────────────────────────────────────────── */
interface PortRange { label: string; from: number; to: number }
interface PortsConfig { ranges?: PortRange[]; defaultScanHosts?: string[] }

function PortsSection({ canEdit }: { canEdit: boolean }) {
  const { data, mutate } = useSWR<PortsConfig>("/api/ports/config", fetcher);
  const [ranges, setRanges] = useState<PortRange[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data && ranges === null) setRanges(data.ranges ?? []);
  }, [data, ranges]);

  if (ranges === null) {
    return (
      <div className={CARD}>
        <div className={CARD_HEAD}>
          <Network size={16} className="text-zinc-400" /> Port ranges
        </div>
        <div className="p-5 text-sm text-zinc-500">Loading…</div>
      </div>
    );
  }

  const update = (i: number, k: keyof PortRange, v: string) => {
    const next = [...ranges];
    next[i] = { ...next[i], [k]: k === "label" ? v : Number(v) };
    setRanges(next);
  };
  const addRange = () => setRanges([...ranges, { label: "", from: 0, to: 0 }]);
  const removeRange = (i: number) => setRanges(ranges.filter((_, j) => j !== i));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const clean = ranges.filter(
        (r) => r.label.trim() && Number.isFinite(r.from) && Number.isFinite(r.to)
      );
      const r = await fetch("/api/ports/config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, ranges: clean }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Save failed");
      setMsg("Saved");
      mutate();
    } catch (e: any) {
      setMsg(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <Network size={16} className="text-zinc-400" /> Port ranges
      </div>
      <div className="p-5 space-y-2">
        {ranges.length === 0 && (
          <p className="text-sm text-zinc-500">No ranges defined.</p>
        )}
        {ranges.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={INPUT}
              placeholder="Label"
              value={r.label}
              disabled={!canEdit}
              onChange={(e) => update(i, "label", e.target.value)}
            />
            <input
              className={`${INPUT} w-28`}
              type="number"
              placeholder="from"
              value={r.from}
              disabled={!canEdit}
              onChange={(e) => update(i, "from", e.target.value)}
            />
            <input
              className={`${INPUT} w-28`}
              type="number"
              placeholder="to"
              value={r.to}
              disabled={!canEdit}
              onChange={(e) => update(i, "to", e.target.value)}
            />
            {canEdit && (
              <button
                className="rounded border border-red-600/50 bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20"
                onClick={() => removeRange(i)}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
          <button
            className="px-4 py-2 text-sm border border-zinc-300 dark:border-zinc-700 rounded"
            onClick={addRange}
          >
            Add range
          </button>
          <button className={BTN} disabled={saving} onClick={save}>
            <Save size={14} /> {saving ? t("loading", "en") : "Save ranges"}
          </button>
          {msg && (
            <span className={msg === "Saved" ? "text-emerald-400 text-sm" : "text-red-400 text-sm"}>
              {msg}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */
export default function Page() {
  const { data: me } = useSWR<{ role?: string }>("/api/auth/me", fetcher);
  const role = me?.role ?? "READONLY";
  const isAdmin = role === "ADMIN";
  const canEditGit = role === "ADMIN" || role === "ENGINEER";

  return (
    <div>
      <PageHeader title="Settings" desc="Panel configuration and security posture" />
      <div className="space-y-6">
        <AppearanceSection />
        <SecuritySection />
        <GitSection canEdit={canEditGit} />
        <PortsSection canEdit={isAdmin} />
        {!isAdmin && (
          <p className="text-xs text-zinc-500">
            Some settings are read-only for your role ({role}). Port ranges
            require ADMIN; git config requires ENGINEER or higher.
          </p>
        )}
      </div>
    </div>
  );
}
