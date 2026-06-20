"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { NAV, t } from "@/lib/i18n";
import { useUI } from "./Providers";
import { fetcher } from "@/lib/fetcher";
import { CommandPalette } from "./CommandPalette";
import {
  Moon, Sun, Globe, LogOut,
  LayoutDashboard, Boxes, Server, Network, Workflow,
  Package, Rocket, GitMerge, FlaskConical,
  ClipboardCheck, BarChart2, Sparkles,
  ShieldCheck, Bell, Plug, DollarSign, FileText, Search, Settings,
  ScrollText, BookOpen, HardDrive, Globe2, CalendarClock,
  GitFork, GitCompare, Share2, CloudUpload, Router, Dot,
} from "lucide-react";

type NavKey = typeof NAV[number]["key"];

/* ─── Sidebar grouping ──────────────────────────────────────────────────── */
const NAV_GROUPS: { en: string; fa: string; items: NavKey[] }[] = [
  { en: "Dashboard",         fa: "داشبورد",         items: ["overview"] },
  { en: "Operations",        fa: "عملیات",           items: ["containers", "server", "ports", "async", "logs", "runbooks", "depmap"] },
  { en: "Delivery",          fa: "تحویل",            items: ["deployments", "deploy", "migration", "tests"] },
  { en: "Quality",           fa: "کیفیت",            items: ["qa", "benchmarks", "ai-quality"] },
  { en: "Security & Control",fa: "امنیت و کنترل",   items: ["access", "alerts", "integrations"] },
  { en: "Business",          fa: "کسب‌وکار",         items: ["billing", "reports", "discovery"] },
  { en: "Infrastructure",    fa: "زیرساخت",          items: ["backup", "domains", "crons", "infra", "servers"] },
  { en: "System",            fa: "سیستم",            items: ["settings"] },
];

const NAV_ICON: Record<NavKey, React.ReactNode> = {
  overview:    <LayoutDashboard size={15} />,
  containers:  <Boxes size={15} />,
  server:      <Server size={15} />,
  ports:       <Network size={15} />,
  async:       <Workflow size={15} />,
  deployments: <Package size={15} />,
  deploy:      <Rocket size={15} />,
  migration:   <GitMerge size={15} />,
  tests:       <FlaskConical size={15} />,
  qa:          <ClipboardCheck size={15} />,
  benchmarks:  <BarChart2 size={15} />,
  "ai-quality":<Sparkles size={15} />,
  access:      <ShieldCheck size={15} />,
  alerts:      <Bell size={15} />,
  integrations:<Plug size={15} />,
  billing:     <DollarSign size={15} />,
  reports:     <FileText size={15} />,
  discovery:   <Search size={15} />,
  settings:    <Settings size={15} />,
  logs:           <ScrollText size={15} />,
  runbooks:       <BookOpen size={15} />,
  backup:         <HardDrive size={15} />,
  domains:        <Globe2 size={15} />,
  crons:          <CalendarClock size={15} />,
  drift:          <GitFork size={15} />,
  compare:        <GitCompare size={15} />,
  depmap:         <Share2 size={15} />,
  infra:          <CloudUpload size={15} />,
  servers:        <Router size={15} />,
};

/* ─── Shell ─────────────────────────────────────────────────────────────── */
export function Shell({ children }: { children: React.ReactNode }) {
  const { lang, theme, setLang, setTheme } = useUI();
  const path = usePathname();
  const router = useRouter();
  const { data: me } = useSWR("/api/auth/me", fetcher);
  const { data: serversData } = useSWR<{ servers: { id: string; name: string }[] }>(
    "/api/servers", fetcher, { refreshInterval: 30000 }
  );
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, []);

  if (path === "/login") return <>{children}</>;

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  return (
    <div
      className="flex min-h-screen"
      style={{ background: "var(--bg-main)", color: "var(--text-main)" }}
    >
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {/* ── Sidebar ── */}
      <aside
        className="w-64 shrink-0 flex flex-col"
        style={{ background: "#061318", borderInlineEnd: "1px solid var(--border)" }}
      >
        {/* Logo / App name */}
        <div
          className="flex items-center gap-2.5 px-4 py-[14px]"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {/* Terminal-glyph logo mark */}
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
            style={{
              background: "linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)",
              boxShadow: "0 2px 8px rgba(99,102,241,0.35)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 8l4 4-4 4"
                stroke="#ffffff"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12.5 16h6"
                stroke="#ffffff"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="truncate text-[13px] font-semibold leading-tight text-white">
            {t("appName", lang)}
          </span>
        </div>

        {/* Navigation groups */}
        <nav className="flex-1 overflow-y-auto py-1">
          {NAV_GROUPS.map((group) => {
            const items = group.items
              .map((key) => NAV.find((n) => n.key === key))
              .filter(Boolean) as (typeof NAV)[number][];
            if (!items.length) return null;

            return (
              <div key={group.en} className="mb-1">
                {/* Group label */}
                <p
                  className="px-[18px] pt-4 pb-[5px] text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: "#3f5a63" }}
                >
                  {lang === "fa" ? group.fa : group.en}
                </p>

                {/* Nav items */}
                {items.map((nav) => {
                  const active =
                    nav.href === "/" ? path === "/" : path.startsWith(nav.href);
                  return (
                    <div key={nav.key}>
                      <Link
                        href={nav.href}
                        className={`sidebar-item${active && nav.key !== "servers" ? " active" : ""}`}
                      >
                        <span className="sidebar-icon">
                          {NAV_ICON[nav.key as NavKey]}
                        </span>
                        <span className="truncate min-w-0">
                          {lang === "fa" ? nav.fa : nav.en}
                        </span>
                      </Link>
                      {nav.key === "servers" && serversData?.servers?.map((s) => {
                        const href = `/servers/${s.id}`;
                        const subActive = path === href;
                        return (
                          <Link
                            key={s.id}
                            href={href}
                            className={`sidebar-item${subActive ? " active" : ""}`}
                            style={{ paddingInlineStart: 30 }}
                          >
                            <span className="sidebar-icon">
                              <Dot size={15} />
                            </span>
                            <span className="truncate min-w-0">{s.name}</span>
                          </Link>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 space-y-2" style={{ borderTop: "1px solid var(--border)" }}>
          {me && (
            <div className="flex items-center gap-2 px-1">
              <span
                className="truncate text-[11px] min-w-0"
                style={{ color: "var(--text-muted)" }}
              >
                {me.name}
              </span>
              <span
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                style={{ background: "var(--primary)", color: "var(--accent)" }}
              >
                {me.role}
              </span>
            </div>
          )}

          <button
            onClick={() => setPaletteOpen(true)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              marginBottom: 8,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "5px 8px",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            <span>Search…</span>
            <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "rgba(255,255,255,0.08)", border: "1px solid var(--border)", fontFamily: "monospace" }}>⌘K</span>
          </button>

          <div className="flex gap-1.5">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="sidebar-btn"
              title={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
            </button>
            <button
              onClick={() => setLang(lang === "fa" ? "en" : "fa")}
              className="sidebar-btn"
            >
              <Globe size={12} />
              <span>{lang === "fa" ? "EN" : "فا"}</span>
            </button>
            <button
              onClick={logout}
              title={t("signOut", lang)}
              className="sidebar-btn danger"
            >
              <LogOut size={13} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-x-hidden min-w-0">{children}</main>
    </div>
  );
}

/* ─── PageHeader ─────────────────────────────────────────────────────────── */
export function PageHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div
      className="px-6 py-5"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-main)" }}
    >
      <h1 className="text-xl font-bold" style={{ color: "var(--text-main)" }}>
        {title}
      </h1>
      {desc && (
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          {desc}
        </p>
      )}
    </div>
  );
}

/* ─── EmptyState ─────────────────────────────────────────────────────────── */
export function EmptyState({ msg }: { msg: string }) {
  return (
    <div
      className="m-6 rounded-xl p-10 text-center text-sm"
      style={{ border: "1px dashed var(--border)", color: "var(--text-muted)" }}
    >
      {msg}
    </div>
  );
}
