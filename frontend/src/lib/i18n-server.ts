import { cookies } from "next/headers";
import { dictionaries, type MessageKey } from "@/messages";
import { DEFAULT_LOCALE, formatMessage, isLocale, LOCALE_COOKIE, type Locale, type Vars } from "./i18n-core";

/** Locale chosen by the visitor (cookie set by the language switcher), else English. */
export async function getServerLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** Plain-string translator for server code such as generateMetadata. */
export async function getServerT() {
  const locale = await getServerLocale();
  return (key: MessageKey, vars?: Vars) => formatMessage(locale, dictionaries[locale][key] ?? dictionaries.en[key], vars);
}
