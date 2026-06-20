import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";

const sans = Outfit({ subsets: ["latin"], variable: "--font-ui", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-code", display: "swap" });

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
    <html lang="en" dir="ltr" className={`dark ${sans.variable} ${mono.variable}`}>
      <body className="antialiased">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
