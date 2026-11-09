/* Dependency-free i18n primitives shared by the client provider (lib/i18n.tsx), server helpers
   (lib/i18n-server.ts) and the message catalogs (src/messages/*). No React here.

   Catalogs: each file in src/messages calls defineMessages({ en, hi, gu }). `en` is the source of truth;
   every other locale must have exactly the same keys (a missing or extra key is a compile error).
   Values are strings with `{name}` placeholders, or `{ one, other }` for count-dependent text. */

export const LOCALES = ["en", "hi", "gu"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Cookie (read on the server for <html lang> and first render) and localStorage key. */
export const LOCALE_COOKIE = "ri_lang";
export const LOCALE_STORAGE_KEY = "ri_lang";

/** Each language is named in its own script so people can find theirs. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", hi: "हिन्दी", gu: "ગુજરાતી" };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export interface Plural {
  one: string;
  other: string;
}
export type Msg = string | Plural;
export type Vars = Record<string, string | number>;

/** Shape a translation must have: same keys as English, a string where English has a string and
    `{ one, other }` where English has plural forms. */
export type Translation<E> = { [K in keyof E]: E[K] extends string ? string : Plural };
export type Catalog<E> = { en: E } & { [L in Exclude<Locale, "en">]: Translation<E> };

export function defineMessages<const E extends Record<string, Msg>>(catalog: Catalog<E>): Catalog<E> {
  return catalog;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function plural(locale: Locale, n: number): "one" | "other" {
  let r = pluralRules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r.select(n) === "one" ? "one" : "other";
}

/** Pick the plural form (by `vars.count`) and fill `{placeholders}`. Unknown placeholders are left as-is. */
export function formatMessage(locale: Locale, msg: Msg | undefined, vars?: Vars): string {
  if (msg == null) return "";
  let s: string;
  if (typeof msg === "string") s = msg;
  else {
    const n = Number(vars?.count ?? 0);
    s = msg[plural(locale, n)] ?? msg.other;
  }
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
