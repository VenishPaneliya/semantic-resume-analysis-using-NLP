"use client";

import type { MatchResult, MatchRow, Tier } from "@/lib/types";
import { TierBadge } from "./leaderboard";
import { Badge, Bar, pct, ScoreDial, Section } from "./ui";

export const STATUS_TONE = { matched: "ok", partial: "warn", missing: "bad", unknown: "neutral" } as const;

export function ReqRow({ r }: { r: MatchRow }) {
  return (
    <li className="grid gap-2 py-3 sm:grid-cols-[110px_minmax(0,1fr)]">
      <div className="flex flex-wrap gap-1 sm:flex-col sm:items-start">
        <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
        <span className="text-[11px] text-muted">{r.importance} · {r.kind}</span>
      </div>
      <div>
        <p className="text-sm font-medium">{r.text}</p>
        <p className="mt-0.5 text-sm text-ink-2">{r.explanation}</p>
        {r.gap_type && (
          <p className="mt-1 text-xs">
            <Badge tone={r.gap_type === "genuine_gap" ? "bad" : "info"}>{r.gap_type === "genuine_gap" ? "genuine gap" : "possibly unlisted"}</Badge>
          </p>
        )}
        {(r.evidence.length > 0 || r.closest_evidence.length > 0) && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-teal">Evidence</summary>
            <ul className="mt-1 space-y-1">
              {(r.evidence.length ? r.evidence : r.closest_evidence).map((e, i) => (
                <li key={i} className="text-xs italic text-ink-2">
                  “{e.text}”{e.similarity != null && <span className="num not-italic text-muted"> · similarity {Math.round(e.similarity * 100)}%</span>}
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
export function MatchBreakdown({ m, tier, title = "Requirement by requirement", idPrefix = "mb" }: { m: Match; tier?: Tier; title?: string; idPrefix?: string }) {
  const t = tier ?? m.tier;
  return (
    <div className="space-y-5">
      <div className="card grid gap-5 p-5 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center gap-2">
          <ScoreDial value={m.overall == null ? null : Math.round(m.overall)} size={104} label="compat." />
          {t && <TierBadge tier={t} />}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-ink-2">{m.overall_label}.</p>
          {t?.help && <p className="mt-1 text-sm text-ink-2">{t.help}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(m.counts) as (keyof typeof m.counts)[]).map((k) => (
              <Badge key={k} tone={STATUS_TONE[k]}>
                {m.counts[k]} {k}
              </Badge>
            ))}
          </div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            {(
              [
                ["Requirement coverage · 60%", m.components.requirement_coverage],
                ["Keyword coverage · 20%", m.components.keyword_coverage],
                ["Semantic alignment · 20%", m.components.semantic_alignment],
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
            Experience alignment: <strong>{m.components.experience_alignment.replace("_", " ")}</strong>. A compatibility indicator, not a hiring probability.
          </p>
        </div>
      </div>
      <Section title={title} id={`${idPrefix}-reqs`}>
        <ul className="divide-y divide-line">
          {m.requirements.map((r) => (
            <ReqRow key={r.id} r={r} />
          ))}
        </ul>
      </Section>
      <div className="grid gap-5 md:grid-cols-2">
        <Section title="Genuine gaps" id={`${idPrefix}-gaps`}>
          {m.genuine_gaps.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm">{m.genuine_gaps.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">None identified.</p>
          )}
        </Section>
        <Section title="Possibly unlisted" id={`${idPrefix}-unlisted`}>
          {m.possibly_unlisted.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm">{m.possibly_unlisted.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">None identified.</p>
          )}
          <p className="mt-3 text-xs text-muted">Related evidence exists. These count only if the experience is real.</p>
        </Section>
      </div>
    </div>
  );
}
