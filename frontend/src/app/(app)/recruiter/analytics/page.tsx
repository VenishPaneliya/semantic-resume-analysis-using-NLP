"use client";

import { AlertTriangle, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { SampleBadge } from "@/components/leaderboard";
import { STAGE_KEY } from "@/components/stage-select";
import { Badge, Bar, Empty, EnglishNote, ErrorState, LoadingBlock, PageHeader, Section } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { STAGES, type Analytics } from "@/lib/types";

export default function AnalyticsPage() {
  const t = useT();
  const [demo, setDemo] = useState(false);
  const { data, error, loading, reload } = useApi<Analytics>(`/api/recruiter/analytics?include_demo=${demo}`);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("rec.eyebrow")}
        title={t("analytics.title")}
        actions={
          <label className="flex items-center gap-2 rounded-md border border-line bg-card px-3 py-1.5 text-sm">
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
            {t("analytics.includeSample")}
          </label>
        }
      >
        {t("analytics.intro")}
      </PageHeader>

      {loading && !data ? (
        <LoadingBlock label={t("analytics.loading")} />
      ) : error || !data ? (
        <ErrorState message={error ?? t("analytics.loadError")} onRetry={reload} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(5,minmax(0,1fr))]" data-testid="analytics-totals">
            <Stat k={t("analytics.openOpenings")} v={data.totals.openings_open} />
            <Stat k={t("analytics.closedOpenings")} v={data.totals.openings_closed} />
            <Stat k={t("analytics.candidates")} v={data.totals.candidates} sub={t("analytics.candidatesSub", { applied: data.totals.applied, uploaded: data.totals.uploaded })} />
            <Stat k={t("analytics.medianScore")} v={data.totals.median_score ?? "—"} sub={t("analytics.medianSub")} />
            <Stat k={t("analytics.hardToFill")} v={data.openings.filter((o) => o.hard_to_fill).length} sub={t("analytics.hardSub")} />
          </dl>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Section title={t("analytics.pipeline")} id="stages">
              {data.totals.candidates === 0 ? (
                <p className="text-sm text-muted">{t("analytics.noCandidates")}</p>
              ) : (
                <ul className="space-y-2.5">
                  {STAGES.map((s) => {
                    const n = data.totals.stages[s] ?? 0;
                    return (
                      <li key={s} className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_40px] items-center gap-3 text-sm">
                        <span className="break-words">{t(STAGE_KEY[s])}</span>
                        <Bar value={n} max={Math.max(1, data.totals.candidates)} label={`${t(STAGE_KEY[s])}: ${n}`} />
                        <span className="num text-right font-semibold">{n}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
            <Section title={t("analytics.mostMissing")} id="missing">
              {data.most_missing_skills.length === 0 ? (
                <p className="text-sm text-muted">{t("analytics.nothing")}</p>
              ) : (
                <ul className="space-y-2.5" data-testid="missing-skills">
                  {data.most_missing_skills.map((m) => (
                    <li key={m.skill} className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_72px] items-center gap-3 text-sm">
                      <span className="truncate" title={m.skill}>
                        {m.skill}
                      </span>
                      <Bar value={m.share} tone="muted" label={t("analytics.missingAria", { skill: m.skill, pct: Math.round(m.share * 100) })} />
                      <span className="num text-right text-xs text-ink-2">
                        {m.candidates} · {Math.round(m.share * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted">{t("analytics.missingNote")}</p>
            </Section>
          </div>

          <Section title={t("analytics.openings")} id="openings">
            {data.openings.length === 0 ? (
              <Empty title={t("analytics.noOpenings")}>{demo ? t("analytics.nothingPosted") : t("analytics.tickSample")}</Empty>
            ) : (
              <div className="-mx-5 overflow-x-auto sm:-mx-6">
                <table className="w-full min-w-[760px] text-sm" data-testid="analytics-openings">
                  <caption className="sr-only">{t("analytics.caption")}</caption>
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                      <th scope="col" className="px-5 py-2 font-semibold sm:px-6">{t("rec.col.opening")}</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">{t("analytics.candidates")}</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">{t("analytics.strong")}</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">{t("analytics.medianScore")}</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">{t("analytics.advanced")}</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">{t("analytics.medianDays")}</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">{t("analytics.age")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.openings.map((o) => (
                      <tr key={o.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5 sm:px-6">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={`/recruiter/openings/${o.id}`} className="font-medium hover:underline">
                              {o.title}
                            </Link>
                            {o.hard_to_fill && (
                              <Badge tone="warn">
                                <AlertTriangle className="h-3 w-3" aria-hidden /> {t("analytics.hardToFill")}
                              </Badge>
                            )}
                            {o.status === "closed" && <Badge>{t("rec.statusClosed")}</Badge>}
                            {o.is_demo && <SampleBadge />}
                          </div>
                          <p className="text-xs text-muted">{o.company}</p>
                        </td>
                        <td className="num px-3 py-2.5 text-right">{o.applicants}</td>
                        <td className="num px-3 py-2.5 text-right">{o.strong_matches}</td>
                        <td className="num px-3 py-2.5 text-right">{o.median_score ?? "—"}</td>
                        <td className="num px-3 py-2.5 text-right">{o.advanced}</td>
                        <td className="num px-3 py-2.5 text-right">{o.median_days_to_advance ?? "—"}</td>
                        <td className="num px-3 py-2.5 text-right">{o.age_days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <section className="rounded-lg border border-line bg-card p-4" aria-labelledby="an-notes">
            <h2 id="an-notes" className="flex items-center gap-1.5 text-base">
              <Info className="h-4 w-4 text-teal" aria-hidden /> {t("analytics.howToRead")}
            </h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>{t("analytics.scoresNote")}</li>
            </ul>
            <EnglishNote kind="generic" className="mt-2" />
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: number | string; sub?: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="num mt-1 text-2xl font-semibold">{v}</dd>
      {sub && <dd className="text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}
