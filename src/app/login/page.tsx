"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUI } from "@/components/Providers";
import { t } from "@/lib/i18n";

export default function LoginPage() {
  const router = useRouter();
  const { lang } = useUI();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (r.ok) router.push("/");
    else setErr((await r.json()).error || "Login failed");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
      <form
        onSubmit={submit}
        className="w-80 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6"
      >
        <h1 className="text-lg font-semibold">{t("appName", lang)}</h1>
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
        {err && <p className="text-sm text-red-400">{err}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-[#183661] py-2 text-sm font-medium disabled:opacity-50"
        >
          {t("signIn", lang)}
        </button>
      </form>
    </div>
  );
}
