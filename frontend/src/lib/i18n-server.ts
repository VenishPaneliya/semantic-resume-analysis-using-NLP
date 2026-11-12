import { cookies } from "next/headers";
import { DEFAULT_LOCALE, formatMessage, isLocale, LOCALE_COOKIE, type Locale, type Vars } from "./i18n-core";
import { dictionaries, type Dictionary, type MessageKey } from "@/messages";
import type { Metadata } from "next";

/** Locale chosen by the visitor (cookie set by the language switcher), else English. */
export async function getServerLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** The one dictionary the client needs (the root layout passes it to <I18nProvider>). */
export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Plain-string translator for server code such as generateMetadata. */
export async function getServerT() {
  const locale = await getServerLocale();
  return (key: MessageKey, vars?: Vars) => formatMessage(locale, dictionaries[locale][key] ?? dictionaries.en[key], vars);
}

/** Browser-tab title for a page, in the visitor's language. Used by each route's small layout.tsx:
    `export const generateMetadata = () => pageTitle("title.dashboard");` -> "Resumes · Resume Intelligence". */
export async function pageTitle(key: MessageKey): Promise<Metadata> {
  const t = await getServerT();
  // absolute: a nested layout's plain title would otherwise drop the root template for deeper pages
  return { title: { absolute: `${t(key)} · Resume Intelligence` } };
}
