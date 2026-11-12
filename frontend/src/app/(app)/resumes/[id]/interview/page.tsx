"use client";

import { CheckCircle2, ChevronLeft, ChevronRight, ListChecks, MessageSquareQuote, Play, Sparkles, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { AIBadge, Alert, Badge, Empty, EnglishNote, ErrorState, Field, FixtureBadge, fmtDate, LoadingBlock, Section, Spinner } from "@/components/ui";
import { roleTitle } from "@/lib/labels";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey, type TFunction } from "@/lib/i18n";
import type { AiFeedback, AnswerChecks, InterviewAnswer, InterviewSession, InterviewSummary, Opening, RoleLeaderboard, Version } from "@/lib/types";
import { useResume } from "../context";

export default function InterviewPage() {
  const t = useT();
  const confirm = useConfirm();
  const { versionId, resume } = useResume();
  const sessions = useApi<InterviewSummary[]>("/api/interviews");
  // the API lists every practice session on the account; show only this resume's (any of its versions)
  const versions = useApi<Version[]>(`/api/resumes/${resume.id}/versions`, [versionId]);
  const mine = useMemo(() => {
    if (!sessions.data || !versions.data) return null;
    const ids = new Set(versions.data.map((v) => v.id));
    return sessions.data.filter((s) => ids.has(s.version_id));
  }, [sessions.data, versions.data]);
  const [active, setActive] = useState<InterviewSession | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!versionId) return <Empty level={2} title={t("resume.confirmFirst")}>{t("interview.emptyBody")}</Empty>;

  async function open(id: string) {
    setOpening(id);
    setErr(null);
    try {
      setActive(await api<InterviewSession>(`/api/interviews/${id}`));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setOpening(null);
    }
  }
  async function remove(s: InterviewSummary) {
    if (!(await confirm({ title: t("interview.confirmDelete") }))) return;
    try {
      await api(`/api/interviews/${s.id}`, { method: "DELETE" });
      if (active?.id === s.id) setActive(null);
      await sessions.reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <div className="space-y-6">
        <StartCard
          versionId={versionId}
          onStarted={async (s) => {
            setActive(s);
            await sessions.reload();
          }}
        />
        <Section title={t("interview.past")} id="past">
          {sessions.error || versions.error ? (
            <ErrorState message={(sessions.error ?? versions.error)!} onRetry={() => void Promise.all([sessions.reload(), versions.reload()])} />
          ) : !mine ? (
            <LoadingBlock />
          ) : !mine.length ? (
            <p className="text-sm text-muted">{t("interview.noSessions")}</p>
          ) : (
            <ul className="space-y-2" data-testid="past-sessions">
              {mine.map((s) => (
                <li key={s.id} className={`flex items-start gap-2 rounded-md border p-2 text-sm ${active?.id === s.id ? "border-teal bg-teal-soft/50" : "border-line"}`}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => open(s.id)} disabled={opening === s.id}>
                    <span className="block truncate font-medium">{targetTitle(t, s.target)}</span>
                    <span className="text-xs text-muted">
                      {fmtDate(s.created_at)} · {t("interview.answered", { done: s.answered, total: s.questions })}
                    </span>
                  </button>
                  <button className="btn btn-ghost btn-sm !p-1 text-muted" aria-label={t("interview.deleteSession")} onClick={() => remove(s)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <div className="min-w-0 space-y-4">
        {err && <Alert tone="bad">{err}</Alert>}
        {active ? (
          <Practice key={active.id} session={active} onAnswered={() => void sessions.reload()} />
        ) : (
          <Empty icon={<MessageSquareQuote className="h-8 w-8" aria-hidden />} title={t("interview.emptyTitle")}>
            {t("interview.emptyIntro")}
          </Empty>
        )}
      </div>
    </div>
  );
}

function targetTitle(t: TFunction, target: InterviewSession["target"]) {
  if (!target.title && !target.id) return t("interview.general");
  return target.kind === "role" ? roleTitle(t, target.id, target.title) : (target.title ?? t("interview.general"));
}

function StartCard({ versionId, onStarted }: { versionId: string; onStarted: (s: InterviewSession) => void }) {
  const t = useT();
  const roles = useApi<RoleLeaderboard>(`/api/versions/${versionId}/leaderboard/roles`);
  const openings = useApi<Opening[]>("/api/openings");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const top = (roles.data?.rows ?? []).slice(0, 8);
  const value = target || (top[0] ? `role:${top[0].role_id}` : "");

  async function start() {
    setBusy(true);
    setErr(null);
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    try {
      onStarted(await api<InterviewSession>(`/api/versions/${versionId}/interviews`, { body: kind === "role" ? { role_id: id } : kind === "opening" ? { opening_id: id } : {} }));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={t("interview.new")} id="start">
      <div className="space-y-3">
        <Field label={t("interview.practiseFor")} id="iv-target">
          <select id="iv-target" className="input" value={value} onChange={(e) => setTarget(e.target.value)}>
            <option value="general:">{t("interview.generalNoTarget")}</option>
            {top.length > 0 && (
              <optgroup label={t("interview.topRoles")}>
                {top.map((r) => (
                  <option key={r.role_id} value={`role:${r.role_id}`}>
                    {roleTitle(t, r.role_id, r.title)}
                  </option>
                ))}
              </optgroup>
            )}
            {openings.data && openings.data.length > 0 && (
              <optgroup label={t("interview.openings")}>
                {openings.data.map((o) => (
                  <option key={o.id} value={`opening:${o.id}`}>
                    {o.title} · {o.company}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        {err && <Alert tone="bad">{err}</Alert>}
        <button className="btn btn-primary btn-sm" onClick={start} disabled={busy || !value}>
          {busy ? <Spinner label={t("interview.preparing")} /> : (<><Play className="h-4 w-4" aria-hidden /> {t("interview.start")}</>)}
        </button>
      </div>
    </Section>
  );
}

function Practice({ session, onAnswered }: { session: InterviewSession; onAnswered: () => void }) {
  const t = useT();
  const [s, setS] = useState(session);
  const firstOpen = Math.max(0, s.questions.findIndex((q) => !q.answer));
  const [idx, setIdx] = useState(firstOpen);
  const q = s.questions[idx];
  const [text, setText] = useState(q?.answer?.answer ?? "");
  const [withAi, setWithAi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // on phones the practice panel sits below the session list: bring it into view when a session opens
    if (window.innerWidth < 1024) topRef.current?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    setText(s.questions[idx]?.answer?.answer ?? "");
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  if (!q) return <Alert tone="warn">{t("interview.noQuestions")}</Alert>;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ question_id: string; checks: AnswerChecks; ai: AiFeedback }>(`/api/interviews/${s.id}/answers`, {
        body: { question_id: q.id, answer: text, ai_feedback: withAi },
      });
      const answer: InterviewAnswer = { answer: text, checks: r.checks, ai: r.ai, at: new Date().toISOString() };
      const questions = s.questions.map((x) => (x.id === q.id ? { ...x, answer } : x));
      setS({ ...s, questions, answered: questions.filter((x) => x.answer).length });
      onAnswered();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div className="scroll-mt-20 space-y-4" data-testid="practice" ref={topRef}>
      <div className="card p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="eyebrow">{t("interview.questionOf", { n: idx + 1, total: s.questions.length })}</span>
          <span>· {targetTitle(t, s.target)}</span>
          {s.is_fixture && <FixtureBadge />}
          {s.questions_source === "template" && <Badge>{t("interview.templateQs")}</Badge>}
        </div>
        <EnglishNote className="mb-2" />
        <h2 className="text-xl leading-snug" data-testid="question">
          {q.question}
        </h2>
        {(q.why || q.based_on) && (
          <p className="mt-2 text-sm text-ink-2">
            {q.why}
            {q.based_on && (
              <span className="text-xs text-muted">
                {" "}
                · {t("interview.basedOn", { what: q.based_on.includes("/") ? t("interview.yourSection", { section: q.based_on.split("/")[0] }) : q.based_on })}
              </span>
            )}
          </p>
        )}
        <div className="mt-4">
          <label htmlFor="iv-answer" className="label flex justify-between">
            <span>{t("interview.yourAnswer")}</span>
            <span className="num font-normal text-muted">{t("interview.words", { count: words })}</span>
          </label>
          <textarea
            id="iv-answer"
            className="input min-h-40"
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("interview.placeholder")}
          />
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} /> {t("interview.alsoAi")}
        </label>
        {err && (
          <div className="mt-3">
            <Alert tone="bad">{err}</Alert>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <Spinner label={t("interview.checking")} /> : q.answer ? t("interview.recheck") : t("interview.getFeedback")}
          </button>
          <span className="ml-auto flex gap-1">
            <button className="btn btn-secondary btn-sm" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("common.previous")}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={idx >= s.questions.length - 1} onClick={() => setIdx(idx + 1)}>
              {t("common.next")} <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </span>
        </div>
      </div>
      {q.answer && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-live="polite">
          <ChecksBlock c={q.answer.checks} />
          <AiBlock ai={q.answer.ai} />
        </div>
      )}
    </div>
  );
}

/* The rule-based answer checks have fixed ids (backend/app/services/interview.py), so their names are
   translated here; the tips under them stay in English like the rest of the API's text. */
const CHECK_KEY: Record<string, MessageKey> = {
  situation: "interview.check.situation",
  action: "interview.check.action",
  result: "interview.check.result",
  measurable: "interview.check.measurable",
  length: "interview.check.length",
  ownership: "interview.check.ownership",
  evidence: "interview.check.evidence",
};

function ChecksBlock({ c }: { c: AnswerChecks }) {
  const t = useT();
  const passed = c.items.filter((i) => i.ok).length;
  return (
    <section className="card p-5" aria-labelledby="checks-h" data-testid="checks-block">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="checks-h" className="flex items-center gap-1.5 text-base">
          <ListChecks className="h-4 w-4 shrink-0 text-teal" aria-hidden /> {t("interview.checksTitle")}
        </h3>
        <Badge tone="teal">
          {t("interview.passed", { passed, total: c.items.length })}
        </Badge>
      </div>
      <ul className="space-y-2">
        {c.items.map((i) => (
          <li key={i.id} className="flex gap-2 text-sm">
            {i.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-label={t("interview.pass")} /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-label={t("interview.fail")} />}
            <span className="min-w-0">
              <span className="font-medium">{CHECK_KEY[i.id] ? t(CHECK_KEY[i.id]) : i.label.replace(/\*/g, "")}</span>
              {!i.ok && <span className="block text-xs text-ink-2">{i.tip}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        {t("interview.words", { count: c.words })}
        {c.skills_mentioned.length ? ` · ${t("interview.skillsMentioned", { list: c.skills_mentioned.join(", ") })}` : ""}. {t("interview.fixedRules")}
      </p>
    </section>
  );
}

function AiBlock({ ai }: { ai: AiFeedback }) {
  const t = useT();
  if (ai.status === "skipped")
    return (
      <section className="rounded-lg border border-dashed border-line p-5 text-sm text-muted" data-testid="ai-block">
        {t("interview.aiSkipped")}
      </section>
    );
  if (ai.status === "unavailable")
    return (
      <section className="rounded-lg border border-ai-line bg-ai-soft p-5" aria-labelledby="ai-h" data-testid="ai-block">
        <h3 id="ai-h" className="flex items-center gap-1.5 text-base text-ai">
          <Sparkles className="h-4 w-4" aria-hidden /> {t("interview.aiUnavailable")}
        </h3>
        <p className="mt-2 text-sm text-ink-2">{ai.message}</p>
        {ai.code === "ai_consent_required" ? (
          <Link href="/settings#privacy" className="btn btn-ai btn-sm mt-3">
            {t("interview.reviewConsent")}
          </Link>
        ) : (
          <p className="mt-2 text-xs text-muted">{t("interview.checksWithoutAi")}</p>
        )}
      </section>
    );
  return (
    <section className="rounded-lg border border-ai-line bg-ai-soft p-5" aria-labelledby="ai-h" data-testid="ai-block">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="ai-h" className="flex items-center gap-1.5 text-base text-ai">
          <Sparkles className="h-4 w-4" aria-hidden /> {t("interview.aiCoaching")}
        </h3>
        {ai.is_fixture ? <FixtureBadge /> : <AIBadge>{t("interview.aiCoaching")}</AIBadge>}
      </div>
      {ai.strengths.length > 0 && (
        <>
          <p className="label !text-ai">{t("interview.whatWorks")}</p>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {ai.strengths.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {ai.improvements.length > 0 && (
        <>
          <p className="label !text-ai">{t("interview.stronger")}</p>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {ai.improvements.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {ai.follow_up && (
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ai">{t("interview.followUp")}</span> {ai.follow_up}
        </p>
      )}
      <p className="mt-3 text-xs text-muted">{t("interview.suggestionsOnly")}</p>
    </section>
  );
}
