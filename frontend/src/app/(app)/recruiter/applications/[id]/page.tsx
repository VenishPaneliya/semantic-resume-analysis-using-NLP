"use client";

import { ChevronLeft, Eye } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TierBadge } from "@/components/leaderboard";
import { MatchBreakdown } from "@/components/match-breakdown";
import { ResumePreview } from "@/components/preview";
import { StageSelect } from "@/components/stage-select";
import { Alert, ErrorState, fmtDate, LoadingBlock, Section } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { RecruiterApplication } from "@/lib/types";

export default function RecruiterApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: a, setData, error, loading, reload } = useApi<RecruiterApplication>(`/api/recruiter/applications/${id}`);

  if (loading && !a) return <LoadingBlock label="Loading application…" />;
  if (error || !a) return <ErrorState message={error ?? "Application not found."} onRetry={reload} />;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/recruiter/openings/${a.opening_id}`} className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> Back to candidates
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl sm:text-3xl">{a.name}</h1>
              <TierBadge tier={a.tier} />
            </div>
            <p className="text-sm text-ink-2">
              <a href={`mailto:${a.email}`} className="underline">
                {a.email}
              </a>{" "}
              · applied {fmtDate(a.applied_at)} · score <span className="num font-semibold">{Math.round(a.score)}</span>/100
            </p>
          </div>
          <div className="w-full sm:w-48">
            <p className="label">Stage</p>
            <StageSelect applicationId={a.id} stage={a.stage} name={a.name} onChange={(stage) => setData({ ...a, stage })} />
          </div>
        </div>
      </div>

      <Alert tone="info" title="Use this to prioritise reading">
        The score compares the resume with this opening&apos;s requirements. It doesn&apos;t see names, contact details, employers, schools or protected
        attributes. Read the resume before deciding.
      </Alert>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {a.match ? (
            <MatchBreakdown m={a.match} tier={a.tier} idPrefix="ra" />
          ) : (
            <Alert tone="warn">No match breakdown is stored for this application.</Alert>
          )}
        </div>
        <Section
          title="Resume as submitted"
          id="resume"
          aside={
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Eye className="h-3.5 w-3.5" aria-hidden /> Read-only
            </span>
          }
        >
          <div className="relative overflow-x-auto">
            <ResumePreview c={a.resume} />
          </div>
        </Section>
      </div>
    </div>
  );
}
