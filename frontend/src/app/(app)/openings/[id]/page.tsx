"use client";

import { BarChart3, ChevronLeft, LogOut, Send, Users } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { OpeningMeta, SampleBadge, StageBadge, TierBadge } from "@/components/leaderboard";
import { MatchBreakdown } from "@/components/match-breakdown";
import { TipsContent } from "@/components/tips-panel";
import { Alert, Badge, Empty, ErrorState, fmtDate, LoadingBlock, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { OpeningApplicationOut, OpeningDetail, Resume, Standing } from "@/lib/types";

export default function OpeningPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading opening…" />}>
      <OpeningView />
    </Suspense>
  );
}

function OpeningView() {
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
  if (!ready || (detail.loading && !detail.data)) return <LoadingBlock label="Loading opening…" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "This opening is not available."} onRetry={detail.reload} />;

  const o = detail.data;
  const app = o.application;
  const appliedResume = app ? usable.find((r) => r.latest_version_id === app.version_id) : undefined;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/openings" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> All openings
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl sm:text-3xl">{o.title}</h1>
          {o.is_demo && <SampleBadge />}
          {app && <Badge tone="teal">Applied</Badge>}
        </div>
        <OpeningMeta o={o} className="mt-1" />
        {o.is_demo && (
          <p className="mt-2 text-xs text-muted">This is a sample listing for trying the product. It is not a real vacancy.</p>
        )}
      </div>

      <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="resume-pick" className="label">
            Compare with resume
          </label>
          {usable.length ? (
            <select id="resume-pick" className="input" value={resume?.id ?? ""} onChange={(e) => pick(e.target.value)}>
              {usable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} (v{r.latest_version_number})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-muted">
              You have no confirmed resumes yet. <Link className="text-teal underline" href="/dashboard">Upload one</Link> to see your match.
            </p>
          )}
        </div>
        {resume && (
          <Link href={`/resumes/${resume.id}/leaderboard`} className="btn btn-ghost btn-sm">
            <BarChart3 className="h-4 w-4" aria-hidden /> Leaderboard for this resume
          </Link>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Section title="About the role" id="about">
            <p className="whitespace-pre-line break-words text-sm leading-relaxed text-ink-2">{o.description}</p>
            {o.requirements.length > 0 && (
              <>
                <h3 className="label mt-5">Requirements</h3>
                <ul className="space-y-1.5 text-sm">
                  {o.requirements.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-2">
                      <Badge tone={r.importance === "required" ? "warn" : "neutral"}>{r.importance}</Badge>
                      <span className="min-w-0">{r.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {o.responsibilities.length > 0 && (
              <>
                <h3 className="label mt-5">Responsibilities</h3>
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
                Your match{resume ? ` · ${resume.title}` : ""}
              </h2>
              <MatchBreakdown m={o.match} idPrefix="om" />
            </section>
          ) : (
            <Empty title="Pick a resume to see your match" />
          )}

          {versionId && (
            <Section title="How to improve for this opening" id="tips">
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
            resumeTitle={resume?.title ?? null}
            app={app}
            appliedWithLabel={app ? (appliedResume ? `${appliedResume.title} (v${appliedResume.latest_version_number})` : "an earlier resume version") : null}
            onChange={detail.reload}
          />
          {app && <StandingCard app={app} />}
        </aside>
      </div>
    </div>
  );
}

const CONSENT_TEXT = "The HR team for this opening will see this resume version and its score";

function ApplyCard({ openingId, versionId, resumeTitle, app, appliedWithLabel, onChange }: {
  openingId: string;
  versionId: string | null;
  resumeTitle: string | null;
  app: OpeningApplicationOut | null;
  appliedWithLabel: string | null;
  onChange: () => Promise<void>;
}) {
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
      setDone(app ? "Re-applied with this resume version." : "Application sent.");
      setConsent(false);
      await onChange();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPending(null);
    }
  }

  async function withdraw() {
    if (!window.confirm("Withdraw your application? The HR team will no longer see your resume for this opening.")) return;
    setPending("withdraw");
    setError(null);
    try {
      await api(`/api/openings/${openingId}/apply`, { method: "DELETE" });
      setDone("Application withdrawn.");
      await onChange();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <Section title={app ? "Your application" : "Apply"} id="apply">
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
            <span className="text-muted">since {fmtDate(app.applied_at)}</span>
          </p>
          <p className="text-ink-2">
            Applied with <strong>{appliedWithLabel}</strong>.
          </p>
        </div>
      )}
      {!versionId ? (
        <p className="text-sm text-muted">Confirm a resume to apply.</p>
      ) : app && sameVersion ? (
        <p className="text-sm text-ink-2">This is the version you applied with. Improve your resume and re-apply any time to update it.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            {app ? "Re-apply with " : "Apply with "}
            <strong>{resumeTitle}</strong> (latest version).
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
            <span>{CONSENT_TEXT}.</span>
          </label>
          {needConsent && !consent && (
            <p id="consent-err" className="text-sm font-medium text-bad" role="alert">
              Tick the box to agree before applying. Nothing is shared until you do.
            </p>
          )}
          <button className="btn btn-primary w-full justify-center" onClick={apply} disabled={!!pending}>
            {pending === "apply" ? <Spinner label="Sending" /> : (<><Send className="h-4 w-4" aria-hidden /> {app ? "Re-apply" : "Apply"}</>)}
          </button>
        </div>
      )}
      {app && (
        <button className="btn btn-ghost btn-sm mt-3" onClick={withdraw} disabled={!!pending}>
          {pending === "withdraw" ? <Spinner label="Withdrawing" /> : (<><LogOut className="h-4 w-4" aria-hidden /> Withdraw application</>)}
        </button>
      )}
    </Section>
  );
}

function StandingCard({ app }: { app: OpeningApplicationOut }) {
  const s: Standing = app.standing;
  return (
    <Section title="Where you stand" id="standing">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span>
          Your score <strong className="num">{Math.round(app.score)}</strong>/100
        </span>
        <TierBadge tier={app.tier} />
      </div>
      <p className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-muted">Recruiter stage:</span> <StageBadge stage={app.stage} />
      </p>
      {!s.available ? (
        <div className="rounded-lg bg-paper-2 p-3 text-sm" data-testid="standing-unavailable">
          <p className="flex items-center gap-2 font-semibold">
            <Users className="h-4 w-4" aria-hidden /> {s.applicants} {s.applicants === 1 ? "applicant" : "applicants"} so far
          </p>
          <p className="mt-1 text-ink-2">{s.message}</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="standing-available">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-paper-2 p-2">
              <p className="num text-2xl font-semibold">#{s.rank}</p>
              <p className="text-[11px] text-muted">of {s.applicants}</p>
            </div>
            <div className="rounded-lg bg-paper-2 p-2">
              <p className="num text-2xl font-semibold">{s.top_percent}%</p>
              <p className="text-[11px] text-muted">top</p>
            </div>
            <div className="rounded-lg bg-paper-2 p-2">
              <p className="num text-2xl font-semibold">{Math.round(s.median)}</p>
              <p className="text-[11px] text-muted">median</p>
            </div>
          </div>
          <p className="text-sm">
            You&apos;re <strong>#{s.rank}</strong> of {s.applicants} applicants, in the <strong>top {s.top_percent}%</strong>.
          </p>
          <Histogram dist={s.distribution} mine={s.my_score} />
          <p className="text-xs text-muted">{s.note}</p>
        </div>
      )}
    </Section>
  );
}

function Histogram({ dist, mine }: { dist: { from: number; to: number; count: number }[]; mine: number }) {
  const max = Math.max(1, ...dist.map((d) => d.count));
  const myBand = Math.min(9, Math.floor(Math.max(0, mine) / 10));
  const summary = dist
    .filter((d) => d.count)
    .map((d) => `${d.from}–${d.to}: ${d.count}`)
    .join(", ");
  return (
    <figure>
      <div
        className="flex h-24 items-end gap-1 border-b border-line-strong"
        role="img"
        aria-label={`Anonymous score distribution in 10-point bands. ${summary}. Your band, ${myBand * 10}–${myBand * 10 + 9}, is highlighted.`}
      >
        {dist.map((d, i) => (
          <div key={d.from} className="flex h-full flex-1 flex-col justify-end">
            <div
              className={`w-full rounded-t ${i === myBand ? "bg-teal" : "bg-line-strong"}`}
              style={{ height: d.count ? `${Math.max(6, (d.count / max) * 100)}%` : 0 }}
              title={`${d.from}–${d.to}: ${d.count}`}
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
        <span>Your band. Other bars show how many people scored in each range; no names or individual scores.</span>
      </figcaption>
    </figure>
  );
}
