"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import {
  Server, Boxes, CalendarClock, Network, Globe2, HardDrive,
} from "lucide-react";

const SUB_TABS = [
  { key: "overview", label: "Overview", href: "", icon: <Server size={13} /> },
  { key: "containers", label: "Containers", href: "/containers", icon: <Boxes size={13} /> },
  { key: "crons", label: "Crons", href: "/crons", icon: <CalendarClock size={13} /> },
  { key: "ports", label: "Ports", href: "/ports", icon: <Network size={13} /> },
  { key: "domains", label: "Domains", href: "/domains", icon: <Globe2 size={13} /> },
  { key: "backup", label: "Backup", href: "/backup", icon: <HardDrive size={13} /> },
];

export default function ServerLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const id = params.id;
  const base = `/servers/${id}`;

  return (
    <div>
      <div
        className="flex items-center gap-1 px-6 pt-2 overflow-x-auto"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {SUB_TABS.map((tab) => {
          const href = `${base}${tab.href}`;
          const active = tab.href === "" ? pathname === base : pathname.startsWith(href);
          return (
            <Link
              key={tab.key}
              href={href}
              className="flex items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors"
              style={{
                borderColor: active ? "var(--primary)" : "transparent",
                color: active ? "var(--text-main)" : "var(--text-muted)",
                fontWeight: active ? 600 : 400,
              }}
            >
              {tab.icon}
              {tab.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
