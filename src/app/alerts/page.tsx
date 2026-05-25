"use client";
import { useState } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

type Role = "ADMIN" | "ENGINEER" | "REVIEWER" | "READONLY";
type Me = { id: string; name: string; role: Role } | undefined;
const RANK: Record<Role, number> = {
  READONLY: 0,
  REVIEWER: 1,
  ENGINEER: 2,
  ADMIN: 3,
};

const SEV_CLASS: Record<string, string> = {
  INFO: "bg-sky-600/20 text-sky-300 border-sky-700/40",
  WARN: "bg-amber-600/20 text-amber-300 border-amber-700/40",
  ERROR: "bg-red-600/20 text-red-300 border-red-700/40",
  CRITICAL: "bg-fuchsia-600/20 text-fuchsia-300 border-fuchsia-700/40",
};
const DEL_CLASS: Record<string, string> = {
  delivered: "bg-emerald-600/20 text-emerald-300 border-emerald-700/40",
  queued: "bg-amber-600/20 text-amber-300 border-amber-700/40",
  failed: "bg-red-600/20 text-red-300 border-red-700/40",
  pending: "bg-zinc-600/20 text-zinc-300 border-zinc-700/40",
};

async function api(url: string, method: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
}

export default function Page() {
  const { lang } = useUI();
  const { data: me } = useSWR<Me>("/api/auth/me", fetcher);
  const role: Role = me?.role ?? "READONLY";
  const isAdmin = RANK[role] >= RANK.ADMIN;
  const isEng = RANK[role] >= RANK.ENGINEER;

  const [tab, setTab] = useState<"events" | "channels" | "rules" | "config">(
    "events"
  );
  const [fStatus, setFStatus] = useState("");
  const [fSev, setFSev] = useState("");
  const [fSrc, setFSrc] = useState("");

  const evQs = new URLSearchParams();
  if (fStatus) evQs.set("status", fStatus);
  if (fSev) evQs.set("severity", fSev);
  if (fSrc) evQs.set("source", fSrc);
  evQs.set("limit", "200");

  const { data: ev, mutate: mutEv } = useSWR<any>(
    `/api/alerts/events?${evQs.toString()}`,
    fetcher,
    { refreshInterval: 10000 }
  );
  const { data: ch, mutate: mutCh } = useSWR<any>(
    "/api/alerts/channels",
    fetcher
  );
  const { data: rl, mutate: mutRl } = useSWR<any>("/api/alerts/rules", fetcher);
  const { data: health, mutate: mutHealth } = useSWR<any>(
    "/api/alerts/health",
    fetcher,
    { refreshInterval: 10000 }
  );
  const { data: cfg, mutate: mutCfg } = useSWR<any>(
    "/api/alerts/config",
    fetcher
  );

  const [msg, setMsg] = useState<string | null>(null);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };

  return (
    <div>
      <PageHeader title={t("alTitle", lang)} desc={t("alDesc", lang)} />

      {health?.delayed && (
        <div className="mx-6 mt-4 rounded-lg border border-amber-600/50 bg-amber-600/10 px-4 py-3 text-sm text-amber-300 flex items-center justify-between gap-4">
          <span>
            {t("alDelayedBanner", lang)} — {health.queued}{" "}
            {t("alQueued", lang)}
          </span>
          {isEng && (
            <button
              onClick={async () => {
                try {
                  const r = await api("/api/alerts/flush", "POST");
                  flash(
                    `${t("alFlushed", lang)}: ${r.delivered}/${r.attempted}`
                  );
                  mutHealth();
                  mutEv();
                } catch (e: any) {
                  flash(e.message);
                }
              }}
              className="rounded border border-amber-600/50 px-3 py-1 text-xs hover:bg-amber-600/20"
            >
              {t("alRetryNow", lang)}
            </button>
          )}
        </div>
      )}

      {msg && (
        <div className="mx-6 mt-4 rounded border border-zinc-700 bg-zinc-800/60 px-4 py-2 text-sm">
          {msg}
        </div>
      )}

      <div className="px-6 pt-4 flex gap-2 text-sm">
        {(["events", "channels", "rules", "config"] as const).map((tk) => (
          <button
            key={tk}
            onClick={() => setTab(tk)}
            className={`rounded px-3 py-1.5 border ${
              tab === tk
                ? "bg-[#183661] text-white border-[#183661]"
                : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            }`}
          >
            {t(`alTab_${tk}`, lang)}
          </button>
        ))}
      </div>

      {tab === "events" && (
        <div className="p-6 space-y-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <select
              value={fStatus}
              onChange={(e) => setFStatus(e.target.value)}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="">{t("alAllStatus", lang)}</option>
              <option value="open">open</option>
              <option value="acked">acked</option>
              <option value="snoozed">snoozed</option>
            </select>
            <select
              value={fSev}
              onChange={(e) => setFSev(e.target.value)}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              <option value="">{t("alAllSev", lang)}</option>
              {["INFO", "WARN", "ERROR", "CRITICAL"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input
              value={fSrc}
              onChange={(e) => setFSrc(e.target.value)}
              placeholder={t("alSource", lang)}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </div>

          {!ev?.events?.length ? (
            <EmptyState msg={t("alNoEvents", lang)} />
          ) : (
            <div className="space-y-3">
              {ev.events.map((e: any) => (
                <div
                  key={e.id}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs ${
                        SEV_CLASS[e.severity] || ""
                      }`}
                    >
                      {e.severity}
                    </span>
                    <span className="text-xs text-zinc-500">{e.source}</span>
                    <span className="font-medium">{e.title}</span>
                    {e.suppressedCount > 0 && (
                      <span className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400">
                        +{e.suppressedCount} {t("alSuppressed", lang)}
                      </span>
                    )}
                    <span className="text-xs text-zinc-500 ms-auto">
                      {fmtDate(e.createdAt, lang)}
                    </span>
                  </div>
                  {e.payload?.line && (
                    <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {String(e.payload.line)}
                    </pre>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-zinc-500">
                      {t("alStatus", lang)}: {e.ackStatus}
                    </span>
                    {e.deliveries?.map((d: any) => (
                      <span
                        key={d.id}
                        title={d.lastError || ""}
                        className={`rounded border px-2 py-0.5 ${
                          DEL_CLASS[d.status] || ""
                        }`}
                      >
                        {d.channel?.name}: {d.status}
                      </span>
                    ))}
                    {isEng && e.ackStatus !== "acked" && (
                      <>
                        <button
                          onClick={async () => {
                            try {
                              await api(
                                `/api/alerts/events/${e.id}/ack`,
                                "POST",
                                {}
                              );
                              mutEv();
                            } catch (err: any) {
                              flash(err.message);
                            }
                          }}
                          className="rounded border border-emerald-600/50 px-2 py-0.5 hover:bg-emerald-600/20"
                        >
                          {t("alAck", lang)}
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await api(
                                `/api/alerts/events/${e.id}/snooze`,
                                "POST",
                                { hours: 1 }
                              );
                              mutEv();
                            } catch (err: any) {
                              flash(err.message);
                            }
                          }}
                          className="rounded border border-amber-600/50 px-2 py-0.5 hover:bg-amber-600/20"
                        >
                          {t("alSnooze1h", lang)}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "channels" && (
        <div className="p-6 space-y-4">
          {!isAdmin ? (
            <EmptyState msg={t("alAdminOnly", lang)} />
          ) : (
            <>
              <ChannelForm
                lang={lang}
                onDone={() => {
                  mutCh();
                  flash(t("alSaved", lang));
                }}
              />
              {!ch?.channels?.length ? (
                <EmptyState msg={t("alNoChannels", lang)} />
              ) : (
                <div className="space-y-3">
                  {ch.channels.map((c: any) => (
                    <div
                      key={c.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-zinc-500">{c.type}</span>
                        <span className="text-xs text-zinc-500">
                          ≥ {c.minSeverity}
                        </span>
                        <span
                          className={`rounded border px-2 py-0.5 text-xs ${
                            c.enabled
                              ? "border-emerald-700/40 text-emerald-300"
                              : "border-zinc-600 text-zinc-500"
                          }`}
                        >
                          {c.enabled
                            ? t("alEnabled", lang)
                            : t("alDisabled", lang)}
                        </span>
                        <span className="ms-auto flex gap-2">
                          <button
                            onClick={async () => {
                              try {
                                await api(
                                  `/api/alerts/channels/${c.id}`,
                                  "PATCH",
                                  { enabled: !c.enabled }
                                );
                                mutCh();
                              } catch (e: any) {
                                flash(e.message);
                              }
                            }}
                            className="rounded border border-zinc-600 px-2 py-0.5 text-xs"
                          >
                            {c.enabled
                              ? t("alDisable", lang)
                              : t("alEnable", lang)}
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                const r = await api(
                                  `/api/alerts/channels/${c.id}/test`,
                                  "POST"
                                );
                                flash(
                                  r.delivered
                                    ? t("alTestOk", lang)
                                    : `${t("alTestFail", lang)}: ${
                                        r.lastError || r.status
                                      }`
                                );
                                mutHealth();
                              } catch (e: any) {
                                flash(e.message);
                              }
                            }}
                            className="rounded border border-sky-600/50 px-2 py-0.5 text-xs"
                          >
                            {t("alSendTest", lang)}
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                await api(
                                  `/api/alerts/channels/${c.id}`,
                                  "DELETE"
                                );
                                mutCh();
                              } catch (e: any) {
                                flash(e.message);
                              }
                            }}
                            className="rounded border border-red-600/50 px-2 py-0.5 text-xs"
                          >
                            {t("alDelete", lang)}
                          </button>
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {c.config.chatId && <>chatId: {c.config.chatId} · </>}
                        {c.config.botTokenMasked && (
                          <>token: {c.config.botTokenMasked} · </>
                        )}
                        {c.config.baseUrl && <>base: {c.config.baseUrl} · </>}
                        {c.config.url && <>url: {c.config.url}</>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "rules" && (
        <div className="p-6 space-y-4">
          {!isAdmin ? (
            <EmptyState msg={t("alAdminOnly", lang)} />
          ) : (
            <>
              <button
                onClick={async () => {
                  try {
                    const r = await api(
                      "/api/alerts/rules/ensure-builtins",
                      "POST"
                    );
                    flash(`${t("alBuiltinsRestored", lang)} (+${r.created})`);
                    mutRl();
                  } catch (e: any) {
                    flash(e.message);
                  }
                }}
                className="rounded border border-emerald-600/50 px-3 py-1.5 text-sm hover:bg-emerald-600/20"
              >
                {t("alRestoreBuiltins", lang)}
              </button>
              {!rl?.rules?.length ? (
                <EmptyState msg={t("alNoRules", lang)} />
              ) : (
                <div className="space-y-2">
                  {rl.rules.map((r: any) => (
                    <div
                      key={r.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{r.name}</span>
                        {r.builtin && (
                          <span className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400">
                            {t("alBuiltin", lang)}
                          </span>
                        )}
                        <span
                          className={`rounded border px-2 py-0.5 text-xs ${
                            SEV_CLASS[r.severity] || ""
                          }`}
                        >
                          {r.severity}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {r.source}
                          {r.containerName ? ` · ${r.containerName}` : ""} · cd{" "}
                          {r.cooldownSec}s
                        </span>
                        <button
                          onClick={async () => {
                            try {
                              await api(`/api/alerts/rules/${r.id}`, "PATCH", {
                                enabled: !r.enabled,
                              });
                              mutRl();
                            } catch (e: any) {
                              flash(e.message);
                            }
                          }}
                          className="ms-auto rounded border border-zinc-600 px-2 py-0.5 text-xs"
                        >
                          {r.enabled
                            ? t("alDisable", lang)
                            : t("alEnable", lang)}
                        </button>
                        {!r.builtin && (
                          <button
                            onClick={async () => {
                              try {
                                await api(
                                  `/api/alerts/rules/${r.id}`,
                                  "DELETE"
                                );
                                mutRl();
                              } catch (e: any) {
                                flash(e.message);
                              }
                            }}
                            className="rounded border border-red-600/50 px-2 py-0.5 text-xs"
                          >
                            {t("alDelete", lang)}
                          </button>
                        )}
                      </div>
                      {r.pattern && (
                        <code className="mt-1 block text-xs text-zinc-500">
                          /{r.pattern}/i
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "config" && (
        <div className="p-6 max-w-lg space-y-4 text-sm">
          {!isAdmin ? (
            <EmptyState msg={t("alAdminOnly", lang)} />
          ) : (
            <ConfigForm
              lang={lang}
              cfg={cfg?.config}
              onDone={() => {
                mutCfg();
                flash(t("alSaved", lang));
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ChannelForm({ lang, onDone }: { lang: any; onDone: () => void }) {
  const [type, setType] = useState<"telegram" | "webhook">("telegram");
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [url, setUrl] = useState("");
  const [minSeverity, setMinSeverity] = useState("INFO");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2 text-sm">
      <div className="font-medium">{t("alAddChannel", lang)}</div>
      {err && <div className="text-red-400 text-xs">{err}</div>}
      <div className="flex gap-2 flex-wrap">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as any)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
        >
          <option value="telegram">telegram</option>
          <option value="webhook">webhook</option>
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("alName", lang)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
        />
        <select
          value={minSeverity}
          onChange={(e) => setMinSeverity(e.target.value)}
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
        >
          {["INFO", "WARN", "ERROR", "CRITICAL"].map((s) => (
            <option key={s} value={s}>
              ≥ {s}
            </option>
          ))}
        </select>
      </div>
      {type === "telegram" ? (
        <div className="flex gap-2 flex-wrap">
          <input
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={t("alBotToken", lang)}
            type="password"
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder={t("alChatId", lang)}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t("alBaseUrl", lang)}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
        </div>
      ) : (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("alWebhookUrl", lang)}
          className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
        />
      )}
      <button
        onClick={async () => {
          setErr(null);
          try {
            const config: any =
              type === "telegram"
                ? { botToken, chatId, ...(baseUrl ? { baseUrl } : {}) }
                : { url };
            await api("/api/alerts/channels", "POST", {
              type,
              name,
              minSeverity,
              config,
            });
            setName("");
            setBotToken("");
            setChatId("");
            setBaseUrl("");
            setUrl("");
            onDone();
          } catch (e: any) {
            setErr(e.message);
          }
        }}
        className="rounded bg-[#183661] text-white px-3 py-1.5"
      >
        {t("alAdd", lang)}
      </button>
    </div>
  );
}

function ConfigForm({
  lang,
  cfg,
  onDone,
}: {
  lang: any;
  cfg: any;
  onDone: () => void;
}) {
  const [ingestLogs, setIngest] = useState(!!cfg?.ingestLogs);
  const [panelBaseUrl, setBase] = useState(cfg?.panelBaseUrl || "");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
      {err && <div className="text-red-400 text-xs">{err}</div>}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={ingestLogs}
          onChange={(e) => setIngest(e.target.checked)}
        />
        {t("alIngestLogs", lang)}
      </label>
      <div>
        <div className="text-xs text-zinc-500 mb-1">
          {t("alPanelBaseUrl", lang)}
        </div>
        <input
          value={panelBaseUrl}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://panel.example.com"
          className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
        />
      </div>
      <button
        onClick={async () => {
          setErr(null);
          try {
            await api("/api/alerts/config", "PUT", {
              ingestLogs,
              panelBaseUrl,
            });
            onDone();
          } catch (e: any) {
            setErr(e.message);
          }
        }}
        className="rounded bg-[#183661] text-white px-3 py-1.5"
      >
        {t("alSave", lang)}
      </button>
    </div>
  );
}
