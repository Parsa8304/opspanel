"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import {
  GitBranch,
  GitCommit,
  RotateCcw,
  Rocket,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
} from "lucide-react";

const ENVS = ["DEV", "STAGING", "DEMO", "OPERATIONAL", "PROD"] as const;
const PROVIDERS = ["local", "github", "gitlab", "gitea"] as const;

type Lang = "en" | "fa";

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
    throw new Error(msg);
  }
  return r.json();
}

type Commit = {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  changedFiles: string[];
};
type MatrixRow = {
  environment: string;
  deployed: boolean;
  version: string | null;
  shortSha: string | null;
  deployedBy: string | null;
  deployedAt: string | null;
};
type Deployment = {
  id: string;
  environment: string;
  commitSha: string;
  version: string | null;
  status: string;
};
type Release = {
  id: string;
  version: string;
  commitSha: string;
  changelog: string | null;
  date: string;
  deployedBy: { name: string } | null;
};

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-6 my-6 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default function Page() {
  const { lang } = useUI();
  const L = lang as Lang;

  const { data: cfg, mutate: mutCfg } = useSWR("/api/git/config", fetcher);
  const { data: commitsRes, mutate: mutCommits } = useSWR(
    "/api/git/commits?limit=30",
    fetcher
  );
  const { data: matrix, mutate: mutMatrix } = useSWR<MatrixRow[]>(
    "/api/deployments/matrix",
    fetcher
  );
  const { data: deployments, mutate: mutDeps } = useSWR<Deployment[]>(
    "/api/deployments",
    fetcher
  );
  const { data: releases, mutate: mutReleases } = useSWR<Release[]>(
    "/api/releases",
    fetcher
  );
  const { data: tagsRes } = useSWR("/api/git/tags", fetcher);
  const tagList: { name: string }[] = tagsRes?.tags || [];

  const [form, setForm] = useState<any>(null);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diffA, setDiffA] = useState("");
  const [diffB, setDiffB] = useState("");
  const [diff, setDiff] = useState<any>(null);
  const [rel, setRel] = useState({ version: "", commitSha: "", changelog: "" });

  const configured = commitsRes?.configured !== false;
  const commits: Commit[] = commitsRes?.commits || [];
  const cfgForm = form ?? cfg ?? { provider: "local" };

  const saveConfig = async () => {
    setErr("");
    try {
      await api("/api/git/config", "PUT", {
        provider: cfgForm.provider || "local",
        repoPath: cfgForm.repoPath || null,
        repoUrl: cfgForm.repoUrl || null,
        branch: cfgForm.branch || null,
        token: cfgForm.token || null,
      });
      setForm(null);
      mutCfg();
      mutCommits();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const deployCommit = async (sha: string, env: string) => {
    setErr("");
    try {
      await api("/api/deployments", "POST", {
        environment: env,
        commitSha: sha,
      });
      mutMatrix();
      mutDeps();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const rollback = async (id: string) => {
    if (!confirm(t("rollbackConfirm", L))) return;
    setErr("");
    try {
      await api(`/api/deployments/${id}/rollback`, "POST");
      mutMatrix();
      mutDeps();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const computeDiff = async () => {
    setErr("");
    setDiff(null);
    try {
      const r = await fetcher(
        `/api/git/diff?a=${encodeURIComponent(diffA)}&b=${encodeURIComponent(
          diffB
        )}`
      );
      setDiff(r.diff);
    } catch (e: any) {
      setErr(e.info?.error || e.message);
    }
  };

  const createRelease = async () => {
    setErr("");
    try {
      await api("/api/releases", "POST", {
        version: rel.version,
        commitSha: rel.commitSha,
        changelog: rel.changelog || null,
      });
      setRel({ version: "", commitSha: "", changelog: "" });
      mutReleases();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const envsForCommit = (sha: string) =>
    (deployments || [])
      .filter((d) => d.status === "active" && d.commitSha === sha)
      .map((d) => d.environment);

  return (
    <div className="pb-10">
      <PageHeader
        title={t("deployTracking", L)}
        desc={t("deployTrackingDesc", L)}
      />

      {err && (
        <div className="mx-6 mt-4 rounded border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-500">
          {err}
        </div>
      )}

      {/* Git config */}
      <Section
        title={t("gitConfig", L)}
        icon={<SettingsIcon size={16} className="text-emerald-500" />}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("provider", L)}</span>
            <select
              value={cfgForm.provider || "local"}
              onChange={(e) =>
                setForm({ ...cfgForm, provider: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p} className="dark:bg-zinc-900">
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("repoPath", L)}</span>
            <input
              value={cfgForm.repoPath || ""}
              onChange={(e) =>
                setForm({ ...cfgForm, repoPath: e.target.value })
              }
              placeholder="/home/parsa/panel"
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("repoUrl", L)}</span>
            <input
              value={cfgForm.repoUrl || ""}
              onChange={(e) =>
                setForm({ ...cfgForm, repoUrl: e.target.value })
              }
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("branch", L)}</span>
            <input
              value={cfgForm.branch || ""}
              onChange={(e) => setForm({ ...cfgForm, branch: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("token", L)}</span>
            <input
              value={cfgForm.token || ""}
              onChange={(e) => setForm({ ...cfgForm, token: e.target.value })}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={saveConfig}
            className="rounded bg-[#183661] px-3 py-1.5 text-sm text-white hover:bg-[#1e478e]"
          >
            {t("saveConfig", L)}
          </button>
          <Link
            href="/settings"
            className="text-sm text-emerald-500 hover:underline"
          >
            {t("goToSettings", L)}
          </Link>
        </div>
      </Section>

      {/* Environment matrix */}
      <Section
        title={t("envMatrix", L)}
        icon={<Rocket size={16} className="text-emerald-500" />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-start text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="py-2 text-start">{t("colEnvironment", L)}</th>
                <th className="py-2 text-start">{t("colVersion", L)}</th>
                <th className="py-2 text-start">{t("colCommit", L)}</th>
                <th className="py-2 text-start">{t("colDeployedBy", L)}</th>
                <th className="py-2 text-start">{t("colDeployedAt", L)}</th>
              </tr>
            </thead>
            <tbody>
              {(matrix || ENVS.map((e) => ({ environment: e }) as any)).map(
                (row: MatrixRow) => (
                  <tr
                    key={row.environment}
                    className="border-b border-zinc-100 dark:border-zinc-800/60"
                  >
                    <td className="py-2 font-medium">{row.environment}</td>
                    <td className="py-2">
                      {row.deployed ? (
                        row.version || "—"
                      ) : (
                        <span className="text-zinc-500">
                          {t("notDeployed", L)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {row.shortSha || "—"}
                    </td>
                    <td className="py-2">{row.deployedBy || "—"}</td>
                    <td className="py-2">
                      {row.deployedAt ? fmtDate(row.deployedAt, L) : "—"}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Commit history */}
      <Section
        title={t("commitHistory", L)}
        icon={<GitCommit size={16} className="text-emerald-500" />}
      >
        {!configured ? (
          <div className="rounded border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            {t("gitNotConfigured", L)}{" "}
            <Link href="/settings" className="text-emerald-500 hover:underline">
              {t("goToSettings", L)}
            </Link>
          </div>
        ) : commits.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noCommits", L)}</p>
        ) : (
          <ul className="space-y-2">
            {commits.map((c) => {
              const onEnvs = envsForCommit(c.sha);
              const open = expanded[c.sha];
              return (
                <li
                  key={c.sha}
                  className="rounded border border-zinc-200 dark:border-zinc-800 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-emerald-500">
                      {c.shortSha}
                    </span>
                    <span className="font-medium">{c.message}</span>
                    <span className="text-zinc-500">· {c.author}</span>
                    <span className="text-zinc-500">
                      · {fmtDate(c.date, L)}
                    </span>
                    {onEnvs.map((e) => (
                      <span
                        key={e}
                        className="rounded bg-emerald-600/15 px-1.5 py-0.5 text-xs text-emerald-500"
                      >
                        {t("onEnvs", L)} {e}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() =>
                        setExpanded((s) => ({ ...s, [c.sha]: !s[c.sha] }))
                      }
                      className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      {open ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      {c.changedFiles.length} {t("changedFiles", L)}
                    </button>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value)
                          deployCommit(c.sha, e.target.value);
                        e.target.value = "";
                      }}
                      className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-0.5 text-xs"
                    >
                      <option value="" className="dark:bg-zinc-900">
                        {t("deployToEnv", L)}
                      </option>
                      {ENVS.map((e) => (
                        <option
                          key={e}
                          value={e}
                          className="dark:bg-zinc-900"
                        >
                          {e}
                        </option>
                      ))}
                    </select>
                  </div>
                  {open && c.changedFiles.length > 0 && (
                    <ul className="mt-2 space-y-0.5 font-mono text-xs text-zinc-500">
                      {c.changedFiles.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Release log */}
      <Section
        title={t("releaseLog", L)}
        icon={<GitBranch size={16} className="text-emerald-500" />}
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <input
            placeholder={t("colVersion", L)}
            value={rel.version}
            onChange={(e) => setRel({ ...rel, version: e.target.value })}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <input
            placeholder={t("colCommit", L)}
            value={rel.commitSha}
            onChange={(e) => setRel({ ...rel, commitSha: e.target.value })}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
          />
          <input
            placeholder={t("colChangelog", L)}
            value={rel.changelog}
            onChange={(e) => setRel({ ...rel, changelog: e.target.value })}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1"
          />
          <button
            onClick={createRelease}
            className="rounded bg-[#183661] px-3 py-1 text-white hover:bg-[#1e478e]"
          >
            {t("create", L)}
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          {t("autoChangelogHint", L)}
        </p>
        {!releases || releases.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("noReleases", L)}</p>
        ) : (
          <ul className="space-y-2">
            {releases.map((r) => {
              const open = expanded["rel-" + r.id];
              return (
                <li
                  key={r.id}
                  className="rounded border border-zinc-200 dark:border-zinc-800 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.version}</span>
                    <span className="font-mono text-xs text-emerald-500">
                      {r.commitSha.slice(0, 8)}
                    </span>
                    <span className="text-zinc-500">
                      {fmtDate(r.date, L)}
                    </span>
                    <span className="text-zinc-500">
                      {r.deployedBy?.name || "—"}
                    </span>
                  </div>
                  {r.changelog && (
                    <button
                      onClick={() =>
                        setExpanded((s) => ({
                          ...s,
                          ["rel-" + r.id]: !s["rel-" + r.id],
                        }))
                      }
                      className="mt-2 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      {open ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      {t("colChangelog", L)}
                    </button>
                  )}
                  {open && r.changelog && (
                    <pre className="mt-2 whitespace-pre-wrap rounded bg-zinc-100 dark:bg-zinc-800/60 p-2 text-xs">
                      {r.changelog}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Diff view */}
      <Section
        title={t("diffView", L)}
        icon={<GitCommit size={16} className="text-emerald-500" />}
      >
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("refA", L)}</span>
            <input
              value={diffA}
              onChange={(e) => setDiffA(e.target.value)}
              placeholder="sha / tag"
              list="git-refs"
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">{t("refB", L)}</span>
            <input
              value={diffB}
              onChange={(e) => setDiffB(e.target.value)}
              placeholder="sha / tag"
              list="git-refs"
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 font-mono"
            />
            <datalist id="git-refs">
              {tagList.map((tg) => (
                <option key={tg.name} value={tg.name} />
              ))}
              {commits.map((c) => (
                <option key={c.sha} value={c.shortSha} />
              ))}
            </datalist>
          </label>
          <button
            onClick={computeDiff}
            disabled={!diffA || !diffB}
            className="rounded bg-[#183661] px-3 py-1.5 text-white hover:bg-[#1e478e] disabled:opacity-50"
          >
            {t("computeDiff", L)}
          </button>
        </div>
        {diff && (
          <div className="mt-4 text-sm">
            <p className="text-zinc-500">
              {diff.summary.files} {t("changedFiles", L)} ·{" "}
              {diff.summary.insertions} {t("insertions", L)} ·{" "}
              {diff.summary.deletions} {t("deletions", L)}
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              {diff.files.map((f: any) => (
                <li key={f.file}>
                  <span className="me-2 text-emerald-500">{f.status}</span>
                  {f.file}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Recent deployments with rollback */}
      <Section
        title="Deployments"
        icon={<RotateCcw size={16} className="text-emerald-500" />}
      >
        {!deployments || deployments.length === 0 ? (
          <EmptyState msg={t("notDeployed", L)} />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="py-2 text-start">{t("colEnvironment", L)}</th>
                <th className="py-2 text-start">{t("colCommit", L)}</th>
                <th className="py-2 text-start">{t("colVersion", L)}</th>
                <th className="py-2 text-start">{t("colStatus", L)}</th>
                <th className="py-2 text-start"></th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-zinc-100 dark:border-zinc-800/60"
                >
                  <td className="py-2">{d.environment}</td>
                  <td className="py-2 font-mono text-xs">
                    {d.commitSha.slice(0, 8)}
                  </td>
                  <td className="py-2">{d.version || "—"}</td>
                  <td className="py-2">{d.status}</td>
                  <td className="py-2 text-end">
                    <button
                      onClick={() => rollback(d.id)}
                      className="flex items-center gap-1 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <RotateCcw size={12} />
                      {t("rollback", L)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
