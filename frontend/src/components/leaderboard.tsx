"use client";

import { Building2, Check, FlaskConical, MapPin, X } from "lucide-react";
import { useState } from "react";
import type { Opening, Tier, TierBand, TierId } from "@/lib/types";
import { Badge, cx } from "./ui";

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
  return (
    <span title={tier.help} aria-label={`Tier: ${tier.label}`} role="img">
      <Badge tone={TIER_TONE[tier.id] ?? "neutral"}>{tier.label}</Badge>
    </span>
  );
}

/** Horizontal 0–100 indicator. Labelled as a compatibility score, never a probability. */
export function ScoreBar({ score, tier, label }: { score: number | null; tier: TierId; label: string }) {
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
        aria-valuetext={score == null ? "Not scored" : `${Math.round(v)} out of 100`}
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
  const [all, setAll] = useState(false);
  const chips: Chip[] = [
    ...matched.map((k) => ({ k, state: "matched" as const })),
    ...weak.map((k) => ({ k, state: "weak" as const })),
    ...missing.map((k) => ({ k, state: "missing" as const })),
  ];
  if (!chips.length) return null;
  const shown = all ? chips : chips.slice(0, limit);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Keywords">
      {shown.map((c) => (
        <li key={c.state + c.k}>
          {c.state === "matched" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#bcd9c4] bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
              <Check className="h-3 w-3" aria-hidden />
              <span className="sr-only">Shown: </span>
              {c.k}
            </span>
          ) : c.state === "weak" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-[#ecc89c] bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
              {c.k} <span className="text-[10px] font-normal opacity-90">· listed only</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper-2 px-2 py-0.5 text-xs font-medium text-ink-2">
              <X className="h-3 w-3 text-bad" aria-hidden />
              <span className="sr-only">Missing: </span>
              {c.k}
            </span>
          )}
        </li>
      ))}
      {chips.length > limit && (
        <li>
          <button type="button" className="rounded-full px-2 py-0.5 text-xs font-medium text-teal underline-offset-2 hover:underline" onClick={() => setAll((a) => !a)} aria-expanded={all}>
            {all ? "Show fewer" : `+${chips.length - limit} more`}
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

const BAND_HELP: Partial<Record<TierId, string>> = {
  strong: "already shows most of what's needed",
  good: "solid base; targeted edits help",
  stretch: "build key skills first",
  unrelated: "a career change, not a resume tweak",
};

export function TierLegend({ tiers, tipsMin }: { tiers: TierBand[]; tipsMin?: number }) {
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  return (
    <div className="card p-4">
      <h2 className="label mb-2">Score bands</h2>
      <ul className="space-y-1.5 text-xs">
        {sorted.map((t, i) => {
          const hi = i === 0 ? 100 : sorted[i - 1].min - 1;
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-2">
              <span className="num w-14 shrink-0 text-muted">
                {t.min}–{hi}
              </span>
              <TierBadge tier={t} />
              <span className="text-ink-2">{BAND_HELP[t.id]}</span>
            </li>
          );
        })}
      </ul>
      {tipsMin != null && <p className="mt-3 text-xs text-muted">Resume-edit tips appear from {tipsMin} and up, when enough core skills are already shown.</p>}
      <p className="mt-1 text-xs text-muted">Bands are fixed heuristics, not probabilities of being hired.</p>
    </div>
  );
}

export const ARRANGEMENT: Record<string, string> = { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" };
export const EMPLOYMENT: Record<string, string> = { full_time: "Full-time", part_time: "Part-time", contract: "Contract", internship: "Internship" };

export function SampleBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-dashed border-[#b45309] bg-[#fff7ed] px-1.5 py-0.5 text-[11px] font-bold text-[#9a3412]"
      title="Demo listing for trying the product. Not a real vacancy."
    >
      <FlaskConical className="h-3 w-3" aria-hidden /> Sample opening
    </span>
  );
}

export function OpeningMeta({ o, className }: { o: Pick<Opening, "company" | "location" | "work_arrangement" | "employment_type">; className?: string }) {
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
      {o.work_arrangement && <span>{ARRANGEMENT[o.work_arrangement] ?? o.work_arrangement}</span>}
      {o.employment_type && <span>{EMPLOYMENT[o.employment_type] ?? o.employment_type}</span>}
    </p>
  );
}

export const STAGE: Record<string, { label: string; tone: "info" | "ok" | "neutral" }> = {
  submitted: { label: "Submitted", tone: "info" },
  shortlisted: { label: "Shortlisted", tone: "ok" },
  rejected: { label: "Not progressing", tone: "neutral" },
};

export function StageBadge({ stage }: { stage: string }) {
  const s = STAGE[stage] ?? { label: stage, tone: "neutral" as const };
  return (
    <span role="img" aria-label={`Stage: ${s.label}`}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}
