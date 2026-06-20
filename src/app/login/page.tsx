"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUI } from "@/components/Providers";
import { t } from "@/lib/i18n";

type Step = "credentials" | "totp";

export default function LoginPage() {
  const router = useRouter();
  const { lang } = useUI();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [step, setStep] = useState<Step>("credentials");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");

    const body: Record<string, string> = { email, password };
    if (step === "totp") body.totpCode = totpCode;

    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);

    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error || "Login failed");
      return;
    }

    const d = await r.json();
    if (d.requiresTotp) {
      setStep("totp");
      setTotpCode("");
      return;
    }
    router.push("/");
  };

  const inputCls =
    "w-full rounded-md border border-[#232a45] bg-[#0c1020] px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-indigo-500/60";

  return (
    <main className="relative min-h-[100dvh] flex items-center justify-center overflow-hidden bg-[#0a0e1a] text-zinc-100">
      {/* Ambient gradient glow */}
      <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-indigo-600/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-cyan-500/20 blur-3xl" />

      <form
        onSubmit={submit}
        className="relative w-[22rem] rounded-2xl border border-white/10 bg-white/[0.04] p-7 shadow-[0_8px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ background: "linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)", boxShadow: "0 2px 10px rgba(99,102,241,0.4)" }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 8l4 4-4 4" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12.5 16h6" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <h1 className="bg-gradient-to-r from-indigo-300 to-cyan-300 bg-clip-text text-lg font-semibold tracking-tight text-transparent">
              {t("appName", lang)}
            </h1>
            <p className="text-xs text-zinc-500">Sign in to your control panel</p>
          </div>
        </div>

        {step === "credentials" ? (
          <div className="space-y-3">
            <input
              className={inputCls}
              placeholder={t("email", lang)}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <input
              type="password"
              className={inputCls}
              placeholder={t("password", lang)}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Enter the 6-digit code from your authenticator app.
            </p>
            <input
              className={`${inputCls} text-center font-mono tracking-[0.5em]`}
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoFocus
              maxLength={6}
              inputMode="numeric"
            />
            <button
              type="button"
              onClick={() => { setStep("credentials"); setErr(""); }}
              className="text-xs text-zinc-500 transition hover:text-zinc-300"
            >
              ← Back
            </button>
          </div>
        )}

        {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
        <button
          disabled={busy || (step === "totp" && totpCode.length !== 6)}
          className="mt-5 w-full rounded-md bg-gradient-to-r from-indigo-500 to-cyan-500 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:from-indigo-400 hover:to-cyan-400 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "…" : step === "totp" ? "Verify" : t("signIn", lang)}
        </button>
      </form>
    </main>
  );
}
