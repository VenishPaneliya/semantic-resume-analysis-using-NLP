"use client";

import { BarChart3, ChevronLeft, LogOut, Send, Users } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { OpeningMeta, SampleBadge, StageBadge, TierBadge } from "@/components/leaderboard";
import { MatchBreakdown } from "@/components/match-breakdown";
import { TipsContent } from "@/components/tips-panel";
import { Alert, Badge, Empty, EnglishNote, ErrorState, fmtDate, LoadingBlock, NotFoundState, Section, Spinner } from "@/components/ui";
import { resumeTitle } from "@/lib/labels";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { OpeningApplicationOut, OpeningDetail, Resume, Standing } from "@/lib/types";

export default function OpeningPage() {
  const t = useT();
  return (
    <Suspense fallback={<LoadingBlock label={t("opening.loading")} />}>
      <OpeningView />
    </Suspense>
  );
}

const IMPORTANCE: Record<string, MessageKey> = { required: "opening.importance.required", preferred: "opening.importance.preferred" };

function OpeningView() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const resumes = useApi<Resume[]>("/api/resumes");
  const usable = useMemo(() => (resumes.data ?? []).filter((r) => r.latest_version_id), [resumes.data]);
  const [picked, setPicked] = useState<string | null>(params.get("resume"));

  // a picked resume must be one of mine with a confirmed version; otherwise fall back to the first
  const resume = usable.find((r) => r.id === picked) ?? (resumes.data ? usable[0] ?? null : null);
  const versionId = resume?.latest_version_id ?? null;
  const ready = !!resumes.data;

  const detail = useApi<OpeningDetail>(ready ? `/api/openings/${id}${versionId ? `?version_id=${versionId}` : ""}` : null);

  function pick(rid: string) {
    setPicked(rid);
    router.replace(`/openings/${id}?resume=${rid}`, { scroll: false });
  }

  if (resumes.error) return <ErrorState message={resumes.error} onRetry={resumes.reload} />;
  if (!ready || (detail.loading && !detail.data)) return <LoadingBlock label={t("opening.loading")} />;
  if (detail.errorCode === "not_found" || detail.errorCode === "http_404")
    return <NotFoundState title={t("opening.notFoundTitle")} body={t("opening.notFoundBody")} backHref="/openings" backLabel={t("opening.all")} />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? t("opening.unavailable")} onRetry={detail.reload} />;

  const o = detail.data;
  // a closed opening stays visible to people who applied (to follow their stage), but takes no applications
  const closed = o.status === "closed";
  const app = o.application;
  const appliedResume = app ? usable.find((r) => r.latest_version_id === app.version_id) : undefined;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/openings" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> {t("opening.all")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl sm:text-3xl" lang="en">{o.title}</h1>
          {o.is_demo && <SampleBadge />}
          {app && <Badge tone="teal">{t("openings.applied")}</Badge>}
          {closed && <Badge tone="neutral">{t("opening.closedBadge")}</Badge>}
        </div>
        <OpeningMeta o={o} className="mt-1" />
        {o.is_demo && <p className="mt-2 text-xs text-muted">{t("opening.sampleNote")}</p>}
        <EnglishNote kind="generic" className="mt-2" />
        {closed && (
          <div className="mt-3">
            <Alert tone="warn" title={t("opening.closedTitle")}>
              {t("opening.closedBody")}
            </Alert>
          </div>
        )}
      </div>

      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="resume-pick" className="label">
            {t("opening.compareWith")}
          </label>
          {usable.length ? (
            <select id="resume-pick" className="input" value={resume?.id ?? ""} onChange={(e) => pick(e.target.value)}>
              {usable.map((r) => (
                <option key={r.id} value={r.id}>
                  {resumeTitle(t, r)} (v{r.latest_version_number})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-muted">
              {t.rich("opening.noResume", {
                link: (c) => (
                  <Link className="text-teal underline" href="/dashboard">
                    {c}
                  </Link>
                ),
              })}
            </p>
          )}
        </div>
        {resume && (
          <Link href={`/resumes/${resume.id}/leaderboard`} className="btn btn-ghost btn-sm">
            <BarChart3 className="h-4 w-4 shrink-0" aria-hidden /> {t("opening.leaderboardForResume")}
          </Link>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Section title={t("opening.about")} id="about">
            <p className="whitespace-pre-line break-words text-sm leading-relaxed text-ink-2">{o.description}</p>
            {o.requirements.length > 0 && (
              <>
                <h3 className="label mt-5">{t("opening.requirements")}</h3>
                <ul className="space-y-1.5 text-sm">
                  {o.requirements.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-2">
                      <Badge tone={r.importance === "required" ? "warn" : "neutral"}>{IMPORTANCE[r.importance] ? t(IMPORTANCE[r.importance]) : r.importance}</Badge>
                      <span className="min-w-0">{r.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {o.responsibilities.length > 0 && (
              <>
                <h3 className="label mt-5">{t("opening.responsibilities")}</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {o.responsibilities.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          {o.match ? (
            <section aria-labelledby="your-match" className="space-y-3">
              <h2 id="your-match" className="text-2xl">
                {resume ? t("opening.yourMatchWith", { title: resumeTitle(t, resume) }) : t("opening.yourMatch")}
              </h2>
              <MatchBreakdown m={o.match} idPrefix="om" />
            </section>
          ) : (
            <Empty title={t("opening.pickResume")} />
          )}

          {versionId && !closed && (
            <Section title={t("opening.improve")} id="tips">
              <TipsContent
                key={versionId}
                versionId={versionId}
                target={{ kind: "opening", id: o.id, title: o.title }}
                headingLevel={3}
                onVersionChange={() => {
                  void resumes.reload();
                }}
              />
            </Section>
          )}
        </div>

        <aside className="order-first space-y-5 lg:order-none">
          <ApplyCard
            openingId={o.id}
            versionId={versionId}
            resumeTitle={resume ? resumeTitle(t, resume) : null}
            app={app}
            closed={closed}
            appliedWithLabel={app ? (appliedResume ? `${resumeTitle(t, appliedResume)} (v${appliedResume.latest_version_number})` : t("opening.earlierVersion")) : null}
            onChange={detail.reload}
          />
          {app && <StandingCard app={app} />}
        </aside>
      </div>
    </div>
  );
}

function ApplyCard({ openingId, versionId, resumeTitle, app, closed, appliedWithLabel, onChange }: {
  openingId: string;
  versionId: string | null;
  resumeTitle: string | null;
  app: OpeningApplicationOut | null;
  closed: boolean;
  appliedWithLabel: string | null;
  onChange: () => Promise<void>;
}) {
  const t = useT();
  const confirm = useConfirm();
  const [consent, setConsent] = useState(false);
  const [needConsent, setNeedConsent] = useState(false);
  const [pending, setPending] = useState<"apply" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const sameVersion = !!app && app.version_id === versionId;

  async function apply() {
    if (!versionId) return;
    if (!consent) {
      setNeedConsent(true);
      return;
    }
    setPending("apply");
    setError(null);
    try {
      await api(`/api/openings/${openingId}/apply`, { body: { version_id: versionId, share_consent: true } });
      setDone(app ? t("opening.reapplied") : t("opening.sent"));
      setConsent(false);
      await onChange();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPending(null);
    }
  }

  async function withdraw() {
    if (!(await confirm({ title: t("opening.confirmWithdraw"), confirmLabel: t("opening.withdraw") }))) return;
    setPending("withdraw");
    setError(null);
    try {
      await api(`/api/openings/${openingId}/apply`, { method: "DELETE" });
      setDone(t("opening.withdrawn"));
      await onChange();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <Section title={app ? t("opening.yourApplication") : t("opening.apply")} id="apply">
      {done && (
        <div className="mb-3">
          <Alert tone="ok">{done}</Alert>
        </div>
      )}
      {error && (
        <div className="mb-3">
          <Alert tone="bad">{error}</Alert>
        </div>
      )}
      {app && (
        <div className="mb-4 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <StageBadge stage={app.stage} />
            <span className="text-muted">{t("opening.since", { date: fmtDate(app.applied_at) })}</span>
          </p>
          <p className="text-ink-2">{t.rich("opening.appliedWith", { b: (c) => <strong>{c}</strong> }, { label: appliedWithLabel ?? "" })}</p>
        </div>
      )}
      {closed ? (
        <p className="text-sm text-ink-2" data-testid="closed-no-apply">{app ? t("opening.closedNoReapply") : t("opening.closedNoApply")}</p>
      ) : !versionId ? (
        <p className="text-sm text-muted">{t("opening.confirmToApply")}</p>
      ) : app && sameVersion ? (
        <p className="text-sm text-ink-2">{t("opening.sameVersion")}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            {t.rich(app ? "opening.reapplyWith" : "opening.applyWith", { b: (c) => <strong>{c}</strong> }, { title: resumeTitle ?? "" })}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={consent}
              aria-invalid={needConsent && !consent}
              aria-describedby={needConsent && !consent ? "consent-err" : undefined}
              onChange={(e) => {
                setConsent(e.target.checked);
                setNeedConsent(false);
              }}
            />
            <span>{t("opening.consent")}</span>
          </label>
          {needConsent && !consent && (
            <p id="consent-err" className="text-sm font-medium text-bad" role="alert">
              {t("opening.consentError")}
            </p>
          )}
          <button className="btn btn-primary w-full justify-center" onClick={apply} disabled={!!pending}>
            {pending === "apply" ? <Spinner label={t("opening.sending")} /> : (<><Send className="h-4 w-4" aria-hidden /> {app ? t("opening.reapply") : t("opening.apply")}</>)}
          </button>
        </div>
      )}
      {app && (
        <button className="btn btn-ghost btn-sm mt-3" onClick={withdraw} disabled={!!pending}>
          {pending === "withdraw" ? <Spinner label={t("opening.withdrawing")} /> : (<><LogOut className="h-4 w-4" aria-hidden /> {t("opening.withdraw")}</>)}
        </button>
      )}
    </Section>
  );
}

function StandingCard({ app }: { app: OpeningApplicationOut }) {
  const t = useT();
  const s: Standing = app.standing;
  return (
    <Section title={t("opening.whereYouStand")} id="standing">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span>{t.rich("opening.yourScore", { b: (c) => <strong className="num">{c}</strong> }, { score: Math.round(app.score) })}</span>
        <TierBadge tier={app.tier} />
      </div>
      <p className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-muted">{t("opening.recruiterStage")}</span> <StageBadge stage={app.stage} />
      </p>
      {!s.available ? (
        <div className="rounded-lg bg-paper-2 p-3 text-sm" data-testid="standing-unavailable">
          <p className="flex items-center gap-2 font-semibold">
            <Users className="h-4 w-4 shrink-0" aria-hidden /> {t("opening.applicantsSoFar", { count: s.applicants })}
          </p>
          <p className="mt-1 text-ink-2">{s.message}</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="standing-available">
          <div className={`grid gap-2 text-center ${s.median != null ? "grid-cols-3" : "grid-cols-2"}`}>
            <div className="rounded-lg bg-paper-2 p-2">
              <p className="num text-2xl font-semibold">#{s.rank}</p>
              <p className="text-[11px] text-muted">{t("opening.of", { count: s.applicants })}</p>
            </div>
            <div className="rounded-lg bg-paper-2 p-2">
              <p className="num text-2xl font-semibold">{s.top_percent}%</p>
              <p className="text-[11px] text-muted">{t("opening.top")}</p>
            </div>
            {s.median != null && (
              <div className="rounded-lg bg-paper-2 p-2">
                <p className="num text-2xl font-semibold">≈{Math.round(s.median)}</p>
                <p className="text-[11px] text-muted">{t("opening.median")}</p>
              </div>
            )}
          </div>
          <p className="text-sm">
            {t.rich("opening.rankSentence", { b: (c) => <strong>{c}</strong> }, { rank: s.rank ?? "", applicants: s.applicants, top: s.top_percent ?? "" })}
          </p>
          {s.distribution ? (
            <Histogram dist={s.distribution} mine={s.my_score} />
          ) : (
            <p className="text-xs text-muted" data-testid="spread-later">{t("opening.spreadLater", { min: s.distribution_min_pool })}</p>
          )}
          <p className="text-xs text-muted">{s.note}</p>
        </div>
      )}
    </Section>
  );
}

function Histogram({ dist, mine }: { dist: { from: number; to: number; count: number | null }[]; mine: number }) {
  const t = useT();
  // a band with 1-2 people has count null ("a few"): drawn as a short bar without a number
  const FEW = 1.5;
  const n = (c: number | null) => (c === null ? FEW : c);
  const label = (c: number | null) => (c === null ? t("opening.few") : String(c));
  const max = Math.max(1, ...dist.map((d) => n(d.count)));
  const myBand = Math.min(9, Math.floor(Math.max(0, mine) / 10));
  const summary = dist
    .filter((d) => d.count)
    .map((d) => `${d.from}–${d.to}: ${label(d.count)}`)
    .join(", ");
  return (
    <figure>
      <div
        className="flex h-24 items-end gap-1 border-b border-line-strong"
        role="img"
        aria-label={t("opening.histAria", { summary, from: myBand * 10, to: myBand * 10 + 9 })}
      >
        {dist.map((d, i) => (
          <div key={d.from} className="flex h-full flex-1 flex-col justify-end">
            <div
              className={`w-full rounded-t ${i === myBand ? "bg-teal" : "bg-line-strong"}`}
              style={{ height: d.count !== 0 ? `${Math.max(6, (n(d.count) / max) * 100)}%` : 0 }}
              title={`${d.from}–${d.to}: ${label(d.count)}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted num" aria-hidden>
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
      <figcaption className="mt-1 flex items-start gap-1.5 text-xs text-ink-2">
        <span className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-sm bg-teal" aria-hidden />
        <span>{t("opening.histLegend")}</span>
      </figcaption>
    </figure>
  );
}
