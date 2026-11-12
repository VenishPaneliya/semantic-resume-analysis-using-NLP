/* All message catalogs merged into one dictionary per locale. To add a namespace file, import it here
   and spread it into each locale below; to add a language, see docs/TRANSLATIONS.md. Keys are prefixed
   by area ("dash.", "auth.", …) so namespaces never collide.

   Server-only in practice: the root layout picks the visitor's dictionary and hands just that one to the
   client provider. Client code may import types from here, never values. */
import auth from "./auth";
import candidate from "./candidate";
import common from "./common";
import dashboard from "./dashboard";
import landing from "./landing";
import resumeGrowth from "./resume-growth";
import resumeTools from "./resume-tools";
import shell from "./shell";
import staff from "./staff";
import terms from "./terms";
import type { Locale, Msg } from "@/lib/i18n-core";

export const en = {
  ...common.en,
  ...shell.en,
  ...landing.en,
  ...auth.en,
  ...dashboard.en,
  ...resumeTools.en,
  ...resumeGrowth.en,
  ...candidate.en,
  ...staff.en,
  ...terms.en,
};

export type Messages = typeof en;
export type MessageKey = keyof Messages;
export type Dictionary = { [K in MessageKey]: Msg };

export const hi: Dictionary = {
  ...common.hi,
  ...shell.hi,
  ...landing.hi,
  ...auth.hi,
  ...dashboard.hi,
  ...resumeTools.hi,
  ...resumeGrowth.hi,
  ...candidate.hi,
  ...staff.hi,
  ...terms.hi,
};

export const gu: Dictionary = {
  ...common.gu,
  ...shell.gu,
  ...landing.gu,
  ...auth.gu,
  ...dashboard.gu,
  ...resumeTools.gu,
  ...resumeGrowth.gu,
  ...candidate.gu,
  ...staff.gu,
  ...terms.gu,
};

export const dictionaries: Record<Locale, Dictionary> = { en, hi, gu };
