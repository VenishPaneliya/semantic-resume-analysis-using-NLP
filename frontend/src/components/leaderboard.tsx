"use client";

import { Building2, Check, FlaskConical, MapPin, X } from "lucide-react";
import { useState } from "react";
import { useT, type MessageKey, type TFunction } from "@/lib/i18n";
import type { Opening, Tier, TierBand, TierId } from "@/lib/types";
import { Badge, cx } from "./ui";

/* Tier (score band) labels and help come from the backend in English, but the ids are stable, so the
   frontend translates them by id and falls back to the backend text for anything it doesn't know. */
const TIER_LABEL_KEY: Record<TierId, MessageKey> = {
  strong: "tier.strong",
  good: "tier.good",
  stretch: "tier.stretch",
  unrelated: "tier.unrelated",
  unknown: "tier.unknown",
};
const TIER_HELP_KEY: Record<TierId, MessageKey> = {
  strong: "tier.help.strong",
  good: "tier.help.good",
  stretch: "tier.help.stretch",
  unrelated: "tier.help.unrelated",
  unknown: "tier.help.unknown",
};

export function tierLabel(t: TFunction, tier: Pick<Tier, "id" | "label">) {
  return TIER_LABEL_KEY[tier.id] ? t(TIER_LABEL_KEY[tier.id]) : tier.label;
}
export function tierHelp(t: TFunction, tier: Pick<Tier, "id"> & { help?: string }) {
  return TIER_HELP_KEY[tier.id] ? t(TIER_HELP_KEY[tier.id]) : tier.help;
}

const TIER_TONE: Record<TierId, "ok" | "teal" | "warn" | "neutral"> = {
  strong: "ok",
  good: "teal",
  stretch: "warn",
  unrelated: "neutral",
  unknown: "neutral",
};
const TIER_BAR: Record<TierId, string> = {
  strong: "bg-ok",
  good: "bg-teal",
  stretch: "bg-[#b7791f]",
  unrelated: "bg-line-strong",
  unknown: "bg-line-strong",
};

export function TierBadge({ tier }: { tier: Pick<Tier, "id" | "label"> & { help?: string } }) {
  const t = useT();
  const label = tierLabel(t, tier);
  return (
    <span title={tier.help ? tierHelp(t, tier) : undefined} aria-label={t("tier.aria", { label })} role="img">
      <Badge tone={TIER_TONE[tier.id] ?? "neutral"}>{label}</Badge>
    </span>
  );
}

/** Horizontal 0–100 indicator. Labelled as a compatibility score, never a probability. */
export function ScoreBar({ score, tier, label }: { score: number | null; tier: TierId; label: string }) {
  const t = useT();
  const v = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-2.5 w-full min-w-16 overflow-hidden rounded-full bg-paper-2"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(v)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={score == null ? t("lb.notScored") : t("common.outOf100", { value: Math.round(v) })}
      >
        <div className={cx("h-full rounded-full", TIER_BAR[tier] ?? "bg-line-strong")} style={{ width: `${v}%`, transition: "width .6s ease" }} />
      </div>
      <span className="num w-8 shrink-0 text-right text-sm font-semibold" aria-hidden>
        {score == null ? "—" : Math.round(score)}
      </span>
    </div>
  );
}

type Chip = { k: string; state: "matched" | "weak" | "missing" };

/** Keyword chips: ✓ matched, "listed only" for weak, ✗ missing. Collapses long lists. */
export function KeywordChips({ matched, weak = [], missing, limit = 10 }: { matched: string[]; weak?: string[]; missing: string[]; limit?: number }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const chips: Chip[] = [
    ...matched.map((k) => ({ k, state: "matched" as const })),
    ...weak.map((k) => ({ k, state: "weak" as const })),
    ...missing.map((k) => ({ k, state: "missing" as const })),
  ];
  if (!chips.length) return null;
  const shown = all ? chips : chips.slice(0, limit);
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label={t("lb.keywords")}>
      {shown.map((c) => (
        <li key={c.state + c.k}>
          {c.state === "matched" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#bcd9c4] bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
              <Check className="h-3 w-3" aria-hidden />
              <span className="sr-only">{t("lb.srShown")}</span>
              {c.k}
            </span>
          ) : c.state === "weak" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#ecc89c] bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
              {c.k} <span className="text-[10px] font-normal opacity-90">· {t("lb.listedOnly")}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper-2 px-2 py-0.5 text-xs font-medium text-ink-2">
              <X className="h-3 w-3 text-bad" aria-hidden />
              <span className="sr-only">{t("lb.srMissing")}</span>
              {c.k}
            </span>
          )}
        </li>
      ))}
      {chips.length > limit && (
        <li>
          <button type="button" className="rounded-full px-2 py-0.5 text-xs font-medium text-teal underline-offset-2 hover:underline" onClick={() => setAll((a) => !a)} aria-expanded={all}>
            {all ? t("lb.showFewer") : t("lb.more", { count: chips.length - limit })}
          </button>
        </li>
      )}
    </ul>
  );
}

/** Mirrors backend TIERS / TIPS_MIN (services/ml/leaderboard.py). Used where an endpoint doesn't return the bands. */
export const DEFAULT_TIERS: TierBand[] = [
  { min: 60, id: "strong", label: "Strong match" },
  { min: 40, id: "good", label: "Good match" },
  { min: 25, id: "stretch", label: "Stretch" },
  { min: 0, id: "unrelated", label: "Not a match yet" },
];
export const DEFAULT_TIPS_MIN = 40;

const BAND_HELP: Partial<Record<TierId, MessageKey>> = {
  strong: "tier.band.strong",
  good: "tier.band.good",
  stretch: "tier.band.stretch",
  unrelated: "tier.band.unrelated",
};

export function TierLegend({ tiers, tipsMin }: { tiers: TierBand[]; tipsMin?: number }) {
  const t = useT();
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  return (
    <div className="card p-4">
      <h2 className="label mb-2">{t("lb.scoreBands")}</h2>
      <ul className="space-y-1.5 text-xs">
        {sorted.map((band, i) => {
          const hi = i === 0 ? 100 : sorted[i - 1].min - 1;
          const help = BAND_HELP[band.id];
          return (
            <li key={band.id} className="flex flex-wrap items-center gap-2">
              <span className="num w-14 shrink-0 text-muted">
                {band.min}–{hi}
              </span>
              <TierBadge tier={band} />
              <span className="min-w-0 text-ink-2">{help ? t(help) : null}</span>
            </li>
          );
        })}
      </ul>
      {tipsMin != null && <p className="mt-3 text-xs text-muted">{t("lb.tipsFrom", { min: tipsMin })}</p>}
      <p className="mt-1 text-xs text-muted">{t("lb.bandsNote")}</p>
    </div>
  );
}

/** English labels keyed by API code (kept for existing imports); use the *Label helpers below for display. */
export const ARRANGEMENT: Record<string, string> = { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" };
export const EMPLOYMENT: Record<string, string> = { full_time: "Full-time", part_time: "Part-time", contract: "Contract", internship: "Internship" };

const ARRANGEMENT_KEY: Record<string, MessageKey> = { onsite: "lb.arr.onsite", hybrid: "lb.arr.hybrid", remote: "lb.arr.remote" };
const EMPLOYMENT_KEY: Record<string, MessageKey> = {
  full_time: "lb.emp.full_time",
  part_time: "lb.emp.part_time",
  contract: "lb.emp.contract",
  internship: "lb.emp.internship",
};
export function arrangementLabel(t: TFunction, code: string) {
  return ARRANGEMENT_KEY[code] ? t(ARRANGEMENT_KEY[code]) : (ARRANGEMENT[code] ?? code);
}
export function employmentLabel(t: TFunction, code: string) {
  return EMPLOYMENT_KEY[code] ? t(EMPLOYMENT_KEY[code]) : (EMPLOYMENT[code] ?? code);
}

export function SampleBadge() {
  const t = useT();
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-dashed border-[#b45309] bg-[#fff7ed] px-1.5 py-0.5 text-[11px] font-bold text-[#9a3412]"
      title={t("lb.sampleTitle")}
    >
      <FlaskConical className="h-3 w-3" aria-hidden /> {t("lb.sample")}
    </span>
  );
}

export function OpeningMeta({ o, className }: { o: Pick<Opening, "company" | "location" | "work_arrangement" | "employment_type">; className?: string }) {
  const t = useT();
  return (
    <p className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2", className)}>
      <span className="inline-flex items-center gap-1">
        <Building2 className="h-3.5 w-3.5 text-muted" aria-hidden /> {o.company}
      </span>
      {o.location && (
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-3.5 w-3.5 text-muted" aria-hidden /> {o.location}
        </span>
      )}
      {o.work_arrangement && <span>{arrangementLabel(t, o.work_arrangement)}</span>}
      {o.employment_type && <span>{employmentLabel(t, o.employment_type)}</span>}
    </p>
  );
}

export const STAGE: Record<string, { label: string; tone: "info" | "ok" | "neutral" | "teal" }> = {
  submitted: { label: "Submitted", tone: "info" },
  shortlisted: { label: "Shortlisted", tone: "ok" },
  interview: { label: "Interview", tone: "teal" },
  offer: { label: "Offer", tone: "teal" },
  hired: { label: "Hired", tone: "ok" },
  rejected: { label: "Not progressing", tone: "neutral" },
};

const STAGE_KEY: Record<string, MessageKey> = {
  submitted: "lb.stage.submitted",
  shortlisted: "lb.stage.shortlisted",
  interview: "lb.stage.interview",
  offer: "lb.stage.offer",
  hired: "lb.stage.hired",
  rejected: "lb.stage.rejected",
};
/** Translated pipeline-stage label (STAGE keeps the English label and tone for existing imports). */
export function stageLabel(t: TFunction, stage: string) {
  return STAGE_KEY[stage] ? t(STAGE_KEY[stage]) : (STAGE[stage]?.label ?? stage);
}

export function StageBadge({ stage }: { stage: string }) {
  const t = useT();
  const tone = STAGE[stage]?.tone ?? ("neutral" as const);
  const label = stageLabel(t, stage);
  return (
    <span role="img" aria-label={t("lb.stageAria", { label })}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}
