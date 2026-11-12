"use client";

import { ChevronLeft, Eye, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm } from "@/components/confirm";
import { TierBadge } from "@/components/leaderboard";
import { MatchBreakdown } from "@/components/match-breakdown";
import { ResumePreview } from "@/components/preview";
import { fmtYears, NotesPanel, UploadedBadge } from "@/components/recruiter";
import { useUser } from "@/components/shell";
import { StageSelect } from "@/components/stage-select";
import { Alert, EnglishNote, ErrorState, fmtDate, LoadingBlock, Section } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { RecruiterApplication } from "@/lib/types";

export default function RecruiterApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useUser();
  const t = useT();
  const confirm = useConfirm();
  const { data: a, setData, error, loading, reload } = useApi<RecruiterApplication>(`/api/recruiter/applications/${id}`);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  if (loading && !a) return <LoadingBlock label={t("recapp.loading")} />;
  if (error || !a) return <ErrorState message={error ?? t("recapp.notFound")} onRetry={reload} />;

  async function remove() {
    if (!a || !(await confirm({ title: t("rec.confirmRemove", { name: a.name }), confirmLabel: t("common.remove") }))) return;
    try {
      await api(`/api/recruiter/applications/${a.id}`, { method: "DELETE" });
      router.push(`/recruiter/openings/${a.opening_id}`);
    } catch (e) {
      setRemoveErr(errMsg(e));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/recruiter/openings/${a.opening_id}`} className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> {t("rec.backToCandidates")}
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl sm:text-3xl">{a.name}</h1>
              <TierBadge tier={a.tier} />
              {a.source === "uploaded" && <UploadedBadge expiresAt={a.expires_at} />}
            </div>
            <p className="text-sm text-ink-2">
              {a.email && (
                <>
                  <a href={`mailto:${a.email}`} className="break-all underline">
                    {a.email}
                  </a>{" "}
                  ·{" "}
                </>
              )}
              {a.source === "uploaded" ? t("recapp.uploadedOn", { date: fmtDate(a.applied_at) }) : t("recapp.appliedOn", { date: fmtDate(a.applied_at) })} ·{" "}
              {t.rich("recapp.score", { b: (c) => <span className="num font-semibold">{c}</span> }, { score: Math.round(a.score) })}
              {a.facts && <> · {t("recapp.experience", { years: fmtYears(a.facts.years, t) })}</>}
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-48">
            <div>
              <p className="label">{t("recapp.stage")}</p>
              <StageSelect applicationId={a.id} stage={a.stage} name={a.name} onChange={(stage) => setData({ ...a, stage })} />
            </div>
            {a.source === "uploaded" && (
              <button className="btn btn-ghost btn-sm justify-center text-bad" onClick={remove}>
                <Trash2 className="h-4 w-4" aria-hidden /> {t("recapp.remove")}
              </button>
            )}
          </div>
        </div>
      </div>

      {removeErr && <Alert tone="bad">{removeErr}</Alert>}
      <Alert tone="info" title={t("recapp.useTitle")}>
        {t("recapp.useBody")}
      </Alert>
      <EnglishNote />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <NotesPanel applicationId={a.id} notes={a.notes} currentUserId={user.id} isAdmin={user.role === "admin"} onChange={(notes) => setData({ ...a, notes })} />
          {a.match ? (
            <MatchBreakdown m={a.match} tier={a.tier} idPrefix="ra" />
          ) : (
            <Alert tone="warn">{t("recapp.noMatch")}</Alert>
          )}
        </div>
        <Section
          title={t("recapp.resume")}
          id="resume"
          aside={
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Eye className="h-3.5 w-3.5" aria-hidden /> {t("recapp.readOnly")}
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
