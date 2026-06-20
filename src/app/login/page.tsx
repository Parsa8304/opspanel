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

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#0a0e1a] text-zinc-100">
      {/* Ambient gradient glow */}
      <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-indigo-600/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-cyan-500/20 blur-3xl" />
      <form
        onSubmit={submit}
        className="relative w-80 space-y-4 rounded-2xl border border-white/10 bg-white/5 p-7 shadow-2xl backdrop-blur-xl"
      >
        <div className="mb-2">
          <div className="mb-3 h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 shadow-lg shadow-indigo-500/30" />
          <h1 className="bg-gradient-to-r from-indigo-300 to-cyan-300 bg-clip-text text-2xl font-bold text-transparent">
            {t("appName", lang)}
          </h1>
        </div>

        {step === "credentials" ? (
          <>
            <input
              className="w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none"
              placeholder={t("email", lang)}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <input
              type="password"
              className="w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none"
              placeholder={t("password", lang)}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-400">
              Enter the 6-digit code from your authenticator app.
            </p>
            <input
              className="w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none tracking-widest text-center font-mono"
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
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              ← Back
            </button>
          </>
        )}

        {err && <p className="text-sm text-red-400">{err}</p>}
        <button
          disabled={busy || (step === "totp" && totpCode.length !== 6)}
          className="w-full rounded-lg bg-gradient-to-r from-indigo-500 to-cyan-500 py-2.5 text-sm font-semibold shadow-lg shadow-indigo-500/25 transition hover:from-indigo-400 hover:to-cyan-400 disabled:opacity-50"
        >
          {step === "totp" ? "Verify" : t("signIn", lang)}
        </button>
      </form>
    </div>
  );
}
