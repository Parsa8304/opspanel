"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import { AlertTriangle, Plus, Trash2, KeyRound, Check, X } from "lucide-react";

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
  const [tab, setTab] = useState<"users" | "scenarios" | "audit">("users");
  const { data: me } = useSWR<Me>("/api/auth/me", fetcher);
  const isAdmin = me?.role === "ADMIN";
  const isEngineer =
    me?.role === "ADMIN" || me?.role === "ENGINEER";

  return (
    <div>
      <PageHeader title={t("accessTitle", lang)} desc={t("accessDesc", lang)} />
      <div className="px-6 pt-4 flex gap-2 border-b border-zinc-200 dark:border-zinc-800">
        {(
          [
            ["users", "acTabUsers"],
            ["scenarios", "acTabScenarios"],
            ["audit", "acTabAudit"],
          ] as const
        ).map(([k, key]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === k
                ? "border-[#C7B299] text-white"
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
