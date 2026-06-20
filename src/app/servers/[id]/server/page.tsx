"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { PageHeader } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, isRTL } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";

// ─── Types ───────────────────────────────────────────────────────
type DockerDaemonData = {
  config: Record<string, unknown>;
  raw: string;
  parseError: string | null;
  hasBackup: boolean;
  dockerInfo: Record<string, unknown>;
};

type SSHData = {
  config: Record<string, string>;
  lastLogins: string[];
  failedAttempts: string[];
  sshPort: number;
  hasPublicKey: boolean;
};

// ─── Helpers ─────────────────────────────────────────────────────
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, desc, badge }: { title: string; desc?: string; badge?: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-800 px-5 py-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        {badge}
      </div>
      {desc && <p className="mt-1 text-xs text-zinc-500">{desc}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none ${className}`}
    />
  );
}

function Btn({
  onClick,
  disabled,
  variant = "default",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "primary" | "warning";
  children: React.ReactNode;
}) {
  const cls =
    variant === "primary"
      ? "bg-indigo-600 text-white hover:bg-indigo-500"
      : variant === "danger"
      ? "border border-red-700/50 text-red-400 hover:border-red-600"
      : variant === "warning"
      ? "border border-amber-700/50 text-amber-400 hover:border-amber-600"
      : "border border-zinc-700 text-zinc-300 hover:border-zinc-600";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-zinc-800 px-5 pt-3">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`rounded-t px-3 py-2 text-xs font-medium ${
            active === tab.key
              ? "border-b-2 border-emerald-500 text-emerald-400"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ─── Docker Daemon Section ────────────────────────────────────────
function DockerDaemonSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<DockerDaemonData>(
    `/api/servers/${id}/server/docker-daemon`,
    fetcher,
    { refreshInterval: 30000 }
  );

  const [jsonText, setJsonText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    diff?: string;
    restarted?: boolean;
    dockerRunning?: boolean;
    error?: string;
  } | null>(null);

  const currentJson =
    jsonText !== null ? jsonText : data ? JSON.stringify(data.config, null, 2) : "{}";

  const apply = async (restartDocker: boolean) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(currentJson);
    } catch (e: any) {
      setResult({ error: `Invalid JSON: ${e.message}` });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/server/docker-daemon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: parsed, restartDocker }),
      });
      const d = await res.json();
      if (!res.ok) {
        setResult({ error: d.error || "Request failed" });
      } else {
        setResult(d);
        mutate();
      }
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const rtl = isRTL(lang);

  if (error) {
    return (
      <Card>
        <CardHeader title={t("dockerDaemonTitle", lang)} desc={t("dockerDaemonDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load Docker daemon settings.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={t("dockerDaemonTitle", lang)}
        desc={t("dockerDaemonDesc", lang)}
        badge={
          isLoading ? null : (
            <span
              className={`rounded border px-2 py-0.5 text-[10px] ${
                data?.hasBackup
                  ? "border-emerald-700/40 bg-emerald-950/30 text-emerald-400"
                  : "border-zinc-700 text-zinc-500"
              }`}
            >
              {data?.hasBackup ? t("dockerDaemonBackup", lang) : t("dockerDaemonNoBackup", lang)}
            </span>
          )
        }
      />

      {data?.parseError && (
        <div className="mx-5 mt-4 rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
          {t("dockerDaemonParseError", lang)}: {data.parseError}
        </div>
      )}

      <div className="p-5 space-y-5">
        {/* Quick fields */}
        {!isLoading && data && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t("dockerLogDriver", lang)}>
              <TextInput
                value={
                  typeof (data.config["log-driver"] as string | undefined) === "string"
                    ? (data.config["log-driver"] as string)
                    : ""
                }
                onChange={(v) => {
                  const c = { ...data.config, "log-driver": v || undefined };
                  if (!v) delete c["log-driver"];
                  setJsonText(JSON.stringify(c, null, 2));
                }}
                placeholder="json-file"
              />
            </Field>
            <Field label={t("dockerLogMaxSize", lang)}>
              <TextInput
                value={
                  (
                    (data.config["log-opts"] as Record<string, string> | undefined)?.[
                      "max-size"
                    ] ?? ""
                  ).toString()
                }
                onChange={(v) => {
                  const logOpts = {
                    ...((data.config["log-opts"] as Record<string, string>) || {}),
                  };
                  if (v) logOpts["max-size"] = v;
                  else delete logOpts["max-size"];
                  const c = { ...data.config, "log-opts": Object.keys(logOpts).length ? logOpts : undefined };
                  if (!c["log-opts"]) delete c["log-opts"];
                  setJsonText(JSON.stringify(c, null, 2));
                }}
                placeholder="100m"
              />
            </Field>
            <Field label={t("dockerLogMaxFile", lang)}>
              <TextInput
                value={
                  (
                    (data.config["log-opts"] as Record<string, string> | undefined)?.[
                      "max-file"
                    ] ?? ""
                  ).toString()
                }
                onChange={(v) => {
                  const logOpts = {
                    ...((data.config["log-opts"] as Record<string, string>) || {}),
                  };
                  if (v) logOpts["max-file"] = v;
                  else delete logOpts["max-file"];
                  const c = { ...data.config, "log-opts": Object.keys(logOpts).length ? logOpts : undefined };
                  if (!c["log-opts"]) delete c["log-opts"];
                  setJsonText(JSON.stringify(c, null, 2));
                }}
                placeholder="3"
              />
            </Field>
            <Field label={t("dockerDataRoot", lang)}>
              <TextInput
                value={typeof data.config["data-root"] === "string" ? (data.config["data-root"] as string) : ""}
                onChange={(v) => {
                  const c = { ...data.config };
                  if (v) c["data-root"] = v;
                  else delete c["data-root"];
                  setJsonText(JSON.stringify(c, null, 2));
                }}
                placeholder="/var/lib/docker"
              />
            </Field>
            <Field label={t("dockerRegistryMirrors", lang)}>
              <TextInput
                value={
                  Array.isArray(data.config["registry-mirrors"])
                    ? (data.config["registry-mirrors"] as string[]).join(", ")
                    : ""
                }
                onChange={(v) => {
                  const mirrors = v
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const c = { ...data.config };
                  if (mirrors.length) c["registry-mirrors"] = mirrors;
                  else delete c["registry-mirrors"];
                  setJsonText(JSON.stringify(c, null, 2));
                }}
                placeholder="https://mirror.example.com"
              />
            </Field>
            <Field label={t("dockerInsecureRegistries", lang)}>
              <TextInput
                value={
                  Array.isArray(data.config["insecure-registries"])
                    ? (data.config["insecure-registries"] as string[]).join(", ")
                    : ""
                }
                onChange={(v) => {
                  const regs = v
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const c = { ...data.config };
                  if (regs.length) c["insecure-registries"] = regs;
                  else delete c["insecure-registries"];
                  setJsonText(JSON.stringify(c, null, 2));
                }}
                placeholder="registry.internal:5000"
              />
            </Field>
          </div>
        )}

        {/* Raw JSON editor */}
        <Field label={t("dockerDaemonJson", lang)}>
          {isLoading ? (
            <div className="h-32 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
          ) : (
            <textarea
              value={currentJson}
              onChange={(e) => setJsonText(e.target.value)}
              rows={10}
              dir="ltr"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
            />
          )}
        </Field>

        {/* Warnings */}
        <div
          className={`flex items-start gap-2 rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-400 ${rtl ? "flex-row-reverse" : ""}`}
        >
          <span className="shrink-0 text-amber-500">⚠</span>
          <span>{t("dockerDaemonRestartWarning", lang)}</span>
        </div>

        {/* Action buttons */}
        <div className={`flex flex-wrap gap-2 ${rtl ? "justify-end" : ""}`}>
          <Btn onClick={() => apply(false)} disabled={busy} variant="primary">
            {t("dockerDaemonApply", lang)}
          </Btn>
          <Btn onClick={() => apply(true)} disabled={busy} variant="warning">
            {t("dockerDaemonApplyRestart", lang)}
          </Btn>
          <Btn
            onClick={() => {
              setJsonText(null);
              setResult(null);
            }}
            disabled={busy}
          >
            {t("cancel", lang)}
          </Btn>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-3">
            {result.error && (
              <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                {result.error}
              </div>
            )}
            {result.restarted !== undefined && (
              <div
                className={`rounded border px-3 py-2 text-xs ${
                  result.dockerRunning
                    ? "border-emerald-700/40 bg-emerald-950/30 text-emerald-400"
                    : "border-red-700/40 bg-red-950/30 text-red-400"
                }`}
              >
                {result.dockerRunning
                  ? t("dockerDaemonRunning", lang)
                  : t("dockerDaemonDown", lang)}
              </div>
            )}
            {result.diff && (
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-400">
                  {t("dockerDaemonDiff", lang)}
                </div>
                <pre className="max-h-48 overflow-auto rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
                  {result.diff || "(no diff — file was new)"}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── SSH Section ──────────────────────────────────────────────────
const SSH_FIELDS: { key: string; i18nKey: string; placeholder?: string }[] = [
  { key: "Port", i18nKey: "sshPort", placeholder: "22" },
  { key: "PermitRootLogin", i18nKey: "sshRootLogin", placeholder: "prohibit-password" },
  { key: "PasswordAuthentication", i18nKey: "sshPasswordAuth", placeholder: "yes" },
  { key: "PubkeyAuthentication", i18nKey: "sshPubKeyAuth", placeholder: "yes" },
  { key: "MaxAuthTries", i18nKey: "sshMaxAuthTries", placeholder: "6" },
  { key: "AllowUsers", i18nKey: "sshAllowUsers", placeholder: "ubuntu admin" },
];

function SSHSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<SSHData>(`/api/servers/${id}/server/ssh`, fetcher, {
    refreshInterval: 60000,
  });

  const [tab, setTab] = useState<"config" | "logins" | "failed">("config");
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok?: boolean;
    dryRun?: boolean;
    warnings?: string[];
    configTest?: string;
    restored?: boolean;
    reloaded?: boolean;
    changes?: Record<string, string>;
    error?: string;
  } | null>(null);

  const rtl = isRTL(lang);

  const send = async (applyNow: boolean) => {
    if (Object.keys(changes).length === 0 && applyNow) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/server/ssh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ changes, applyNow }),
      });
      const d = await res.json();
      if (!res.ok) {
        setResult({ error: d.error || "Request failed" });
      } else {
        setResult(d);
        if (d.ok) {
          setChanges({});
          mutate();
        }
      }
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const configValue = (key: string) =>
    key in changes ? changes[key] : (data?.config[key] ?? "");

  const setField = (key: string, value: string) => {
    setChanges((prev) => {
      const next = { ...prev };
      if (value === (data?.config[key] ?? "")) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const hasChanges = Object.keys(changes).length > 0;

  const sshTabs = [
    { key: "config", label: t("configure", lang) },
    { key: "logins", label: t("sshLastLogins", lang) },
    { key: "failed", label: t("sshFailedAttempts", lang) },
  ];

  if (error) {
    return (
      <Card>
        <CardHeader title={t("sshTitle", lang)} desc={t("sshDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load SSH settings.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={t("sshTitle", lang)}
        desc={t("sshDesc", lang)}
        badge={
          isLoading ? null : (
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-mono ${
                data?.sshPort
                  ? "border-zinc-700 text-zinc-400"
                  : "border-zinc-800 text-zinc-600"
              }`}
            >
              :{data?.sshPort ?? 22}
            </span>
          )
        }
      />

      <TabBar tabs={sshTabs} active={tab} onChange={(k) => setTab(k as typeof tab)} />

      {tab === "config" && (
        <div className="p-5 space-y-5">
          {/* Public key safety banner */}
          {!isLoading && data && (
            <div
              className={`flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                data.hasPublicKey
                  ? "border-emerald-700/40 bg-emerald-950/20 text-emerald-400"
                  : "border-amber-700/40 bg-amber-950/20 text-amber-400"
              } ${rtl ? "flex-row-reverse" : ""}`}
            >
              <span className="shrink-0">{data.hasPublicKey ? "✓" : "⚠"}</span>
              <span>
                {data.hasPublicKey
                  ? t("sshHasPublicKey", lang)
                  : t("sshNoPublicKey", lang)}
              </span>
            </div>
          )}

          {/* Config fields */}
          {isLoading ? (
            <div className="space-y-3">
              {SSH_FIELDS.map((f) => (
                <div key={f.key} className="h-10 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {SSH_FIELDS.map((f) => (
                <Field key={f.key} label={t(f.i18nKey, lang)}>
                  <TextInput
                    value={configValue(f.key)}
                    onChange={(v) => setField(f.key, v)}
                    placeholder={f.placeholder}
                    className={
                      f.key in changes ? "border-amber-600/60" : ""
                    }
                  />
                </Field>
              ))}
            </div>
          )}

          {/* Pending changes indicator */}
          {hasChanges && (
            <div className="rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-400">
              {t("sshLockoutWarning", lang)}:{" "}
              {Object.entries(changes)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}
            </div>
          )}

          {/* Action buttons */}
          <div className={`flex flex-wrap gap-2 ${rtl ? "justify-end" : ""}`}>
            <Btn onClick={() => send(false)} disabled={busy || !hasChanges}>
              {t("sshDryRun", lang)}
            </Btn>
            <Btn
              onClick={() => {
                if (
                  window.confirm(
                    `Apply ${Object.keys(changes).length} SSH change(s)? This will reload sshd.`
                  )
                ) {
                  send(true);
                }
              }}
              disabled={busy || !hasChanges}
              variant="primary"
            >
              {t("sshApply", lang)}
            </Btn>
            {hasChanges && (
              <Btn
                onClick={() => {
                  setChanges({});
                  setResult(null);
                }}
              >
                {t("cancel", lang)}
              </Btn>
            )}
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-3">
              {result.error && (
                <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                  {result.error}
                </div>
              )}
              {result.dryRun && result.changes && (
                <div className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs">
                  <div className="mb-2 font-medium text-zinc-300">{t("sshDryRun", lang)}</div>
                  <ul className="space-y-1">
                    {Object.entries(result.changes).map(([k, v]) => (
                      <li key={k} className="font-mono text-zinc-400">
                        <span className="text-amber-400">{k}</span> = {v}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400 space-y-1">
                  <div className="font-medium">{t("sshLockoutWarning", lang)}</div>
                  {result.warnings.map((w, i) => (
                    <div key={i}>⚠ {w}</div>
                  ))}
                </div>
              )}
              {result.ok && !result.dryRun && (
                <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-400">
                  {t("sshApplied", lang)}
                </div>
              )}
              {result.restored && (
                <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                  {t("sshConfigError", lang)}
                </div>
              )}
              {result.configTest && (
                <div>
                  <div className="mb-1 text-xs font-medium text-zinc-400">sshd -t</div>
                  <pre className="max-h-32 overflow-auto rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
                    {result.configTest || "(no output — config OK)"}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "logins" && (
        <div className="p-5">
          <div className="mb-3 text-xs font-medium text-zinc-400">{t("sshLastLogins", lang)}</div>
          {isLoading ? (
            <div className="h-40 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
          ) : !data?.lastLogins.length ? (
            <p className="text-xs text-zinc-600">No login records found.</p>
          ) : (
            <div className="max-h-80 overflow-auto rounded border border-zinc-800">
              {data.lastLogins.map((line, i) => (
                <div
                  key={i}
                  className="border-t border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-400 first:border-t-0 hover:bg-zinc-800/30"
                >
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "failed" && (
        <div className="p-5">
          <div className="mb-3 text-xs font-medium text-zinc-400">{t("sshFailedAttempts", lang)}</div>
          {isLoading ? (
            <div className="h-40 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
          ) : !data?.failedAttempts.length ? (
            <p className="text-xs text-zinc-600">No failed attempts in the last 24 hours.</p>
          ) : (
            <div className="max-h-80 overflow-auto rounded border border-zinc-800">
              {data.failedAttempts.map((line, i) => (
                <div
                  key={i}
                  className={`border-t border-zinc-800 px-3 py-1.5 font-mono text-xs first:border-t-0 hover:bg-zinc-800/30 ${
                    /Failed|Invalid/i.test(line) ? "text-red-400" : "text-emerald-400"
                  }`}
                >
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Firewall Section ─────────────────────────────────────────────
type FirewallRule = {
  number: string;
  to: string;
  action: string;
  from: string;
  comment?: string;
};

type FirewallData = {
  active: boolean;
  defaultIncoming: string;
  defaultOutgoing: string;
  rules: FirewallRule[];
  error?: string;
};

function FirewallSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<FirewallData>(
    `/api/servers/${id}/server/firewall`,
    fetcher,
    { refreshInterval: 10000 }
  );

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; output?: string } | null>(null);

  // Add rule form state
  const [addPort, setAddPort] = useState("");
  const [addProto, setAddProto] = useState<"tcp" | "udp" | "any">("tcp");
  const [addFrom, setAddFrom] = useState("");
  const [addComment, setAddComment] = useState("");

  // IP form state
  const [ipInput, setIpInput] = useState("");

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/server/firewall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) {
        setResult({ error: d.error || "Request failed" });
      } else {
        setResult(d);
        mutate();
      }
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const deleteRule = (ruleNumber: string) => {
    if (!window.confirm(t("firewallConfirmDelete", lang))) return;
    post({ action: "delete", ruleNumber });
  };

  const handleAddRule = () => {
    if (!addPort) return;
    post({
      action: "add",
      port: addPort,
      protocol: addProto,
      from: addFrom || undefined,
      comment: addComment || undefined,
    });
    setAddPort("");
    setAddFrom("");
    setAddComment("");
  };

  if (error) {
    return (
      <Card>
        <CardHeader title={t("firewallTitle", lang)} desc={t("firewallDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load firewall settings.</div>
      </Card>
    );
  }

  const activeBadge = isLoading ? null : (
    <span
      className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
        data?.active
          ? "border-emerald-700/40 bg-emerald-950/30 text-emerald-400"
          : "border-red-700/40 bg-red-950/30 text-red-400"
      }`}
    >
      {data?.active ? t("firewallActive", lang) : t("firewallInactive", lang)}
    </span>
  );

  return (
    <Card>
      <CardHeader
        title={t("firewallTitle", lang)}
        desc={t("firewallDesc", lang)}
        badge={activeBadge}
      />

      <div className="p-5 space-y-5">
        {/* Status row */}
        {!isLoading && data && (
          <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
            <span>
              <span className="font-medium text-zinc-300">{t("firewallDefaultIn", lang)}:</span>{" "}
              <span className="font-mono text-zinc-200">{data.defaultIncoming}</span>
            </span>
            <span>
              <span className="font-medium text-zinc-300">{t("firewallDefaultOut", lang)}:</span>{" "}
              <span className="font-mono text-zinc-200">{data.defaultOutgoing}</span>
            </span>
          </div>
        )}

        {/* Quick rule buttons */}
        <div>
          <div className="mb-2 text-xs font-medium text-zinc-400">{t("firewallQuickRules", lang)}</div>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => post({ action: "allow-ssh" })} disabled={busy} variant="default">
              {t("firewallAllowSsh", lang)}
            </Btn>
            <Btn onClick={() => post({ action: "allow-http" })} disabled={busy} variant="default">
              {t("firewallAllowHttp", lang)}
            </Btn>
            <Btn onClick={() => post({ action: "allow-https" })} disabled={busy} variant="default">
              {t("firewallAllowHttps", lang)}
            </Btn>
          </div>
        </div>

        {/* Add rule form */}
        <div>
          <div className="mb-2 text-xs font-medium text-zinc-400">{t("firewallAddRule", lang)}</div>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-zinc-500">{t("firewallPort", lang)}</label>
              <TextInput
                value={addPort}
                onChange={setAddPort}
                placeholder="8080"
                className="w-24"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-zinc-500">{t("firewallProto", lang)}</label>
              <select
                value={addProto}
                onChange={(e) => setAddProto(e.target.value as "tcp" | "udp" | "any")}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
                <option value="any">any</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-zinc-500">{t("firewallFromIp", lang)}</label>
              <TextInput
                value={addFrom}
                onChange={setAddFrom}
                placeholder="Anywhere"
                className="w-36"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-zinc-500">{t("firewallComment", lang)}</label>
              <TextInput
                value={addComment}
                onChange={setAddComment}
                placeholder="optional"
                className="w-32"
              />
            </div>
            <Btn onClick={handleAddRule} disabled={busy || !addPort} variant="primary">
              {t("firewallAddRule", lang)}
            </Btn>
          </div>
        </div>

        {/* Allow/Deny IP */}
        <div>
          <div className="mb-2 text-xs font-medium text-zinc-400">
            {t("firewallAllowIp", lang)} / {t("firewallDenyIp", lang)}
          </div>
          <div className="flex gap-2 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-zinc-500">IP</label>
              <TextInput
                value={ipInput}
                onChange={setIpInput}
                placeholder="1.2.3.4"
                className="w-40"
              />
            </div>
            <Btn
              onClick={() => { if (ipInput) { post({ action: "allow-ip", ip: ipInput }); setIpInput(""); } }}
              disabled={busy || !ipInput}
              variant="default"
            >
              {t("firewallAllowIp", lang)}
            </Btn>
            <Btn
              onClick={() => { if (ipInput) { post({ action: "deny-ip", ip: ipInput }); setIpInput(""); } }}
              disabled={busy || !ipInput}
              variant="danger"
            >
              {t("firewallDenyIp", lang)}
            </Btn>
          </div>
        </div>

        {/* Rules table */}
        <div>
          <div className="mb-2 text-xs font-medium text-zinc-400">{t("firewallRules", lang)}</div>
          {isLoading ? (
            <div className="h-32 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
          ) : !data?.rules.length ? (
            <p className="text-xs text-zinc-600">{t("firewallNoRules", lang)}</p>
          ) : (
            <div className="overflow-auto rounded border border-zinc-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">{t("firewallPort", lang)}/To</th>
                    <th className="px-3 py-2 text-left font-medium">Action</th>
                    <th className="px-3 py-2 text-left font-medium">From</th>
                    <th className="px-3 py-2 text-left font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rules.map((rule) => (
                    <tr
                      key={rule.number}
                      className="border-t border-zinc-800/50 hover:bg-zinc-800/20"
                    >
                      <td className="px-3 py-1.5 font-mono text-zinc-500">{rule.number}</td>
                      <td className="px-3 py-1.5 font-mono text-zinc-300">{rule.to}</td>
                      <td className="px-3 py-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            /ALLOW/i.test(rule.action)
                              ? "bg-emerald-950/40 text-emerald-400"
                              : "bg-red-950/40 text-red-400"
                          }`}
                        >
                          {rule.action}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-zinc-400">{rule.from}</td>
                      <td className="px-3 py-1.5">
                        <button
                          onClick={() => deleteRule(rule.number)}
                          disabled={busy}
                          className="rounded border border-red-700/40 px-2 py-0.5 text-[10px] text-red-400 hover:border-red-600 disabled:opacity-40"
                        >
                          {t("firewallDeleteRule", lang)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Result feedback */}
        {result && (
          <div>
            {result.error && (
              <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                {result.error}
              </div>
            )}
            {result.ok && result.output && (
              <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 font-mono text-xs text-emerald-400">
                {result.output}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Port Audit Section ───────────────────────────────────────────
type ListeningPort = {
  proto: string;
  local: string;
  port: string;
  pid?: string;
  program?: string;
};

type DockerPort = {
  container: string;
  port: string;
  binding: string;
};

type PortAuditEntry = {
  port: string;
  proto: string;
  listening: boolean;
  dockerExposed: boolean;
  firewallAllowed: boolean;
  risk: "safe" | "warning" | "danger";
  note: string;
};

type PortsData = {
  listening: ListeningPort[];
  dockerPorts: DockerPort[];
  ufwRules: string[];
  audit: PortAuditEntry[];
};

function PortAuditSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<PortsData>(
    `/api/servers/${id}/server/ports`,
    fetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  const danger = data?.audit.filter((e) => e.risk === "danger").length ?? 0;
  const warning = data?.audit.filter((e) => e.risk === "warning").length ?? 0;
  const safe = data?.audit.filter((e) => e.risk === "safe").length ?? 0;

  const riskBadge = (risk: PortAuditEntry["risk"]) => {
    if (risk === "danger")
      return (
        <span className="rounded border border-red-700/40 bg-red-950/30 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
          {t("portAuditDanger", lang)}
        </span>
      );
    if (risk === "warning")
      return (
        <span className="rounded border border-amber-700/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
          {t("portAuditWarning", lang)}
        </span>
      );
    return (
      <span className="rounded border border-emerald-700/40 bg-emerald-950/30 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
        {t("portAuditSafe", lang)}
      </span>
    );
  };

  const check = (v: boolean) =>
    v ? (
      <span className="text-emerald-400">✓</span>
    ) : (
      <span className="text-zinc-600">✗</span>
    );

  if (error) {
    return (
      <Card>
        <CardHeader title={t("portAuditTitle", lang)} desc={t("portAuditDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load port audit.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={t("portAuditTitle", lang)} desc={t("portAuditDesc", lang)} />

      <div className="p-5 space-y-5">
        {/* Controls + summary */}
        <div className="flex flex-wrap items-center gap-4">
          <Btn onClick={() => mutate()} disabled={isLoading} variant="default">
            {t("portAuditRefresh", lang)}
          </Btn>
          {data && (
            <div className="flex gap-3 text-xs">
              {danger > 0 && (
                <span className="rounded border border-red-700/40 bg-red-950/30 px-2 py-0.5 font-medium text-red-400">
                  {danger} {t("portAuditDanger", lang)}
                </span>
              )}
              {warning > 0 && (
                <span className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-0.5 font-medium text-amber-400">
                  {warning} {t("portAuditWarning", lang)}
                </span>
              )}
              {safe > 0 && (
                <span className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-0.5 font-medium text-emerald-400">
                  {safe} {t("portAuditSafe", lang)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Audit table */}
        {isLoading ? (
          <div className="h-40 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
        ) : !data?.audit.length ? (
          <p className="text-xs text-zinc-600">No port data collected — click Refresh audit.</p>
        ) : (
          <div className="overflow-auto rounded border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="px-3 py-2 text-left font-medium">Port</th>
                  <th className="px-3 py-2 text-left font-medium">Proto</th>
                  <th className="px-3 py-2 text-center font-medium">{t("portAuditListening", lang)}</th>
                  <th className="px-3 py-2 text-center font-medium">{t("portAuditDocker", lang)}</th>
                  <th className="px-3 py-2 text-center font-medium">{t("portAuditFirewall", lang)}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("portAuditRisk", lang)}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("portAuditNote", lang)}</th>
                </tr>
              </thead>
              <tbody>
                {data.audit.map((entry) => (
                  <tr
                    key={entry.port}
                    className={`border-t border-zinc-800/50 hover:bg-zinc-800/20 ${
                      entry.risk === "danger" ? "border-l-2 border-l-red-600/60" : ""
                    }`}
                  >
                    <td className="px-3 py-1.5 font-mono font-semibold text-zinc-200">
                      {entry.port}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-zinc-500">{entry.proto}</td>
                    <td className="px-3 py-1.5 text-center">{check(entry.listening)}</td>
                    <td className="px-3 py-1.5 text-center">{check(entry.dockerExposed)}</td>
                    <td className="px-3 py-1.5 text-center">{check(entry.firewallAllowed)}</td>
                    <td className="px-3 py-1.5">{riskBadge(entry.risk)}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{entry.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Network Section ─────────────────────────────────────────────
type NetworkInterface = {
  name: string;
  state: string;
  mac: string;
  ips: { ip: string; cidr: string }[];
};

type NetworkData = {
  publicIp: string | null;
  privateIps: { iface: string; ip: string; cidr: string }[];
  gateway: string | null;
  dns: string[];
  interfaces: NetworkInterface[];
  hostname: string;
};

type DiagResult = { ok: boolean; output: string; duration: number };

function NetworkSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<NetworkData>(
    `/api/servers/${id}/server/network`,
    fetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  const [diagTool, setDiagTool] = useState<string>("ping");
  const [diagTarget, setDiagTarget] = useState("");
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagResult, setDiagResult] = useState<DiagResult | null>(null);

  const runDiag = async () => {
    if (!diagTarget.trim()) return;
    setDiagBusy(true);
    setDiagResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/server/network`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: diagTool, target: diagTarget.trim() }),
      });
      const d = await res.json();
      setDiagResult(d);
    } catch (e: any) {
      setDiagResult({ ok: false, output: String(e?.message || e), duration: 0 });
    } finally {
      setDiagBusy(false);
    }
  };

  if (error) {
    return (
      <Card>
        <CardHeader title={t("networkTitle", lang)} desc={t("networkDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load network info.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={t("networkTitle", lang)} desc={t("networkDesc", lang)} />
      <div className="p-5 space-y-5">
        {/* Refresh */}
        <div>
          <Btn onClick={() => mutate()} disabled={isLoading} variant="default">
            {t("refresh", lang)}
          </Btn>
        </div>

        {/* Info grid */}
        {isLoading ? (
          <div className="h-24 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
        ) : data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{t("networkPublicIp", lang)}</div>
              <div className="font-mono text-sm text-emerald-400">{data.publicIp || "—"}</div>
            </div>
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{t("networkHostname", lang)}</div>
              <div className="font-mono text-sm text-zinc-200">{data.hostname || "—"}</div>
            </div>
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{t("networkGateway", lang)}</div>
              <div className="font-mono text-sm text-zinc-200">{data.gateway || "—"}</div>
            </div>
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{t("networkDns", lang)}</div>
              <div className="font-mono text-sm text-zinc-200">
                {data.dns.length ? data.dns.join(", ") : "—"}
              </div>
            </div>
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2 sm:col-span-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{t("networkPrivateIps", lang)}</div>
              <div className="flex flex-wrap gap-2">
                {data.privateIps.length ? data.privateIps.map((e, i) => (
                  <span key={i} className="font-mono text-xs text-zinc-300">
                    <span className="text-zinc-500">{e.iface}:</span> {e.ip}/{e.cidr}
                  </span>
                )) : <span className="text-zinc-600 text-xs">—</span>}
              </div>
            </div>
          </div>
        ) : null}

        {/* Interfaces table */}
        {data && data.interfaces.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium text-zinc-400">{t("networkInterfaces", lang)}</div>
            <div className="overflow-auto rounded border border-zinc-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">State</th>
                    <th className="px-3 py-2 text-left font-medium">MAC</th>
                    <th className="px-3 py-2 text-left font-medium">IPs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.interfaces.map((iface) => (
                    <tr key={iface.name} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                      <td className="px-3 py-1.5 font-mono text-zinc-200">{iface.name}</td>
                      <td className="px-3 py-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          iface.state === "UP"
                            ? "bg-emerald-950/40 text-emerald-400"
                            : "bg-zinc-700 text-zinc-400"
                        }`}>
                          {iface.state}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-zinc-500 text-[11px]">{iface.mac || "—"}</td>
                      <td className="px-3 py-1.5 font-mono text-zinc-300 text-[11px]">
                        {iface.ips.map((ip) => `${ip.ip}/${ip.cidr}`).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Diagnostic tool */}
        <div>
          <div className="mb-2 text-xs font-medium text-zinc-400">{t("networkDiagTool", lang)}</div>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-zinc-500">{t("networkDiagTool", lang)}</label>
              <select
                value={diagTool}
                onChange={(e) => setDiagTool(e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="ping">ping</option>
                <option value="curl">curl</option>
                <option value="traceroute">traceroute</option>
                <option value="dig">dig</option>
                <option value="nslookup">nslookup</option>
              </select>
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-48">
              <label className="text-[10px] text-zinc-500">{t("networkTarget", lang)}</label>
              <TextInput
                value={diagTarget}
                onChange={setDiagTarget}
                placeholder="8.8.8.8 or example.com"
              />
            </div>
            <Btn
              onClick={runDiag}
              disabled={diagBusy || !diagTarget.trim()}
              variant="primary"
            >
              {diagBusy ? "…" : t("networkRun", lang)}
            </Btn>
          </div>

          {diagResult && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium ${diagResult.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {diagResult.ok ? "OK" : "Error"} ({diagResult.duration}ms)
                </span>
                <span className="text-xs text-zinc-500">{t("networkOutput", lang)}</span>
              </div>
              <pre className="max-h-48 overflow-auto rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap">
                {diagResult.output || "(no output)"}
              </pre>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── System Services Section ──────────────────────────────────────
type ServiceStatus = {
  name: string;
  displayName: string;
  active: boolean;
  enabled: boolean;
  since?: string;
  pid?: string;
  subState?: string;
};

type ServicesData = {
  services: ServiceStatus[];
};

function SystemServicesSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<ServicesData>(
    `/api/servers/${id}/server/services`,
    fetcher,
    { refreshInterval: 15000 }
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; output?: string } | null>(null);

  const act = async (service: string, action: string) => {
    if ((action === "stop" || action === "restart") &&
        !window.confirm(`${action} ${service}?`)) return;
    setBusy(`${service}:${action}`);
    setResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/server/services`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service, action }),
      });
      const d = await res.json();
      if (!res.ok) setResult({ error: d.error || "Request failed" });
      else { setResult(d); mutate(); }
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <Card>
        <CardHeader title={t("servicesTitle", lang)} desc={t("servicesDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load service status.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={t("servicesTitle", lang)} desc={t("servicesDesc", lang)} />
      <div className="p-5 space-y-4">
        {isLoading ? (
          <div className="h-40 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
        ) : !data?.services.length ? (
          <p className="text-xs text-zinc-600">No services found.</p>
        ) : (
          <div className="overflow-auto rounded border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="px-3 py-2 text-left font-medium">Service</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">{t("serviceSince", lang)}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("servicePid", lang)}</th>
                  <th className="px-3 py-2 text-left font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.services.map((svc) => (
                  <tr key={svc.name} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                    <td className="px-3 py-2 font-medium text-zinc-200">{svc.displayName}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                        svc.active
                          ? "border-emerald-700/40 bg-emerald-950/30 text-emerald-400"
                          : "border-zinc-700 bg-zinc-800 text-zinc-400"
                      }`}>
                        {svc.active ? t("serviceActive", lang) : t("serviceInactive", lang)}
                        {svc.subState && svc.subState !== "running" && svc.subState !== "dead"
                          ? ` (${svc.subState})`
                          : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-500 text-[11px] font-mono">
                      {svc.since
                        ? new Date(svc.since).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-zinc-400">{svc.pid || "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          onClick={() => act(svc.name, "start")}
                          disabled={!!busy || svc.active}
                          className="rounded border border-emerald-700/50 px-2 py-0.5 text-[10px] text-emerald-400 hover:border-emerald-600 disabled:opacity-40"
                        >
                          {t("serviceStart", lang)}
                        </button>
                        <button
                          onClick={() => act(svc.name, "stop")}
                          disabled={!!busy || !svc.active}
                          className="rounded border border-red-700/50 px-2 py-0.5 text-[10px] text-red-400 hover:border-red-600 disabled:opacity-40"
                        >
                          {t("serviceStop", lang)}
                        </button>
                        <button
                          onClick={() => act(svc.name, "restart")}
                          disabled={!!busy}
                          className="rounded border border-amber-700/50 px-2 py-0.5 text-[10px] text-amber-400 hover:border-amber-600 disabled:opacity-40"
                        >
                          {t("serviceRestart", lang)}
                        </button>
                        <button
                          onClick={() => act(svc.name, "reload")}
                          disabled={!!busy}
                          className="rounded border border-blue-700/50 px-2 py-0.5 text-[10px] text-blue-400 hover:border-blue-600 disabled:opacity-40"
                        >
                          {t("serviceReload", lang)}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result && (
          <div>
            {result.error && (
              <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                {result.error}
              </div>
            )}
            {result.ok && result.output && (
              <div className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300">
                {result.output || "(done)"}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── OS Section ───────────────────────────────────────────────────
type OsData = {
  os: string;
  kernel: string;
  arch: string;
  uptime: string;
  rebootRequired: boolean;
  updates: { security: number; total: number };
  updateHistory: string[];
};

function OSSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<OsData>(
    `/api/servers/${id}/server/os`,
    fetcher,
    { revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const [historyOpen, setHistoryOpen] = useState(false);

  if (error) {
    return (
      <Card>
        <CardHeader title={t("osTitle", lang)} desc={t("osDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load OS info.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={t("osTitle", lang)} desc={t("osDesc", lang)} />
      <div className="p-5 space-y-4">
        <div>
          <Btn onClick={() => mutate()} disabled={isLoading} variant="default">
            {t("refresh", lang)}
          </Btn>
        </div>

        {isLoading ? (
          <div className="h-24 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
        ) : data ? (
          <>
            {/* OS info row */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "OS", value: data.os },
                { label: t("osKernel", lang), value: data.kernel },
                { label: t("osArch", lang), value: data.arch },
                { label: t("osUptime", lang), value: data.uptime },
              ].map((item) => (
                <div key={item.label} className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">{item.label}</div>
                  <div className="font-mono text-xs text-zinc-200 break-all">{item.value || "—"}</div>
                </div>
              ))}
            </div>

            {/* Reboot required banner */}
            {data.rebootRequired && (
              <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-sm text-red-400 font-medium">
                ⚠ {t("osRebootRequired", lang)}
              </div>
            )}

            {/* Updates card */}
            <div className={`rounded border px-4 py-3 ${
              data.updates.security > 5
                ? "border-red-700/40 bg-red-950/20"
                : data.updates.security > 0
                ? "border-amber-700/40 bg-amber-950/20"
                : "border-zinc-700 bg-zinc-950/30"
            }`}>
              {data.updates.total === 0 ? (
                <p className="text-sm text-emerald-400">{t("osNoUpdates", lang)}</p>
              ) : (
                <div className="flex flex-wrap gap-6 text-sm">
                  <div>
                    <span className="text-zinc-400">{t("osUpdatesAvailable", lang)}: </span>
                    <span className="font-semibold text-zinc-100">{data.updates.total}</span>
                  </div>
                  {data.updates.security > 0 && (
                    <div>
                      <span className={data.updates.security > 5 ? "text-red-400" : "text-amber-400"}>
                        {t("osSecurityUpdates", lang)}: <strong>{data.updates.security}</strong>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Update history collapsible */}
            {data.updateHistory.length > 0 && (
              <div>
                <button
                  onClick={() => setHistoryOpen((v) => !v)}
                  className="text-xs text-zinc-400 hover:text-zinc-200 font-medium"
                >
                  {historyOpen ? "▾" : "▸"} {t("osUpdateHistory", lang)} ({data.updateHistory.length})
                </button>
                {historyOpen && (
                  <div className="mt-2 max-h-48 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2">
                    {data.updateHistory.slice(-10).map((line, i) => (
                      <div key={i} className="font-mono text-[11px] text-zinc-400 py-0.5">{line}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}

// ─── Resources Section ────────────────────────────────────────────
type CpuInfo = { cores: number; model: string };
type MemInfo = { total: number; used: number; free: number; cached: number; buffers: number };
type SwapInfo = { total: number; used: number; free: number };
type DiskEntry = { filesystem: string; size: string; used: string; available: string; usePercent: string; mountpoint: string };
type ProcessEntry = { pid: string; user: string; cpu: string; mem: string; command: string };
type InodeEntry = { filesystem: string; inodeUsed: string; inodeFree: string; inodeUsePercent: string; mountpoint: string };

type ResourcesData = {
  cpu: CpuInfo;
  memory: MemInfo;
  swap: SwapInfo;
  disk: DiskEntry[];
  load: [number, number, number];
  processes: ProcessEntry[];
  inodes: InodeEntry[];
};

function ProgressBar({ pct, warn = 70, danger = 90 }: { pct: number; warn?: number; danger?: number }) {
  const color = pct >= danger ? "bg-red-500" : pct >= warn ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="h-2 rounded-full bg-zinc-700">
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function ResourcesSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading } = useSWR<ResourcesData>(
    `/api/servers/${id}/server/resources`,
    fetcher,
    { refreshInterval: 5000 }
  );

  if (error) {
    return (
      <Card>
        <CardHeader title={t("resourcesTitle", lang)} desc={t("resourcesDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load resource data.</div>
      </Card>
    );
  }

  const memPct = data && data.memory.total > 0
    ? Math.round((data.memory.used / data.memory.total) * 100)
    : 0;
  const swapPct = data && data.swap.total > 0
    ? Math.round((data.swap.used / data.swap.total) * 100)
    : 0;

  return (
    <Card>
      <CardHeader title={t("resourcesTitle", lang)} desc={t("resourcesDesc", lang)} />
      <div className="p-5 space-y-5">
        {isLoading && !data ? (
          <div className="h-32 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
        ) : data ? (
          <>
            {/* CPU + Memory + Swap row */}
            <div className="grid gap-4 sm:grid-cols-3">
              {/* CPU */}
              <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("resourcesCpu", lang)}</div>
                <div className="text-xs text-zinc-300 truncate" title={data.cpu.model}>{data.cpu.model}</div>
                <div className="text-xs text-zinc-500">{data.cpu.cores} {t("resourcesCores", lang)}</div>
              </div>

              {/* Memory */}
              <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("resourcesMemory", lang)}</div>
                <ProgressBar pct={memPct} />
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>{t("resourcesUsed", lang)}: {data.memory.used} MB</span>
                  <span>{t("resourcesTotal", lang)}: {data.memory.total} MB</span>
                </div>
                <div className="text-[11px] text-zinc-600">
                  cached: {data.memory.cached} MB &middot; buffers: {data.memory.buffers} MB
                </div>
              </div>

              {/* Swap */}
              <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("resourcesSwap", lang)}</div>
                {data.swap.total > 0 ? (
                  <>
                    <ProgressBar pct={swapPct} />
                    <div className="flex justify-between text-xs text-zinc-400">
                      <span>{t("resourcesUsed", lang)}: {data.swap.used} MB</span>
                      <span>{t("resourcesTotal", lang)}: {data.swap.total} MB</span>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-zinc-600">No swap configured</div>
                )}
              </div>
            </div>

            {/* Load average */}
            <div>
              <div className="mb-2 text-xs font-medium text-zinc-400">{t("resourcesLoad", lang)}</div>
              <div className="flex gap-4">
                {(["1m", "5m", "15m"] as const).map((label, i) => (
                  <div key={label} className="text-center">
                    <div className={`text-lg font-mono font-semibold ${
                      data.load[i] > data.cpu.cores ? "text-red-400" : "text-zinc-200"
                    }`}>
                      {data.load[i].toFixed(2)}
                    </div>
                    <div className="text-[10px] text-zinc-500">{label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Disk table */}
            {data.disk.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium text-zinc-400">{t("resourcesDisk", lang)}</div>
                <div className="overflow-auto rounded border border-zinc-800">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        <th className="px-3 py-2 text-left font-medium">Filesystem</th>
                        <th className="px-3 py-2 text-left font-medium">{t("resourcesTotal", lang)}</th>
                        <th className="px-3 py-2 text-left font-medium">{t("resourcesUsed", lang)}</th>
                        <th className="px-3 py-2 text-left font-medium">{t("resourcesFree", lang)}</th>
                        <th className="px-3 py-2 text-left font-medium w-28">Usage</th>
                        <th className="px-3 py-2 text-left font-medium">Mount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.disk.map((d, i) => {
                        const pct = parseInt(d.usePercent) || 0;
                        return (
                          <tr key={i} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                            <td className="px-3 py-1.5 font-mono text-zinc-400 text-[11px]">{d.filesystem}</td>
                            <td className="px-3 py-1.5 text-zinc-300">{d.size}</td>
                            <td className="px-3 py-1.5 text-zinc-300">{d.used}</td>
                            <td className="px-3 py-1.5 text-zinc-300">{d.available}</td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <div className="flex-1">
                                  <ProgressBar pct={pct} />
                                </div>
                                <span className={`text-[10px] font-mono ${
                                  pct >= 90 ? "text-red-400" : pct >= 70 ? "text-amber-400" : "text-zinc-400"
                                }`}>{d.usePercent}</span>
                              </div>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-zinc-300">{d.mountpoint}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Top processes */}
            {data.processes.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium text-zinc-400">{t("resourcesProcesses", lang)}</div>
                <div className="overflow-auto rounded border border-zinc-800">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        <th className="px-3 py-2 text-left font-medium">USER</th>
                        <th className="px-3 py-2 text-left font-medium">PID</th>
                        <th className="px-3 py-2 text-left font-medium">CPU%</th>
                        <th className="px-3 py-2 text-left font-medium">MEM%</th>
                        <th className="px-3 py-2 text-left font-medium">COMMAND</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.processes.map((p, i) => (
                        <tr key={i} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                          <td className="px-3 py-1 font-mono text-zinc-400">{p.user}</td>
                          <td className="px-3 py-1 font-mono text-zinc-400">{p.pid}</td>
                          <td className={`px-3 py-1 font-mono ${parseFloat(p.cpu) > 50 ? "text-red-400" : "text-zinc-300"}`}>{p.cpu}</td>
                          <td className={`px-3 py-1 font-mono ${parseFloat(p.mem) > 50 ? "text-amber-400" : "text-zinc-300"}`}>{p.mem}</td>
                          <td className="px-3 py-1 font-mono text-zinc-400 text-[11px]">{p.command}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Inodes */}
            {data.inodes.filter((n) => parseInt(n.inodeUsePercent) > 50).length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium text-zinc-400">{t("resourcesInodes", lang)}</div>
                <div className="overflow-auto rounded border border-zinc-800">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        <th className="px-3 py-2 text-left font-medium">Filesystem</th>
                        <th className="px-3 py-2 text-left font-medium">Used</th>
                        <th className="px-3 py-2 text-left font-medium">Free</th>
                        <th className="px-3 py-2 text-left font-medium">Use%</th>
                        <th className="px-3 py-2 text-left font-medium">Mount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.inodes
                        .filter((n) => parseInt(n.inodeUsePercent) > 50)
                        .map((n, i) => {
                          const pct = parseInt(n.inodeUsePercent) || 0;
                          return (
                            <tr key={i} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                              <td className="px-3 py-1.5 font-mono text-zinc-400 text-[11px]">{n.filesystem}</td>
                              <td className="px-3 py-1.5 text-zinc-300">{n.inodeUsed}</td>
                              <td className="px-3 py-1.5 text-zinc-300">{n.inodeFree}</td>
                              <td className={`px-3 py-1.5 font-mono font-medium ${pct >= 80 ? "text-red-400" : "text-amber-400"}`}>
                                {n.inodeUsePercent}
                              </td>
                              <td className="px-3 py-1.5 font-mono text-zinc-300">{n.mountpoint}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}

// ─── Time & Timezone Section ──────────────────────────────────────
type TimeData = {
  timezone: string;
  localTime: string;
  utcTime: string;
  ntpSync: boolean;
  ntpService: string;
  ntpServers: string[];
  clockDrift: number | null;
  driftWarning: boolean;
};

function TimeSection({ lang, id }: { lang: "en" | "fa"; id: string }) {
  const { data, error, isLoading, mutate } = useSWR<TimeData>(
    `/api/servers/${id}/server/time`,
    fetcher,
    { refreshInterval: 30000 }
  );

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string } | null>(null);

  // Timezone form
  const [tzOpen, setTzOpen] = useState(false);
  const [tzInput, setTzInput] = useState("");

  // NTP server form
  const [ntpServerInput, setNtpServerInput] = useState("");

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/servers/${id}/server/time`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) {
        setResult({ error: d.error || "Request failed" });
      } else {
        setResult(d);
        mutate();
      }
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Card>
        <CardHeader title={t("timeTitle", lang)} desc={t("timeDesc", lang)} />
        <div className="px-5 py-6 text-sm text-red-400">Failed to load time settings.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={t("timeTitle", lang)}
        desc={t("timeDesc", lang)}
        badge={
          isLoading ? null : (
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                data?.ntpSync
                  ? "border-emerald-700/40 bg-emerald-950/30 text-emerald-400"
                  : "border-red-700/40 bg-red-950/30 text-red-400"
              }`}
            >
              {data?.ntpSync ? t("timeNtpSynced", lang) : t("timeNtpNotSynced", lang)}
            </span>
          )
        }
      />

      <div className="p-5 space-y-5">
        {/* Clock drift alert */}
        {!isLoading && data?.driftWarning && (
          <div className="flex items-start gap-2 rounded border border-red-700/40 bg-red-950/20 px-3 py-2 text-xs text-red-400">
            <span className="shrink-0">⚠</span>
            <span>
              {t("timeDriftWarning", lang)}
              {data.clockDrift !== null && ` — ${data.clockDrift.toFixed(1)}ms`}
            </span>
          </div>
        )}

        {/* Info grid */}
        {isLoading ? (
          <div className="h-24 animate-pulse rounded border border-zinc-700 bg-zinc-950" />
        ) : data ? (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {/* Timezone */}
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                {t("timeTimezone", lang)}
              </div>
              <div className="font-mono text-sm text-zinc-200 break-all">{data.timezone}</div>
              <button
                onClick={() => { setTzOpen((v) => !v); setTzInput(data.timezone); }}
                className="mt-1 text-[10px] text-emerald-400 hover:text-emerald-300"
              >
                {tzOpen ? "▾" : "▸"} {t("timeChangeTimezone", lang)}
              </button>
            </div>

            {/* Local time */}
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                {t("timeLocalTime", lang)}
              </div>
              <div className="font-mono text-xs text-zinc-200">
                {new Date(data.localTime).toLocaleString()}
              </div>
            </div>

            {/* UTC time */}
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                {t("timeUtcTime", lang)}
              </div>
              <div className="font-mono text-xs text-zinc-200">{data.utcTime}</div>
            </div>

            {/* NTP service */}
            <div className="rounded border border-zinc-700 bg-zinc-950/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                {t("timeNtpService", lang)}
              </div>
              <div className="font-mono text-sm text-zinc-200">{data.ntpService}</div>
            </div>
          </div>
        ) : null}

        {/* Timezone change form (collapsible) */}
        {tzOpen && (
          <div className="rounded border border-zinc-700 bg-zinc-950/40 px-4 py-3 space-y-2">
            <div className="text-xs font-medium text-zinc-400">{t("timeChangeTimezone", lang)}</div>
            <div className="flex gap-2 items-center">
              <TextInput
                value={tzInput}
                onChange={setTzInput}
                placeholder="Asia/Tehran"
                className="w-64"
              />
              <Btn
                onClick={() => {
                  if (tzInput.trim()) {
                    post({ action: "set-timezone", timezone: tzInput.trim() }).then(() =>
                      setTzOpen(false)
                    );
                  }
                }}
                disabled={busy || !tzInput.trim()}
                variant="primary"
              >
                {t("timeApply", lang)}
              </Btn>
              <Btn onClick={() => setTzOpen(false)} disabled={busy}>
                {t("cancel", lang)}
              </Btn>
            </div>
          </div>
        )}

        {/* NTP row */}
        {!isLoading && data && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-zinc-400">{t("timeNtpSync", lang)}:</span>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                data.ntpSync
                  ? "border-emerald-700/40 bg-emerald-950/30 text-emerald-400"
                  : "border-red-700/40 bg-red-950/30 text-red-400"
              }`}
            >
              {data.ntpSync ? t("timeNtpSynced", lang) : t("timeNtpNotSynced", lang)}
            </span>
            <Btn
              onClick={() => post({ action: "enable-ntp" })}
              disabled={busy || data.ntpSync}
              variant="primary"
            >
              {t("timeEnableNtp", lang)}
            </Btn>
            <Btn
              onClick={() => post({ action: "disable-ntp" })}
              disabled={busy || !data.ntpSync}
              variant="warning"
            >
              {t("timeDisableNtp", lang)}
            </Btn>
          </div>
        )}

        {/* NTP servers */}
        {!isLoading && data && (
          <div>
            <div className="mb-2 text-xs font-medium text-zinc-400">{t("timeNtpServers", lang)}</div>
            <div className="flex flex-wrap gap-1 mb-2">
              {data.ntpServers.length ? (
                data.ntpServers.map((s, i) => (
                  <span
                    key={i}
                    className="rounded border border-zinc-700 bg-zinc-950/50 px-2 py-0.5 font-mono text-xs text-zinc-300"
                  >
                    {s}
                  </span>
                ))
              ) : (
                <span className="text-xs text-zinc-600">—</span>
              )}
            </div>
            <div className="flex gap-2 items-center">
              <TextInput
                value={ntpServerInput}
                onChange={setNtpServerInput}
                placeholder="ntp.ubuntu.com"
                className="w-56"
              />
              <Btn
                onClick={() => {
                  if (ntpServerInput.trim()) {
                    post({ action: "set-ntp-server", server: ntpServerInput.trim() }).then(() =>
                      setNtpServerInput("")
                    );
                  }
                }}
                disabled={busy || !ntpServerInput.trim()}
                variant="default"
              >
                {t("timeSetNtpServer", lang)}
              </Btn>
            </div>
          </div>
        )}

        {/* Clock drift */}
        {!isLoading && data && (
          <div>
            <div className="mb-1 text-xs font-medium text-zinc-400">{t("timeClockDrift", lang)}</div>
            {data.clockDrift === null ? (
              <span className="text-xs text-zinc-600">Drift: unknown</span>
            ) : data.driftWarning ? (
              <span className="text-xs font-medium text-red-400">
                ⚠ {data.clockDrift.toFixed(1)}ms — {t("timeDriftWarning", lang)}
              </span>
            ) : (
              <span className="text-xs text-emerald-400">
                Drift: {data.clockDrift.toFixed(1)}ms — {t("timeDriftOk", lang)}
              </span>
            )}
          </div>
        )}

        {/* Result feedback */}
        {result && (
          <div>
            {result.error && (
              <div className="rounded border border-red-700/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
                {result.error}
              </div>
            )}
            {result.ok && (
              <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-400">
                Done.
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Security Baseline ───────────────────────────────────────────

type BaselineCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "unknown";
  detail: string;
};

type BaselineData = {
  checks: BaselineCheck[];
  checkedAt: string;
};

const STATUS_STYLES: Record<BaselineCheck["status"], { bg: string; text: string; label: string }> = {
  pass:    { bg: "bg-emerald-950/50 border-emerald-700/40", text: "text-emerald-400", label: "Pass" },
  fail:    { bg: "bg-red-950/50 border-red-700/40",         text: "text-red-400",     label: "Fail" },
  warn:    { bg: "bg-amber-950/50 border-amber-700/40",     text: "text-amber-400",   label: "Warn" },
  unknown: { bg: "bg-zinc-800/50 border-zinc-700/40",       text: "text-zinc-400",    label: "?"    },
};

function SecurityBaseline({ id }: { id: string }) {
  const { data, isLoading, mutate } = useSWR<BaselineData>(
    `/api/servers/${id}/server/security-baseline`,
    fetcher,
    { refreshInterval: 60000 }
  );

  const checks = data?.checks ?? [];
  const passing = checks.filter((c) => c.status === "pass").length;
  const total = checks.length || 7;

  return (
    <Card>
      <CardHeader
        title="Security Baseline"
        desc="Automated checks for common host security settings"
        badge={
          !isLoading && data ? (
            <span className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
              {passing}/{total} passing
            </span>
          ) : undefined
        }
      />
      <div className="p-5 space-y-3">
        {isLoading && <p className="text-xs text-zinc-500">Running checks…</p>}
        {!isLoading && checks.length === 0 && <p className="text-xs text-zinc-500">No data</p>}
        {!isLoading && checks.length > 0 && (
          <div className="grid gap-2">
            {checks.map((check) => {
              const s = STATUS_STYLES[check.status];
              return (
                <div key={check.id} className={`flex items-start gap-3 rounded border px-3 py-2 ${s.bg}`}>
                  <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.text} border-current`}>
                    {s.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-200">{check.label}</div>
                    <div className="text-xs text-zinc-400 mt-0.5">{check.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between pt-1">
          {data?.checkedAt && (
            <span className="text-[11px] text-zinc-600">
              Last checked: {new Date(data.checkedAt).toLocaleTimeString()}
            </span>
          )}
          <Btn onClick={() => mutate()} disabled={isLoading} variant="default">Re-check</Btn>
        </div>
      </div>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────
export default function ServerScopedPage() {
  const { lang } = useUI();
  const rtl = isRTL(lang);
  const params = useParams<{ id: string }>();
  const id = params.id;

  return (
    <div dir={rtl ? "rtl" : "ltr"}>
      <PageHeader title={t("serverTitle", lang)} desc={t("serverDesc", lang)} />
      <div className="space-y-6 p-6">
        <DockerDaemonSection lang={lang} id={id} />
        <SSHSection lang={lang} id={id} />
        <FirewallSection lang={lang} id={id} />
        <PortAuditSection lang={lang} id={id} />
        <NetworkSection lang={lang} id={id} />
        <SystemServicesSection lang={lang} id={id} />
        <OSSection lang={lang} id={id} />
        <ResourcesSection lang={lang} id={id} />
        <TimeSection lang={lang} id={id} />
        <SecurityBaseline id={id} />
      </div>
    </div>
  );
}
