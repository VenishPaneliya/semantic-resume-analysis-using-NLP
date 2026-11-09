"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ScoreBar, StageBadge, TierBadge } from "@/components/leaderboard";
import { STATUS_TONE } from "@/components/match-breakdown";
import { fmtYears } from "@/components/recruiter";
import { Alert, Badge, EnglishNote, ErrorState, LoadingBlock } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { CompareCell, CompareResult, ReqStatus } from "@/lib/types";

export default function ComparePage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Compare />
    </Suspense>
  );
}

const STATUSES: ReqStatus[] = ["matched", "partial", "missing", "unknown"];
const STATUS_KEY: Record<string, MessageKey> = {
  matched: "compare.status.matched",
  partial: "compare.status.partial",
  missing: "compare.status.missing",
  unknown: "compare.status.unknown",
};
const IMPORTANCE_KEY: Record<string, MessageKey> = { required: "rec.imp.required", preferred: "rec.imp.preferred" };

function Compare() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const ids = (useSearchParams().get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
  const q = ids.map((x) => `ids=${encodeURIComponent(x)}`).join("&");
  const { data, error, loading, reload } = useApi<CompareResult>(ids.length >= 2 ? `/api/recruiter/openings/${id}/compare?${q}` : null);
  const back = (
    <Link href={`/recruiter/openings/${id}`} className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
      <ChevronLeft className="h-4 w-4" aria-hidden /> {t("rec.backToCandidates")}
    </Link>
  );

  if (ids.length < 2)
    return (
      <div className="space-y-4">
        {back}
        <Alert tone="warn" title={t("compare.pickTwo")}>
          {t("compare.pickTwoBody")}
        </Alert>
      </div>
    );
  if (loading && !data) return <LoadingBlock label={t("compare.loading")} />;
  if (error || !data) return <ErrorState message={error ?? t("compare.error")} onRetry={reload} />;

  const cols = data.candidates;
  return (
    <div className="space-y-5">
      <div>
        {back}
        <h1 className="mt-2 text-2xl sm:text-3xl">{t("compare.title")}</h1>
        <p className="mt-1 text-sm text-ink-2">
          {data.opening.title} · {data.opening.company} · {t("compare.count", { count: cols.length })}
        </p>
      </div>
      <Alert tone="info" title={t("compare.aidTitle")}>
        {data.note}
      </Alert>
      <EnglishNote />
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2" aria-label={t("compare.legend")}>
        {STATUSES.map((s) => (
          <Badge key={s} tone={STATUS_TONE[s]}>
            {t(STATUS_KEY[s])}
          </Badge>
        ))}
        <span>{t("compare.hover")}</span>
      </div>

      <div className="card relative overflow-x-auto" data-testid="compare">
        <table className="w-full text-sm" style={{ minWidth: 132 + cols.length * 170 }}>
          <caption className="sr-only">{t("compare.caption")}</caption>
          <thead>
            <tr className="border-b border-line align-bottom">
              <th scope="col" className="sticky left-0 z-10 w-[132px] bg-card sm:w-[220px] px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted">
                {t("compare.requirement")}
              </th>
              {cols.map((c) => (
                <th key={c.application_id} scope="col" className="min-w-[170px] px-3 py-3 text-left align-bottom sm:min-w-[190px] font-normal">
                  <Link href={`/recruiter/applications/${c.application_id}`} className="block font-semibold hover:underline">
                    {c.name}
                  </Link>
                  <div className="mt-1.5">
                    <ScoreBar score={c.score} tier={c.tier.id} label={t("rec.scoreAria", { name: c.name })} />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <TierBadge tier={c.tier} />
                    <StageBadge stage={c.stage} />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    {fmtYears(c.years, t)} · {t("rec.countsShort", { matched: c.counts.matched ?? 0, missing: c.counts.missing ?? 0 })}
                  </p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.requirements.map((r, i) => (
              <tr key={i} className="border-b border-line align-top last:border-0" data-testid="compare-row">
                <th scope="row" className="sticky left-0 z-10 w-[132px] bg-card sm:w-[220px] px-3 py-3 text-left font-normal">
                  <p className="break-words text-xs font-medium sm:text-sm">{r.text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                    <Badge tone={r.importance === "required" ? "warn" : "neutral"}>{IMPORTANCE_KEY[r.importance] ? t(IMPORTANCE_KEY[r.importance]) : r.importance}</Badge> {r.kind}
                  </p>
                </th>
                {r.cells.map((cell) => (
                  <td key={cell.application_id} className="px-3 py-3">
                    <Cell cell={cell} who={cols.find((c) => c.application_id === cell.application_id)?.name ?? ""} />
                  </td>
                ))}
              </tr>
            ))}
            {data.requirements.length === 0 && (
              <tr>
                <td colSpan={cols.length + 1} className="px-3 py-6 text-center text-sm text-muted">
                  {t("compare.noReqs")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ cell, who }: { cell: CompareCell; who: string }) {
  const t = useT();
  const status = STATUS_KEY[cell.status] ? t(STATUS_KEY[cell.status]) : cell.status;
  return (
    <div title={cell.explanation ?? undefined} data-testid="compare-cell">
      <span role="img" aria-label={`${who}: ${status}`}>
        <Badge tone={STATUS_TONE[cell.status]}>{status}</Badge>
      </span>
      {(cell.explanation || cell.evidence.length > 0) && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-teal">{t("compare.evidence")}</summary>
          {cell.explanation && <p className="mt-1 text-xs text-ink-2">{cell.explanation}</p>}
          {cell.evidence.map((e, i) => (
            <p key={i} className="mt-1 break-words text-xs italic text-ink-2">
              “{e.text}”
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
