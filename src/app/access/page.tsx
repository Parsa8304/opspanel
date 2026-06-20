"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import { AlertTriangle, Plus, Trash2, KeyRound, Check, X, Monitor, ShieldCheck, QrCode } from "lucide-react";

const ROLES = ["ADMIN", "ENGINEER", "REVIEWER", "READONLY"] as const;
type Role = (typeof ROLES)[number];

type Me = { id: string; name: string; role: Role } | undefined;
type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  lastLoginAt: string | null;
  createdAt: string;
};
type Scenario = {
  id: string;
  name: string;
  description: string;
  status: string;
  effectiveStatus: "PASSING" | "FAILING" | "STALE";
  isStale: boolean;
  lastVerifiedAt: string | null;
  staleAfterDays: number;
  notes: string | null;
  verifiedBy: { id: string; name: string } | null;
};
type AuditEntry = {
  id: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
};

async function api(url: string, method: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = "Request failed";
    try {
      msg = (await r.json()).error || msg;
    } catch {}
    const e: any = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

function RolePill({ role, lang }: { role: Role; lang: Lang }) {
  const map: Record<Role, string> = {
    ADMIN: "bg-purple-600/20 text-purple-300 border-purple-700/40",
    ENGINEER: "bg-sky-600/20 text-sky-300 border-sky-700/40",
    REVIEWER: "bg-emerald-600/20 text-emerald-300 border-emerald-700/40",
    READONLY: "bg-zinc-600/20 text-zinc-300 border-zinc-700/40",
  };
  return (
    <span
      className={`inline-flex rounded border px-2 py-0.5 text-xs ${map[role]}`}
    >
      {t(`acRole${role}`, lang)}
    </span>
  );
}

function StatusPill({ s, lang }: { s: string; lang: Lang }) {
  const map: Record<string, [string, string]> = {
    PASSING: [
      "bg-emerald-600/20 text-emerald-400 border-emerald-700/40",
      "stPassing",
    ],
    FAILING: ["bg-red-600/20 text-red-400 border-red-700/40", "stFailing"],
    STALE: [
      "bg-amber-500/20 text-amber-300 border-amber-500/50 font-semibold",
      "stStale",
    ],
  };
  const [cls, key] = map[s] || map.STALE;
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-xs ${cls}`}>
      {t(key, lang)}
    </span>
  );
}

const inputCls =
  "rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm";
const btnCls =
  "inline-flex items-center gap-1 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40";

export default function Page() {
  const { lang } = useUI();
  const [tab, setTab] = useState<"users" | "scenarios" | "audit" | "sessions" | "2fa">("users");
  const { data: me } = useSWR<Me>("/api/auth/me", fetcher);
  const isAdmin = me?.role === "ADMIN";
  const isEngineer =
    me?.role === "ADMIN" || me?.role === "ENGINEER";

  return (
    <div>
      <PageHeader title={t("accessTitle", lang)} desc={t("accessDesc", lang)} />
      <div className="px-6 pt-4 flex gap-2 flex-wrap border-b border-zinc-200 dark:border-zinc-800">
        {(
          [
            ["users", "acTabUsers"],
            ["scenarios", "acTabScenarios"],
            ["audit", "acTabAudit"],
            ["sessions", "acTabSessions"],
            ["2fa", "acTab2fa"],
          ] as const
        ).map(([k, key]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === k
                ? "border-cyan-400 text-white"
                : "border-transparent text-zinc-500"
            }`}
          >
            {t(key, lang)}
          </button>
        ))}
      </div>
      <div className="p-6">
        {tab === "users" && (
          <UsersTab lang={lang} isAdmin={!!isAdmin} />
        )}
        {tab === "scenarios" && (
          <ScenariosTab lang={lang} isEngineer={!!isEngineer} />
        )}
        {tab === "audit" && <AuditTab lang={lang} />}
        {tab === "sessions" && <SessionsTab lang={lang} isAdmin={!!isAdmin} meId={me?.id ?? ""} />}
        {tab === "2fa" && <TotpTab lang={lang} />}
      </div>
    </div>
  );
}

function UsersTab({ lang, isAdmin }: { lang: Lang; isAdmin: boolean }) {
  const { data, mutate } = useSWR<User[]>("/api/access/users", fetcher);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    email: "",
    name: "",
    role: "READONLY" as Role,
    password: "",
  });

  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      await mutate();
    } catch (e: any) {
      setErr(e.message || "Error");
    }
  };

  if (!data) return <EmptyState msg={t("loading", lang)} />;

  return (
    <div className="space-y-4">
      {!isAdmin && (
        <div className="text-xs text-zinc-500">{t("acReadOnlyNote", lang)}</div>
      )}
      {err && (
        <div className="rounded border border-red-700/50 bg-red-600/10 px-3 py-2 text-sm text-red-400">
          {err}
        </div>
      )}
      {isAdmin && (
        <div>
          {!adding ? (
            <button className={btnCls} onClick={() => setAdding(true)}>
              <Plus size={13} /> {t("acAddUser", lang)}
            </button>
          ) : (
            <div className="flex flex-wrap items-end gap-2 rounded border border-zinc-300 dark:border-zinc-700 p-3">
              <label className="text-xs">
                {t("acColEmail", lang)}
                <input
                  className={`${inputCls} block mt-1`}
                  value={form.email}
                  onChange={(e) =>
                    setForm({ ...form, email: e.target.value })
                  }
                />
              </label>
              <label className="text-xs">
                {t("acName", lang)}
                <input
                  className={`${inputCls} block mt-1`}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="text-xs">
                {t("acColRole", lang)}
                <select
                  className={`${inputCls} block mt-1`}
                  value={form.role}
                  onChange={(e) =>
                    setForm({ ...form, role: e.target.value as Role })
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`acRole${r}`, lang)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                {t("acPassword", lang)}
                <input
                  type="password"
                  className={`${inputCls} block mt-1`}
                  value={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
              </label>
              <button
                className={btnCls}
                onClick={() =>
                  act(async () => {
                    await api("/api/access/users", "POST", form);
                    setAdding(false);
                    setForm({
                      email: "",
                      name: "",
                      role: "READONLY",
                      password: "",
                    });
                  })
                }
              >
                <Check size={13} /> {t("create", lang)}
              </button>
              <button className={btnCls} onClick={() => setAdding(false)}>
                <X size={13} /> {t("cancel", lang)}
              </button>
            </div>
          )}
        </div>
      )}
      {data.length === 0 ? (
        <EmptyState msg={t("acNoUsers", lang)} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500 text-xs">
              <tr className="text-start">
                <th className="text-start py-2">{t("acColUser", lang)}</th>
                <th className="text-start">{t("acColEmail", lang)}</th>
                <th className="text-start">{t("acColRole", lang)}</th>
                <th className="text-start">{t("acColLastLogin", lang)}</th>
                <th className="text-start">{t("acColCreated", lang)}</th>
                {isAdmin && (
                  <th className="text-start">{t("acColActions", lang)}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <UserRow
                  key={u.id}
                  u={u}
                  lang={lang}
                  isAdmin={isAdmin}
                  act={act}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserRow({
  u,
  lang,
  isAdmin,
  act,
}: {
  u: User;
  lang: Lang;
  isAdmin: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [resetting, setResetting] = useState(false);
  const [pw, setPw] = useState("");
  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800 align-top">
      <td className="py-2 pe-3">{u.name}</td>
      <td className="pe-3">{u.email}</td>
      <td className="pe-3">
        {isAdmin ? (
          <select
            className={inputCls}
            value={u.role}
            onChange={(e) =>
              act(() =>
                api(`/api/access/users/${u.id}`, "PATCH", {
                  role: e.target.value,
                })
              )
            }
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`acRole${r}`, lang)}
              </option>
            ))}
          </select>
        ) : (
          <RolePill role={u.role} lang={lang} />
        )}
      </td>
      <td className="pe-3">
        {u.lastLoginAt ? (
          fmtDate(u.lastLoginAt, lang)
        ) : (
          <span className="text-zinc-500 italic">{t("acNever", lang)}</span>
        )}
      </td>
      <td className="pe-3">{fmtDate(u.createdAt, lang)}</td>
      {isAdmin && (
        <td className="pe-3">
          <div className="flex flex-wrap items-center gap-1">
            {!resetting ? (
              <button
                className={btnCls}
                onClick={() => setResetting(true)}
                title={t("acResetPw", lang)}
              >
                <KeyRound size={12} /> {t("acResetPw", lang)}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1">
                <input
                  type="password"
                  placeholder={t("acNewPw", lang)}
                  className={inputCls}
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
                <button
                  className={btnCls}
                  onClick={() =>
                    act(async () => {
                      await api(`/api/access/users/${u.id}`, "PATCH", {
                        password: pw,
                      });
                      setResetting(false);
                      setPw("");
                    })
                  }
                >
                  <Check size={12} />
                </button>
                <button
                  className={btnCls}
                  onClick={() => {
                    setResetting(false);
                    setPw("");
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            )}
            <button
              className={`${btnCls} text-red-400`}
              onClick={() => {
                if (confirm(t("acConfirmDelete", lang)))
                  act(() => api(`/api/access/users/${u.id}`, "DELETE"));
              }}
            >
              <Trash2 size={12} /> {t("acDeleteUser", lang)}
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

function ScenariosTab({
  lang,
  isEngineer,
}: {
  lang: Lang;
  isEngineer: boolean;
}) {
  const { data, mutate } = useSWR<Scenario[]>(
    "/api/access/scenarios",
    fetcher
  );
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    staleAfterDays: 30,
  });

  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      await mutate();
    } catch (e: any) {
      setErr(e.message || "Error");
    }
  };

  if (!data) return <EmptyState msg={t("loading", lang)} />;
  const staleCount = data.filter((s) => s.effectiveStatus === "STALE").length;

  return (
    <div className="space-y-4">
      {staleCount > 0 ? (
        <div className="flex items-center gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          <AlertTriangle size={16} />
          <strong>{staleCount}</strong>{" "}
          {staleCount === 1
            ? t("acStaleWarnOne", lang)
            : t("acStaleWarnMany", lang)}
        </div>
      ) : (
        data.length > 0 && (
          <div className="rounded border border-emerald-700/40 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-400">
            {t("acAllFresh", lang)}
          </div>
        )
      )}
      {!isEngineer && (
        <div className="text-xs text-zinc-500">{t("acNeedEngineer", lang)}</div>
      )}
      {err && (
        <div className="rounded border border-red-700/50 bg-red-600/10 px-3 py-2 text-sm text-red-400">
          {err}
        </div>
      )}
      {isEngineer &&
        (!adding ? (
          <button className={btnCls} onClick={() => setAdding(true)}>
            <Plus size={13} /> {t("acAddScenario", lang)}
          </button>
        ) : (
          <div className="flex flex-wrap items-end gap-2 rounded border border-zinc-300 dark:border-zinc-700 p-3">
            <label className="text-xs">
              {t("acScName", lang)}
              <input
                className={`${inputCls} block mt-1`}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="text-xs">
              {t("acScDesc", lang)}
              <input
                className={`${inputCls} block mt-1`}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
            <label className="text-xs">
              {t("acScStaleAfter", lang)}
              <input
                type="number"
                className={`${inputCls} block mt-1 w-20`}
                value={form.staleAfterDays}
                onChange={(e) =>
                  setForm({
                    ...form,
                    staleAfterDays: parseInt(e.target.value, 10) || 30,
                  })
                }
              />
            </label>
            <button
              className={btnCls}
              onClick={() =>
                act(async () => {
                  await api("/api/access/scenarios", "POST", form);
                  setAdding(false);
                  setForm({ name: "", description: "", staleAfterDays: 30 });
                })
              }
            >
              <Check size={13} /> {t("create", lang)}
            </button>
            <button className={btnCls} onClick={() => setAdding(false)}>
              <X size={13} /> {t("cancel", lang)}
            </button>
          </div>
        ))}
      {data.length === 0 ? (
        <EmptyState msg={t("acNoScenarios", lang)} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500 text-xs">
              <tr>
                <th className="text-start py-2">{t("acScName", lang)}</th>
                <th className="text-start">{t("acScDesc", lang)}</th>
                <th className="text-start">{t("acScStatus", lang)}</th>
                <th className="text-start">{t("acScVerified", lang)}</th>
                <th className="text-start">{t("acScBy", lang)}</th>
                <th className="text-start">{t("acScStaleAfter", lang)}</th>
                <th className="text-start">{t("acScNotes", lang)}</th>
                {isEngineer && <th className="text-start" />}
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-zinc-200 dark:border-zinc-800 align-top"
                >
                  <td className="py-2 pe-3 font-medium">{s.name}</td>
                  <td className="pe-3 text-zinc-500 max-w-xs">
                    {s.description}
                  </td>
                  <td className="pe-3">
                    <StatusPill s={s.effectiveStatus} lang={lang} />
                  </td>
                  <td className="pe-3">
                    {s.lastVerifiedAt ? (
                      fmtDate(s.lastVerifiedAt, lang)
                    ) : (
                      <span className="text-zinc-500 italic">
                        {t("neverVerified", lang)}
                      </span>
                    )}
                  </td>
                  <td className="pe-3">{s.verifiedBy?.name || "—"}</td>
                  <td className="pe-3">
                    {s.staleAfterDays} {t("days", lang)}
                  </td>
                  <td className="pe-3 text-zinc-500 max-w-xs">
                    {s.notes || "—"}
                  </td>
                  {isEngineer && (
                    <td className="pe-3">
                      <div className="flex gap-1">
                        <button
                          className={`${btnCls} text-emerald-400`}
                          onClick={() =>
                            act(() =>
                              api(
                                `/api/access/scenarios/${s.id}/verify`,
                                "POST",
                                { result: "PASSING" }
                              )
                            )
                          }
                        >
                          {t("acMarkPassing", lang)}
                        </button>
                        <button
                          className={`${btnCls} text-red-400`}
                          onClick={() =>
                            act(() =>
                              api(
                                `/api/access/scenarios/${s.id}/verify`,
                                "POST",
                                { result: "FAILING" }
                              )
                            )
                          }
                        >
                          {t("acMarkFailing", lang)}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AuditTab({ lang }: { lang: Lang }) {
  const { data: users } = useSWR<User[]>("/api/access/users", fetcher);
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async (reset: boolean) => {
    setLoading(true);
    const p = new URLSearchParams();
    if (userId) p.set("userId", userId);
    if (action) p.set("action", action);
    if (from) p.set("from", new Date(from).toISOString());
    if (to) p.set("to", new Date(to).toISOString());
    p.set("limit", "50");
    if (!reset && cursor) p.set("cursor", cursor);
    try {
      const r = await api(`/api/access/audit?${p.toString()}`, "GET");
      setEntries(reset ? r.entries : [...entries, ...r.entries]);
      setCursor(r.nextCursor);
      setHasMore(!!r.nextCursor);
    } finally {
      setLoading(false);
    }
  };

  // Initial load (filters applied via the Apply button).
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          {t("acAuFilterUser", lang)}
          <select
            className={`${inputCls} block mt-1`}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">{t("acAuAllUsers", lang)}</option>
            {users?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          {t("acAuFilterAction", lang)}
          <input
            className={`${inputCls} block mt-1`}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
        </label>
        <label className="text-xs">
          {t("fromDate", lang)}
          <input
            type="date"
            className={`${inputCls} block mt-1`}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-xs">
          {t("toDate", lang)}
          <input
            type="date"
            className={`${inputCls} block mt-1`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className={btnCls} onClick={() => load(true)}>
          {t("applyFilters", lang)}
        </button>
      </div>
      {entries.length === 0 && !loading ? (
        <EmptyState msg={t("acAuEmpty", lang)} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500 text-xs">
              <tr>
                <th className="text-start py-2">{t("acAuWhen", lang)}</th>
                <th className="text-start">{t("acAuWho", lang)}</th>
                <th className="text-start">{t("acAuAction", lang)}</th>
                <th className="text-start">{t("acAuTarget", lang)}</th>
                <th className="text-start">{t("acAuDetail", lang)}</th>
                <th className="text-start">{t("acAuIp", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const open = expanded.has(e.id);
                const hasDetail =
                  e.detail != null &&
                  Object.keys(e.detail as object).length > 0;
                return (
                  <tr
                    key={e.id}
                    className="border-t border-zinc-200 dark:border-zinc-800 align-top"
                  >
                    <td className="py-2 pe-3 whitespace-nowrap">
                      {fmtDate(e.createdAt, lang)}
                    </td>
                    <td className="pe-3">
                      {e.user ? (
                        e.user.name
                      ) : (
                        <span className="text-zinc-500 italic">
                          {t("acAuSystem", lang)}
                        </span>
                      )}
                    </td>
                    <td className="pe-3 font-mono text-xs">{e.action}</td>
                    <td className="pe-3 font-mono text-xs">
                      {e.target || "—"}
                    </td>
                    <td className="pe-3">
                      {hasDetail ? (
                        <>
                          <button
                            className={btnCls}
                            onClick={() => {
                              const n = new Set(expanded);
                              if (open) n.delete(e.id);
                              else n.add(e.id);
                              setExpanded(n);
                            }}
                          >
                            {open
                              ? t("acHideDetail", lang)
                              : t("acShowDetail", lang)}
                          </button>
                          {open && (
                            <pre className="mt-1 max-w-md overflow-x-auto rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-xs">
                              {JSON.stringify(e.detail, null, 2)}
                            </pre>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="pe-3 font-mono text-xs">{e.ip || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <button
          className={btnCls}
          disabled={loading}
          onClick={() => load(false)}
        >
          {loading ? t("loading", lang) : t("acAuLoadMore", lang)}
        </button>
      )}
    </div>
  );
}

// ─── Sessions Tab ─────────────────────────────────────────────────────────────

type SessionRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  revokedAt: string | null;
  isActive: boolean;
};

function SessionsTab({ lang, isAdmin, meId }: { lang: Lang; isAdmin: boolean; meId: string }) {
  const { data, mutate } = useSWR<SessionRow[]>("/api/access/sessions", fetcher, { refreshInterval: 15000 });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [err, setErr] = useState("");

  async function revoke(id: string) {
    setRevoking(id);
    setErr("");
    const r = await fetch(`/api/access/sessions/${id}`, { method: "DELETE", credentials: "include" });
    setRevoking(null);
    if (!r.ok) setErr((await r.json().catch(() => ({}))).error || "Failed");
    else mutate();
  }

  const active = (data ?? []).filter((s) => s.isActive);
  const inactive = (data ?? []).filter((s) => !s.isActive);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          <Monitor size={15} style={{ color: "var(--accent)" }} />
          {t("acSessionsTitle", lang)}
        </h2>
        <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
          {t("acSessionsDesc", lang)}
        </p>
        {err && <p className="text-xs text-red-400 mb-2">{err}</p>}

        {!data ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("loading", lang)}</p>
        ) : active.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No active sessions.</p>
        ) : (
          <div className="rounded-lg overflow-hidden border" style={{ borderColor: "var(--border)" }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "var(--bg-card)", color: "var(--text-muted)" }}>
                  {isAdmin && <th className="text-start px-3 py-2">User</th>}
                  <th className="text-start px-3 py-2">IP</th>
                  <th className="text-start px-3 py-2">Device</th>
                  <th className="text-start px-3 py-2">Created</th>
                  <th className="text-start px-3 py-2">Last seen</th>
                  <th className="text-start px-3 py-2">Expires</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {active.map((s) => (
                  <tr key={s.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                    {isAdmin && (
                      <td className="px-3 py-2">
                        <span style={{ color: "var(--text-main)" }}>{s.userName}</span>
                        <span className="block" style={{ color: "var(--text-muted)" }}>{s.userEmail}</span>
                      </td>
                    )}
                    <td className="px-3 py-2 font-mono">{s.ip || "—"}</td>
                    <td className="px-3 py-2 max-w-[180px] truncate" title={s.userAgent ?? ""} style={{ color: "var(--text-muted)" }}>
                      {s.userAgent ? s.userAgent.split(" ")[0] : "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(s.createdAt, lang)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(s.lastSeenAt, lang)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(s.expiresAt, lang)}</td>
                    <td className="px-3 py-2">
                      <button
                        disabled={revoking === s.id}
                        onClick={() => revoke(s.id)}
                        className="rounded px-2 py-0.5 text-xs"
                        style={{ background: "var(--danger)", color: "#fff", opacity: revoking === s.id ? 0.5 : 1 }}
                      >
                        {t("acSessionRevoke", lang)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {inactive.length > 0 && (
        <details className="text-xs" style={{ color: "var(--text-muted)" }}>
          <summary className="cursor-pointer select-none">{inactive.length} expired / revoked session(s)</summary>
          <div className="mt-2 rounded border p-3 space-y-1" style={{ borderColor: "var(--border)" }}>
            {inactive.map((s) => (
              <div key={s.id} className="flex gap-4">
                {isAdmin && <span className="font-medium">{s.userName}</span>}
                <span className="font-mono">{s.ip || "—"}</span>
                <span>{fmtDate(s.lastSeenAt, lang)}</span>
                <span className="italic">{s.revokedAt ? "revoked" : "expired"}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── 2FA Tab ──────────────────────────────────────────────────────────────────

type MeWithTotp = { id: string; totpEnabled: boolean } | null;

function TotpTab({ lang }: { lang: Lang }) {
  const { data: me, mutate } = useSWR<MeWithTotp>("/api/auth/me", fetcher);
  const [enrollUri, setEnrollUri] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function startEnroll() {
    setBusy(true); setErr(""); setOk("");
    const r = await fetch("/api/access/totp", { credentials: "include" });
    setBusy(false);
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || "Failed"); return; }
    const d = await r.json();
    setEnrollUri(d.uri);
    setVerifyCode("");
  }

  async function confirmEnroll() {
    setBusy(true); setErr("");
    const r = await fetch("/api/access/totp", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: verifyCode }),
    });
    setBusy(false);
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || "Invalid code"); return; }
    setOk("2FA enabled successfully."); setEnrollUri(null); setVerifyCode("");
    mutate();
  }

  async function disable() {
    setBusy(true); setErr("");
    const r = await fetch("/api/access/totp", {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: disableCode }),
    });
    setBusy(false);
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || "Failed"); return; }
    setOk("2FA disabled."); setDisableCode("");
    mutate();
  }

  if (!me) return <p className="text-sm" style={{ color: "var(--text-muted)" }}>{t("loading", lang)}</p>;

  return (
    <div className="max-w-md space-y-6">
      <div>
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          <ShieldCheck size={15} style={{ color: "var(--accent)" }} />
          {t("ac2faTitle", lang)}
        </h2>
        <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
          {t("ac2faDesc", lang)}
        </p>

        <div className="flex items-center gap-2 mb-4">
          <span className={`text-xs rounded px-2 py-0.5 border ${me.totpEnabled ? "border-emerald-700/40 bg-emerald-600/10 text-emerald-400" : "border-zinc-700/40 bg-zinc-800/30 text-zinc-400"}`}>
            {me.totpEnabled ? t("ac2faEnabled", lang) : t("ac2faDisabled", lang)}
          </span>
        </div>

        {err && <p className="text-xs text-red-400 mb-2">{err}</p>}
        {ok && <p className="text-xs text-emerald-400 mb-2">{ok}</p>}

        {!me.totpEnabled ? (
          <div className="space-y-3">
            {!enrollUri ? (
              <button
                disabled={busy}
                onClick={startEnroll}
                className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-white disabled:opacity-50"
                style={{ background: "var(--primary)" }}
              >
                <QrCode size={13} /> {t("ac2faEnroll", lang)}
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {t("ac2faScanHint", lang)}
                </p>
                <div className="rounded p-3 font-mono text-xs break-all" style={{ background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  {enrollUri}
                </div>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("ac2faEnterCode", lang)}</p>
                <div className="flex gap-2">
                  <input
                    className="rounded px-3 py-1.5 text-sm font-mono tracking-widest w-32"
                    style={{ background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-main)" }}
                    placeholder="000000"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    maxLength={6}
                    inputMode="numeric"
                  />
                  <button
                    disabled={busy || verifyCode.length !== 6}
                    onClick={confirmEnroll}
                    className="rounded px-3 py-1.5 text-sm text-white disabled:opacity-50"
                    style={{ background: "var(--primary)" }}
                  >
                    {t("ac2faVerify", lang)}
                  </button>
                  <button onClick={() => { setEnrollUri(null); setErr(""); }} className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>{t("ac2faDisableHint", lang)}</p>
            <div className="flex gap-2">
              <input
                className="rounded px-3 py-1.5 text-sm font-mono tracking-widest w-32"
                style={{ background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-main)" }}
                placeholder="000000"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                maxLength={6}
                inputMode="numeric"
              />
              <button
                disabled={busy || disableCode.length !== 6}
                onClick={disable}
                className="rounded px-3 py-1.5 text-sm text-white disabled:opacity-50"
                style={{ background: "var(--danger)" }}
              >
                {t("ac2faDisable", lang)}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
