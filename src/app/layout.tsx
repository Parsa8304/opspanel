import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "OpsPanel";

export const metadata: Metadata = {
  title: APP_NAME,
  description:
    "Self-hosted DevOps control panel — containers, deployments, servers, and infrastructure in one dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" className="dark">
      <body className="antialiased">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
