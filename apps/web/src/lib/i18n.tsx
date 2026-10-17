import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { duration } from "./format";

export type Lang = "en" | "tr";
const KEY = "ucus-plani:lang";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "tr") return saved;
  } catch { /* ignore */ }
  return "tr"; // Türkçe varsayılan: arayüzün asıl dili
}

type Dict = Record<string, string>;
const dicts: Record<Lang, Dict> = { en: {}, tr: {} };

/** Register strings for a feature: `defineStrings({ key: ["english", "türkçe"] })`. Turkish is the default and the fallback; the English slot may repeat the Turkish text. Returns a typed key helper. */
export function defineStrings<K extends string>(table: Record<K, readonly [string, string]>) {
  for (const k in table) {
    dicts.en[k] = table[k][0];
    dicts.tr[k] = table[k][1];
  }
  return (k: K) => k;
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string, vars?: Record<string, string | number>) => string };
const LangCtx = createContext<Ctx>({ lang: "tr", setLang: () => {}, t: (k) => k });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = dicts[lang][key] ?? dicts.tr[key] ?? dicts.en[key] ?? key;
      if (vars) for (const v in vars) s = s.replaceAll(`{${v}}`, String(vars[v]));
      return s;
    },
    [lang],
  );
  return <LangCtx.Provider value={{ lang, setLang, t }}>{children}</LangCtx.Provider>;
}

export const useLang = () => useContext(LangCtx);

/** Small EN / TR switch. */
export function LangSwitch({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLang();
  return (
    <div className={`langswitch ${className}`} role="group" aria-label="Dil">
      {(["en", "tr"] as const).map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** Locale-aware duration formatter. */
export function useDuration() {
  const { t } = useLang();
  return (seconds: number) => duration(seconds, { now: t("time.now"), d: t("time.d"), h: t("time.h"), m: t("time.m") });
}
