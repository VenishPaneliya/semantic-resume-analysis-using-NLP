/** Friendly labels for the backend's voluntary self-ID option codes (backend/app/api/account_extra.py).
    Pass the `t` from useT(); unknown codes fall back to a readable form of the code. */
import type { MessageKey, TFunction } from "./i18n";

const GENDER_KEY: Record<string, MessageKey> = {
  woman: "labels.gender.woman",
  man: "labels.gender.man",
  non_binary: "labels.gender.non_binary",
  self_describe: "labels.gender.self_describe",
  prefer_not: "labels.gender.prefer_not",
};

const AGE_BAND_KEY: Record<string, MessageKey> = {
  under_25: "labels.age.under_25",
  "55_plus": "labels.age.55_plus",
  prefer_not: "labels.age.prefer_not",
};
/** Numeric ranges read the same in every language. */
const AGE_BAND_RANGE: Record<string, string> = { "25_34": "25–34", "35_44": "35–44", "45_54": "45–54" };

const DIMENSION_KEY: Record<string, MessageKey> = { gender: "labels.dim.gender", age_band: "labels.dim.age_band" };

export function genderLabel(t: TFunction, code: string) {
  return GENDER_KEY[code] ? t(GENDER_KEY[code]) : code.replace(/_/g, " ");
}

export function ageBandLabel(t: TFunction, code: string) {
  return AGE_BAND_KEY[code] ? t(AGE_BAND_KEY[code]) : (AGE_BAND_RANGE[code] ?? code.replace(/_/g, " "));
}

export function dimensionLabel(t: TFunction, dim: string) {
  return DIMENSION_KEY[dim] ? t(DIMENSION_KEY[dim]) : dim.replace(/_/g, " ");
}

export function groupLabel(t: TFunction, dim: string, g: string) {
  return dim === "gender" ? genderLabel(t, g) : dim === "age_band" ? ageBandLabel(t, g) : g.replace(/_/g, " ");
}
