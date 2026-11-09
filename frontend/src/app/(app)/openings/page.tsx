"use client";

import { ArrowRight, BarChart3, Briefcase } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { OpeningMeta, SampleBadge, StageBadge, TierBadge } from "@/components/leaderboard";
import { Badge, Empty, ErrorState, fmtDate, LoadingBlock, PageHeader, Section } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { MyOpeningApplication, Opening, Resume } from "@/lib/types";

export default function OpeningsPage() {
  const t = useT();
  const openings = useApi<Opening[]>("/api/openings");
  const mine = useApi<MyOpeningApplication[]>("/api/me/opening-applications");
  const resumes = useApi<Resume[]>("/api/resumes");
  const usable = useMemo(() => (resumes.data ?? []).filter((r) => r.latest_version_id), [resumes.data]);
  const [picked, setPicked] = useState<string>("");
  const resumeId = picked || usable[0]?.id || "";
  const applied = new Map((mine.data ?? []).map((a) => [a.opening.id, a]));

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={t("openings.eyebrow")} title={t("openings.title")}>
        {t("openings.intro")}
      </PageHeader>

      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="match-resume" className="label">
            {t("openings.matchAgainst")}
          </label>
          {resumes.loading && !resumes.data ? (
            <p className="text-sm text-muted">{t("openings.loadingResumes")}</p>
          ) : usable.length ? (
            <select id="match-resume" className="input" value={resumeId} onChange={(e) => setPicked(e.target.value)}>
              {usable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} (v{r.latest_version_number})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-muted">
              {t.rich("openings.noResume", {
                link: (c) => (
                  <Link href="/dashboard" className="text-teal underline">
                    {c}
                  </Link>
                ),
              })}
            </p>
          )}
        </div>
        {resumeId && (
          <Link href={`/resumes/${resumeId}/leaderboard`} className="btn btn-secondary btn-sm">
            <BarChart3 className="h-4 w-4 shrink-0" aria-hidden /> {t("openings.rankForResume")}
          </Link>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="open-h" className="min-w-0 space-y-3">
          <h2 id="open-h" className="text-xl">
            {t("openings.openNow")}
          </h2>
          {openings.loading && !openings.data ? (
            <LoadingBlock />
          ) : openings.error ? (
            <ErrorState message={openings.error} onRetry={openings.reload} />
          ) : !openings.data?.length ? (
            <Empty icon={<Briefcase className="h-8 w-8" aria-hidden />} title={t("openings.empty")}>
              {t("openings.emptyBody")}
            </Empty>
          ) : (
            <ul className="space-y-3">
              {openings.data.map((o) => {
                const a = applied.get(o.id);
                const href = `/openings/${o.id}${resumeId ? `?resume=${resumeId}` : ""}`;
                return (
                  <li key={o.id} className="card p-4" data-testid="opening-card">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={href} className="font-display text-lg leading-tight hover:underline">
                            {o.title}
                          </Link>
                          {o.is_demo && <SampleBadge />}
                          {a && <Badge tone="teal">{t("openings.applied")}</Badge>}
                        </div>
                        <OpeningMeta o={o} className="mt-1" />
                      </div>
                      <Link href={href} className="btn btn-secondary btn-sm" aria-label={t("openings.viewAria", { title: o.title, company: o.company })}>
                        {t("openings.view")} <ArrowRight className="h-4 w-4" aria-hidden />
                      </Link>
                    </div>
                    {o.skills.length > 0 && (
                      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t("openings.skillsAsked")}>
                        {o.skills.slice(0, 10).map((s) => (
                          <li key={s}>
                            <Badge>{s}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside>
          <Section title={t("openings.myApplications")} id="my-apps">
            {mine.loading && !mine.data ? (
              <LoadingBlock />
            ) : mine.error ? (
              <ErrorState message={mine.error} onRetry={mine.reload} />
            ) : !mine.data?.length ? (
              <p className="text-sm text-muted">{t("openings.noApplications")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {mine.data.map((a) => (
                  <li key={a.id} className="py-3">
                    {a.opening.status === "open" ? (
                      <Link href={`/openings/${a.opening.id}`} className="font-medium hover:underline">
                        {a.opening.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{a.opening.title}</span>
                    )}
                    <p className="text-xs text-muted">
                      {a.opening.company} · {t("openings.appliedOn", { date: fmtDate(a.applied_at) })}
                      {a.opening.status === "closed" && t("openings.closed")}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <span className="num font-semibold">{Math.round(a.score)}</span>
                      <TierBadge tier={a.tier} />
                      <StageBadge stage={a.stage} />
                    </div>
                    <p className="mt-1 text-xs text-ink-2">
                      {a.standing.available
                        ? t("openings.standing", { rank: a.standing.rank ?? "", applicants: a.standing.applicants, top: a.standing.top_percent ?? "" })
                        : t("openings.soFar", { count: a.standing.applicants })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </div>
  );
}
