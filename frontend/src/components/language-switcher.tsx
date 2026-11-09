"use client";

import { Languages } from "lucide-react";
import { LOCALE_NAMES, LOCALES, useI18n, type Locale } from "@/lib/i18n";
import { cx } from "./ui";

/** Native <select> so it works with keyboard, screen readers and mobile pickers. Each option is
    written in its own script and tagged with its language. */
export function LanguageSwitcher({ className, id, variant = "compact" }: { className?: string; id?: string; variant?: "compact" | "field" }) {
  const { locale, setLocale, t } = useI18n();
  const select = (
    <select
      id={id}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={variant === "compact" ? t("common.language") : undefined}
      data-testid={variant === "compact" ? "lang-switcher" : "lang-select"}
      className={
        variant === "compact"
          ? "h-8 cursor-pointer appearance-none rounded-md border border-line-strong bg-card py-0 pl-7 pr-6 text-sm font-medium text-ink-2 hover:bg-paper-2"
          : "input cursor-pointer sm:max-w-xs"
      }
    >
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
  if (variant === "field") return select;
  return (
    <span className={cx("relative inline-flex shrink-0 items-center", className)}>
      <Languages className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted" aria-hidden />
      {select}
      <svg className="pointer-events-none absolute right-2 h-3 w-3 text-muted" viewBox="0 0 12 12" aria-hidden>
        <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function SkipLink() {
  const { t } = useI18n();
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
    >
      {t("common.skipToContent")}
    </a>
  );
}
