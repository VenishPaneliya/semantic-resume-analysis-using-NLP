"use client";

import { useT, type MessageKey, type TFunction } from "@/lib/i18n";
import type { MatchResult, MatchRow, Tier } from "@/lib/types";
import { TierBadge } from "./leaderboard";
import { Badge, Bar, pct, ScoreDial, Section } from "./ui";

export const STATUS_TONE = { matched: "ok", partial: "warn", missing: "bad", unknown: "neutral" } as const;
type MatchStatus = keyof typeof STATUS_TONE;

const STATUS_KEY: Record<MatchStatus, MessageKey> = {
  matched: "mb.status.matched",
  partial: "mb.status.partial",
  missing: "mb.status.missing",
  unknown: "mb.status.unknown",
};
const COUNT_KEY: Record<MatchStatus, MessageKey> = {
  matched: "mb.count.matched",
  partial: "mb.count.partial",
  missing: "mb.count.missing",
  unknown: "mb.count.unknown",
};

/** Translated label for a requirement status ("matched", "partial", …); unknown codes are shown as-is. */
export function matchStatusLabel(t: TFunction, s: string) {
  return s in STATUS_KEY ? t(STATUS_KEY[s as MatchStatus]) : s;
}

/** Translated "{count} matched"-style badge text. */
export function matchCountLabel(t: TFunction, s: string, count: number) {
  return s in COUNT_KEY ? t(COUNT_KEY[s as MatchStatus], { count }) : `${count} ${s}`;
}

export function ReqRow({ r }: { r: MatchRow }) {
  const t = useT();
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[110px_minmax(0,1fr)]">
      <div className="flex flex-wrap gap-1 sm:flex-col sm:items-start">
        <Badge tone={STATUS_TONE[r.status]}>{matchStatusLabel(t, r.status)}</Badge>
        <span className="text-[11px] text-muted">{r.importance} · {r.kind}</span>
      </div>
      <div>
        <p className="text-sm font-medium">{r.text}</p>
        <p className="mt-0.5 text-sm text-ink-2">{r.explanation}</p>
        {r.gap_type && (
          <p className="mt-1 text-xs">
            <Badge tone={r.gap_type === "genuine_gap" ? "bad" : "info"}>{r.gap_type === "genuine_gap" ? t("mb.genuineGap") : t("mb.possiblyUnlisted")}</Badge>
          </p>
        )}
        {(r.evidence.length > 0 || r.closest_evidence.length > 0) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-teal">{t("mb.evidence")}</summary>
            <ul className="mt-1 space-y-1">
              {(r.evidence.length ? r.evidence : r.closest_evidence).map((e, i) => (
                <li key={i} className="text-xs italic text-ink-2">
                  “{e.text}”{e.similarity != null && <span className="num not-italic text-muted">{t("mb.similarity", { pct: Math.round(e.similarity * 100) })}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

type Match = Omit<MatchResult, "jd" | "cached"> & { tier?: Tier };

/** Score, tier, counts and requirement-by-requirement rows for one resume vs one opening. */
export function MatchBreakdown({ m, tier, title, idPrefix = "mb" }: { m: Match; tier?: Tier; title?: string; idPrefix?: string }) {
  const t = useT();
  const tierShown = tier ?? m.tier;
  return (
    <div className="space-y-5">
      <div className="card grid gap-5 p-5 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-2">
          <ScoreDial value={m.overall == null ? null : Math.round(m.overall)} size={104} label={t("mb.compat")} />
          {tierShown && <TierBadge tier={tierShown} />}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-ink-2">{m.overall_label}.</p>
          {tierShown?.help && <p className="mt-1 text-sm text-ink-2">{tierShown.help}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(m.counts) as (keyof typeof m.counts)[]).map((k) => (
              <Badge key={k} tone={STATUS_TONE[k]}>
                {matchCountLabel(t, k, m.counts[k])}
              </Badge>
            ))}
          </div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            {(
              [
                [t("mb.reqCoverage"), m.components.requirement_coverage],
                [t("mb.kwCoverage"), m.components.keyword_coverage],
                [t("mb.semantic"), m.components.semantic_alignment],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="flex justify-between gap-2">
                  <span>{k}</span>
                  <span className="num">{pct(v)}</span>
                </dt>
                <dd className="mt-1">
                  <Bar value={v ?? 0} label={k} />
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            {t.rich("mb.expLine", { b: (c) => <strong>{c}</strong> }, { value: m.components.experience_alignment.replace("_", " ") })}
          </p>
        </div>
      </div>
      <Section title={title ?? t("mb.reqs")} id={`${idPrefix}-reqs`}>
        <ul className="divide-y divide-line">
          {m.requirements.map((r) => (
            <ReqRow key={r.id} r={r} />
          ))}
        </ul>
      </Section>
      <div className="grid gap-5 md:grid-cols-2">
        <Section title={t("mb.gaps")} id={`${idPrefix}-gaps`}>
          {m.genuine_gaps.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm">{m.genuine_gaps.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">{t("mb.noneIdentified")}</p>
          )}
        </Section>
        <Section title={t("mb.unlistedTitle")} id={`${idPrefix}-unlisted`}>
          {m.possibly_unlisted.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm">{m.possibly_unlisted.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">{t("mb.noneIdentified")}</p>
          )}
          <p className="mt-3 text-xs text-muted">{t("mb.unlistedNote")}</p>
        </Section>
      </div>
    </div>
  );
}
