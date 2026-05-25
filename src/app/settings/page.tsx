"use client";
import { PageHeader, EmptyState } from "@/components/Shell";
import { useUI } from "@/components/Providers";
import { t } from "@/lib/i18n";

export default function Page() {
  const { lang } = useUI();
  return (
    <div>
      <PageHeader title="Settings" />
      <EmptyState msg={t("comingSoon", lang)} />
    </div>
  );
}
