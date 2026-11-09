/* All message catalogs merged into one dictionary per locale. To add a namespace file, import it here
   and add it to CATALOGS; to add a language, see docs/TRANSLATIONS.md. Keys are prefixed by area
   ("dash.", "auth.", …) so namespaces never collide. */
import type { Locale, Msg } from "@/lib/i18n-core";
import auth from "./auth";
import candidate from "./candidate";
import common from "./common";
import dashboard from "./dashboard";
import landing from "./landing";
import resumeGrowth from "./resume-growth";
import resumeTools from "./resume-tools";
import shell from "./shell";
import staff from "./staff";

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
};

export type Messages = typeof en;
export type MessageKey = keyof Messages;
type Dictionary = { [K in MessageKey]: Msg };

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
};

export const dictionaries: Record<Locale, Dictionary> = { en, hi, gu };
