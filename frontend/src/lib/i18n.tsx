"use client";

/* Client i18n: <I18nProvider> holds the current locale and its messages, useT() returns a typed `t`.
   The interface is translated; resume content and every text that comes from the API stays in English.

   t("dash.title")                          -> string
   t("dash.pages", { count: 3 })            -> plural form picked by count, "{count}" filled in
   t.rich("landing.hero", { em: (c) => <em>{c}</em> })  -> ReactNode with <em>…</em> tags mapped to elements

   Only the active language's messages reach the browser: the root layout (a server component) reads the
   locale cookie and passes that one dictionary in as a prop. This file must never import the catalogs
   themselves (only their types), or every language would be bundled for every visitor again.
   Switching language stores the choice in a cookie and refreshes the server components, which send the
   new dictionary. URLs do not change. */

import { useRouter } from "next/navigation";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useTransition, type ReactNode } from "react";
import { formatMessage, isLocale, LOCALE_COOKIE, LOCALE_STORAGE_KEY, type Locale, type Vars } from "./i18n-core";
import type { Dictionary, MessageKey } from "@/messages";

export { LOCALES, LOCALE_NAMES, type Locale } from "./i18n-core";
export type { MessageKey } from "@/messages";

type RichTags = Record<string, (chunks: ReactNode) => ReactNode>;
export interface TFunction {
  (key: MessageKey, vars?: Vars): string;
  rich: (key: MessageKey, tags: RichTags, vars?: Vars) => ReactNode;
}

function makeT(locale: Locale, dict: Dictionary): TFunction {
  const t = ((key: MessageKey, vars?: Vars) => formatMessage(locale, dict[key] ?? key, vars)) as TFunction;
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

/* Module-level copy of the browser's current locale and translator, for the few non-React places that
   produce user-facing text (network errors in lib/api.ts, dates in components/ui.tsx). Only set in the
   browser; on the server these fall back to English / the browser default. */
let browserLocale: Locale | null = null;
let browserT: TFunction | null = null;

/** Translate outside React (browser only). Returns the key itself before the provider has mounted. */
export function translateNow(key: MessageKey, vars?: Vars): string {
  return browserT ? browserT(key, vars) : key;
}
/** The active locale outside React (browser only; null on the server). */
export function currentLocale(): Locale | null {
  return browserLocale;
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
  /** true while the newly chosen language's messages are being fetched */
  switching: boolean;
  t: TFunction;
}
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Dictionary; children: ReactNode }) {
  const router = useRouter();
  const [switching, startTransition] = useTransition();

  const setLocale = useCallback(
    (l: Locale) => {
      persist(l);
      // re-render the server components: the root layout reads the new cookie and sends that dictionary
      startTransition(() => router.refresh());
    },
    [router],
  );

  // The cookie decides the server render. If it was lost but localStorage still remembers a choice, restore it.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (isLocale(stored) && stored !== locale) setLocale(stored);
    else persist(locale);
    // only on first mount: later changes come from setLocale itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = useMemo(() => makeT(locale, messages), [locale, messages]);
  if (typeof window !== "undefined") {
    // set during render so dates/errors formatted in this same render already use the new language
    browserLocale = locale;
    browserT = t;
  }

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, switching, t }), [locale, setLocale, switching, t]);
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
