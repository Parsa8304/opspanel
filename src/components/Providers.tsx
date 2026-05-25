"use client";
import React, { createContext, useContext, useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";

type Theme = "dark" | "light";
interface UICtx {
  lang: Lang;
  theme: Theme;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
}
const Ctx = createContext<UICtx>({
  lang: "en",
  theme: "dark",
  setLang: () => {},
  setTheme: () => {},
});

export const useUI = () => useContext(Ctx);

export function Providers({ children }: { children: React.ReactNode }) {
  const [lang, setLangS] = useState<Lang>("en");
  const [theme, setThemeS] = useState<Theme>("dark");

  useEffect(() => {
    const l = (localStorage.getItem("mn_lang") as Lang) || "en";
    const th = (localStorage.getItem("mn_theme") as Theme) || "dark";
    setLangS(l);
    setThemeS(th);
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    html.lang = lang;
    html.dir = lang === "fa" ? "rtl" : "ltr";
    html.classList.toggle("dark", theme === "dark");
  }, [lang, theme]);

  const setLang = (l: Lang) => {
    localStorage.setItem("mn_lang", l);
    setLangS(l);
  };
  const setTheme = (th: Theme) => {
    localStorage.setItem("mn_theme", th);
    setThemeS(th);
  };

  return (
    <Ctx.Provider value={{ lang, theme, setLang, setTheme }}>
      {children}
    </Ctx.Provider>
  );
}
