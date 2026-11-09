"use client";

/* Client i18n: <I18nProvider> holds the current locale, useT() returns a typed `t`.
   The interface is translated; resume content and every text that comes from the API stays in English.

   t("dash.title")                          -> string
   t("dash.pages", { count: 3 })            -> plural form picked by count, "{count}" filled in
   t.rich("landing.hero", { em: (c) => <em>{c}</em> })  -> ReactNode with <em>…</em> tags mapped to elements

   The choice is stored in localStorage and in a cookie (so the server can render <html lang> and the
   first paint in the right language). URLs do not change. */

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dictionaries, type MessageKey } from "@/messages";
import { DEFAULT_LOCALE, formatMessage, isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, type Locale, type Vars } from "./i18n-core";

export { LOCALES, LOCALE_NAMES, type Locale } from "./i18n-core";
export type { MessageKey } from "@/messages";

type RichTags = Record<string, (chunks: ReactNode) => ReactNode>;
export interface TFunction {
  (key: MessageKey, vars?: Vars): string;
  rich: (key: MessageKey, tags: RichTags, vars?: Vars) => ReactNode;
}

function makeT(locale: Locale): TFunction {
  const dict = dictionaries[locale];
  const fallback = dictionaries[DEFAULT_LOCALE];
  const t = ((key: MessageKey, vars?: Vars) => formatMessage(locale, dict[key] ?? fallback[key], vars)) as TFunction;
  t.rich = (key, tags, vars) => {
    const s = t(key, vars);
    const out: ReactNode[] = [];
    const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const render = tags[m[1]];
      out.push(<Fragment key={i++}>{render ? render(m[2]) : m[2]}</Fragment>);
      last = re.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  return t;
}

/* Module-level copy of the browser's current locale, for the few non-React places that produce
   user-facing text (e.g. network errors in lib/api.ts). Only ever set in the browser. */
let browserLocale: Locale = DEFAULT_LOCALE;
/** Translate outside React (browser only; falls back to English on the server). */
export function translateNow(key: MessageKey, vars?: Vars): string {
  return makeT(typeof window === "undefined" ? DEFAULT_LOCALE : browserLocale)(key, vars);
}

function persist(locale: Locale) {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage blocked (private mode, policies) — the cookie still carries the choice */
  }
  try {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* ignore */
  }
}

interface Ctx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFunction;
}
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    persist(l);
  }, []);

  // The cookie decides the server render. If it was lost but localStorage still remembers a choice, restore it.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (isLocale(stored) && stored !== initialLocale) setLocale(stored);
    else persist(initialLocale);
  }, [initialLocale, setLocale]);

  useEffect(() => {
    browserLocale = locale;
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t: makeT(locale) }), [locale, setLocale]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nCtx);
  if (!c) throw new Error("useI18n outside I18nProvider");
  return c;
}

export function useT(): TFunction {
  return useI18n().t;
}
