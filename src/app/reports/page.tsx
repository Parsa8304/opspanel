"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t, fmtDate, type Lang } from "@/lib/i18n";
import { fetcher } from "@/lib/fetcher";
import { FileText, FileCode, FileDown, Trash2, RefreshCw, GitCompare } from "lucide-react";

type Mode = "INTERNAL" | "REVIEWER";
type RLang = "EN" | "FA";

const SECTION_KEYS = [
  ["qa", "repSecQa"],
  ["containers", "repSecContainers"],
  ["integrations", "repSecIntegrations"],
  ["async", "repSecAsync"],
  ["deployments", "repSecDeployments"],
  ["tests", "repSecTests"],
  ["benchmarks", "repSecBenchmarks"],
  ["aiQuality", "repSecAiQuality"],
  ["access", "repSecAccess"],
] as const;

type SavedReport = {
  id: string;
  title: string;
  mode: Mode;
  language: RLang;
  version: number;
  createdAt: string;
  createdBy: { name: string } | null;
};

export default function Page() {
  const { lang } = useUI();
  const { data, mutate } = useSWR<{
    reports: SavedReport[];
    pdfAvailable: boolean;
  }>("/api/reports", fetcher);

  const [title, setTitle] = useState("Stakeholder Review");
  const [mode, setMode] = useState<Mode>("INTERNAL");
  const [rlang, setRlang] = useState<RLang>("EN");
  const [sections, setSections] = useState<Record<string, boolean>>(
    Object.fromEntries(SECTION_KEYS.map(([k]) => [k, true]))
  );
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const body = useMemo(
    () => ({ title, mode, language: rlang, sections }),
    [title, mode, rlang, sections]
  );

  const doPreview = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/reports/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      setPreviewHtml(await r.text());
    } catch (e: any) {
      setErr(e?.message || "preview failed");
    } finally {
      setBusy(false);
    }
  };

  const doGenerate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (r.status === 403) throw new Error(t("repNeedReviewer", lang));
      if (!r.ok) throw new Error((await r.json())?.error || "generate failed");
      await mutate();
      await doPreview();
    } catch (e: any) {
      setErr(e?.message || "generate failed");
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    if (!confirm(t("repDeleteConfirm", lang))) return;
    await fetch(`/api/reports/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await mutate();
  };

  const pdfAvailable = data?.pdfAvailable ?? false;

  // Group by title for version history.
  const byTitle = useMemo(() => {
    const reports = data?.reports ?? [];
    const m = new Map<string, SavedReport[]>();
    for (const r of reports) {
      if (!m.has(r.title)) m.set(r.title, []);
      m.get(r.title)!.push(r);
    }
    return Array.from(m.entries());
  }, [data]);

  return (
    <div>
      <PageHeader title={t("repTitle", lang)} desc={t("repDesc", lang)} />
      <div className="p-6 grid gap-6 lg:grid-cols-2">
        {/* Builder */}
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-4">
            <h2 className="font-semibold text-sm">{t("repBuilder", lang)}</h2>

            <label className="block text-sm">
              <span className="text-zinc-500">{t("repReportTitle", lang)}</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
              />
            </label>

            <div className="text-sm">
              <span className="text-zinc-500">{t("repMode", lang)}</span>
              <div className="mt-1 flex gap-2">
                {(["INTERNAL", "REVIEWER"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`flex-1 rounded border px-3 py-1.5 text-sm ${
                      mode === m
                        ? "bg-indigo-600 text-white border-indigo-500"
                        : "border-zinc-300 dark:border-zinc-700"
                    }`}
                  >
                    {t(
                      m === "INTERNAL" ? "repModeInternal" : "repModeReviewer",
                      lang
                    )}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {t(
                  mode === "INTERNAL"
                    ? "repModeInternalHint"
                    : "repModeReviewerHint",
                  lang
                )}
              </p>
            </div>

            <div className="text-sm">
              <span className="text-zinc-500">{t("repLanguage", lang)}</span>
              <div className="mt-1 flex gap-2">
                {(["EN", "FA"] as RLang[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setRlang(l)}
                    className={`flex-1 rounded border px-3 py-1.5 text-sm ${
                      rlang === l
                        ? "bg-indigo-600 text-white border-indigo-500"
                        : "border-zinc-300 dark:border-zinc-700"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="text-sm">
              <span className="text-zinc-500">{t("repSections", lang)}</span>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {SECTION_KEYS.map(([k, label]) => (
                  <label
                    key={k}
                    className="flex items-center gap-2 text-sm py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={!!sections[k]}
                      onChange={(e) =>
                        setSections((s) => ({ ...s, [k]: e.target.checked }))
                      }
                    />
                    {t(label, lang)}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={doPreview}
                disabled={busy}
                className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw size={14} /> {t("repPreview", lang)}
              </button>
              <button
                onClick={doGenerate}
                disabled={busy}
                className="rounded bg-indigo-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {busy ? t("repGenerating", lang) : t("repGenerate", lang)}
              </button>
            </div>
            {err && (
              <p className="text-xs text-red-600 dark:text-red-400">{err}</p>
            )}
            <p className="text-xs text-zinc-500">{t("repPreviewHint", lang)}</p>
          </div>

          {/* Saved list */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
            <h2 className="font-semibold text-sm mb-3">{t("repSaved", lang)}</h2>
            {byTitle.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("repNoSaved", lang)}</p>
            ) : (
              <div className="space-y-4">
                {byTitle.map(([gt, versions]) => (
                  <TitleGroup
                    key={gt}
                    title={gt}
                    versions={versions}
                    lang={lang}
                    pdfAvailable={pdfAvailable}
                    onDelete={del}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="border-b border-zinc-200 dark:border-zinc-800 px-4 py-2 text-sm font-semibold flex items-center justify-between">
            <span>{t("repPreview", lang)}</span>
            <span className="text-xs text-zinc-500">
              {mode} · {rlang}
            </span>
          </div>
          {previewHtml ? (
            <iframe
              title="report-preview"
              srcDoc={previewHtml}
              className="w-full"
              style={{ height: "75vh", border: "0", background: "#fff" }}
            />
          ) : (
            <EmptyState msg={t("repPreviewHint", lang)} />
          )}
        </div>
      </div>
    </div>
  );
}

function TitleGroup({
  title,
  versions,
  lang,
  pdfAvailable,
  onDelete,
}: {
  title: string;
  versions: SavedReport[];
  lang: Lang;
  pdfAvailable: boolean;
  onDelete: (id: string) => void;
}) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const [a, setA] = useState<number>(
    sorted.length > 1 ? sorted[1].version : sorted[0].version
  );
  const [b, setB] = useState<number>(sorted[0].version);
  const refId = sorted[0].id;
  const { data: cmp } = useSWR<{
    diff:
      | {
          key: string;
          label: string;
          from: number | null;
          to: number | null;
          delta: number | null;
        }[]
      | null;
  }>(
    versions.length > 1
      ? `/api/reports/${refId}/versions?a=${a}&b=${b}`
      : null,
    fetcher
  );

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded p-3">
      <div className="font-medium text-sm mb-2">{title}</div>
      <table className="w-full text-xs">
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.id}
              className="border-t border-zinc-100 dark:border-zinc-800"
            >
              <td className="py-1.5 pe-2">
                {t("repVersion", lang)} {r.version}
              </td>
              <td className="py-1.5 pe-2 text-zinc-500">
                {r.mode} · {r.language}
              </td>
              <td className="py-1.5 pe-2 text-zinc-500">
                {fmtDate(r.createdAt, lang)}
                {r.createdBy ? ` · ${r.createdBy.name}` : ""}
              </td>
              <td className="py-1.5">
                <div className="flex gap-1.5 items-center justify-end">
                  <a
                    href={`/api/reports/${r.id}/export?format=md`}
                    title={t("repExportMd", lang)}
                    className="p-1 rounded border border-zinc-300 dark:border-zinc-700"
                  >
                    <FileText size={13} />
                  </a>
                  <a
                    href={`/api/reports/${r.id}/export?format=html`}
                    title={t("repExportHtml", lang)}
                    className="p-1 rounded border border-zinc-300 dark:border-zinc-700"
                  >
                    <FileCode size={13} />
                  </a>
                  {pdfAvailable ? (
                    <a
                      href={`/api/reports/${r.id}/export?format=pdf`}
                      title={t("repExportPdf", lang)}
                      className="p-1 rounded border border-zinc-300 dark:border-zinc-700"
                    >
                      <FileDown size={13} />
                    </a>
                  ) : (
                    <span
                      title={t("repPdfUnavailable", lang)}
                      className="p-1 rounded border border-zinc-200 dark:border-zinc-800 opacity-40 cursor-not-allowed"
                    >
                      <FileDown size={13} />
                    </span>
                  )}
                  <button
                    onClick={() => onDelete(r.id)}
                    title={t("repDelete", lang)}
                    className="p-1 rounded border border-zinc-300 dark:border-zinc-700 text-red-600"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {versions.length > 1 && (
        <div className="mt-3 border-t border-zinc-100 dark:border-zinc-800 pt-2">
          <div className="flex items-center gap-2 text-xs mb-2">
            <GitCompare size={13} />
            <span className="text-zinc-500">{t("repCompare", lang)}</span>
            <select
              value={a}
              onChange={(e) => setA(Number(e.target.value))}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1 py-0.5"
            >
              {sorted.map((r) => (
                <option key={r.id} value={r.version}>
                  v{r.version}
                </option>
              ))}
            </select>
            <span>→</span>
            <select
              value={b}
              onChange={(e) => setB(Number(e.target.value))}
              className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1 py-0.5"
            >
              {sorted.map((r) => (
                <option key={r.id} value={r.version}>
                  v{r.version}
                </option>
              ))}
            </select>
          </div>
          {cmp?.diff && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 text-left">
                  <th className="py-1">{t("repDiffMetric", lang)}</th>
                  <th className="py-1">{t("repDiffFrom", lang)}</th>
                  <th className="py-1">{t("repDiffTo", lang)}</th>
                  <th className="py-1">{t("repDiffDelta", lang)}</th>
                </tr>
              </thead>
              <tbody>
                {cmp.diff
                  .filter((d) => d.delta !== 0)
                  .map((d) => (
                    <tr
                      key={d.key}
                      className="border-t border-zinc-100 dark:border-zinc-800"
                    >
                      <td className="py-1">{d.label}</td>
                      <td className="py-1">{d.from ?? "—"}</td>
                      <td className="py-1">{d.to ?? "—"}</td>
                      <td
                        className={`py-1 ${
                          d.delta == null
                            ? "text-zinc-500"
                            : d.delta > 0
                            ? "text-emerald-600"
                            : "text-red-600"
                        }`}
                      >
                        {d.delta == null
                          ? "—"
                          : `${d.delta > 0 ? "+" : ""}${d.delta}`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <p className="mt-1 text-[11px] text-zinc-500">
            {t("repCompareHint", lang)}
          </p>
        </div>
      )}
    </div>
  );
}
