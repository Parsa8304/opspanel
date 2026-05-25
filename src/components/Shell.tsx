"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { NAV, t } from "@/lib/i18n";
import { useUI } from "./Providers";
import { fetcher } from "@/lib/fetcher";
import {
  Moon, Sun, Globe, LogOut,
  LayoutDashboard, Boxes, Server, Network, Workflow,
  Package, Rocket, GitMerge, FlaskConical,
  ClipboardCheck, BarChart2, Sparkles,
  ShieldCheck, Bell, Plug, DollarSign, FileText, Search, Settings,
} from "lucide-react";

type NavKey = typeof NAV[number]["key"];

/* ─── Sidebar grouping ──────────────────────────────────────────────────── */
const NAV_GROUPS: { en: string; fa: string; items: NavKey[] }[] = [
  { en: "Dashboard",         fa: "داشبورد",         items: ["overview"] },
  { en: "Operations",        fa: "عملیات",           items: ["containers", "server", "ports", "async"] },
  { en: "Delivery",          fa: "تحویل",            items: ["deployments", "deploy", "migration", "tests"] },
  { en: "Quality",           fa: "کیفیت",            items: ["qa", "benchmarks", "ai-quality"] },
  { en: "Security & Control",fa: "امنیت و کنترل",   items: ["access", "alerts", "integrations"] },
  { en: "Business",          fa: "کسب‌وکار",         items: ["billing", "reports", "discovery"] },
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
};

/* ─── Shell ─────────────────────────────────────────────────────────────── */
export function Shell({ children }: { children: React.ReactNode }) {
  const { lang, theme, setLang, setTheme } = useUI();
  const path = usePathname();
  const router = useRouter();
  const { data: me } = useSWR("/api/auth/me", fetcher);

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
      {/* ── Sidebar ── */}
      <aside
        className="w-64 shrink-0 flex flex-col"
        style={{ background: "#0b111a", borderInlineEnd: "1px solid var(--border)" }}
      >
        {/* Logo / App name */}
        <div
          className="flex items-center gap-2.5 px-4 py-[14px]"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[10px] font-black tracking-tight"
            style={{ background: "var(--primary)", color: "var(--accent)" }}
          >
            MN
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
                  style={{ color: "#3d4d60" }}
                >
                  {lang === "fa" ? group.fa : group.en}
                </p>

                {/* Nav items */}
                {items.map((nav) => {
                  const active =
                    nav.href === "/" ? path === "/" : path.startsWith(nav.href);
                  return (
                    <Link
                      key={nav.key}
                      href={nav.href}
                      className={`sidebar-item${active ? " active" : ""}`}
                    >
                      <span className="sidebar-icon">
                        {NAV_ICON[nav.key as NavKey]}
                      </span>
                      <span className="truncate min-w-0">
                        {lang === "fa" ? nav.fa : nav.en}
                      </span>
                    </Link>
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
