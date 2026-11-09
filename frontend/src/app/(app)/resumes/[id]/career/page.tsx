"use client";

import { BookOpen, Briefcase, FileSignature, Lightbulb, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { WithPlaceholders } from "@/components/preview";
import { AIBadge, Alert, Badge, Empty, EnglishNote, ErrorState, Field, FixtureBadge, LoadingBlock, Section, Spinner } from "@/components/ui";
import { api, ApiError, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { CareerArtifact, JD, ResourceLookup, Role, Roadmap, SkillGap } from "@/lib/types";
import { useResume } from "../context";

const STATE_TONE = { demonstrated: "ok", listed_only: "warn", gap: "bad" } as const;
const STATE_KEY: Record<string, MessageKey> = {
  demonstrated: "career.state.demonstrated",
  listed_only: "career.state.listed_only",
  gap: "career.state.gap",
};
const PHASE_KEY: Record<string, MessageKey> = { now: "career.phase.now", next: "career.phase.next", later: "career.phase.later" };

export default function CareerPage() {
  const t = useT();
  const { versionId, resume } = useResume();
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const jds = useApi<JD[]>("/api/job-descriptions");
  const [selected, setSelected] = useState<string[]>(resume.target_role ? [resume.target_role] : []);
  const qs = selected.map((r) => `roles=${encodeURIComponent(r)}`).join("&");
  const gap = useApi<{ roles: SkillGap[] }>(versionId ? `/api/versions/${versionId}/skill-gap${qs ? `?${qs}` : ""}` : null, [qs]);
  const road = useApi<Roadmap>(versionId ? `/api/career/roadmap/${versionId}${qs ? `?${qs}` : ""}` : null, [qs]);
  const listings = useApi<ResourceLookup>("/api/career/job-listings");

  if (!versionId) return <Empty title={t("resume.confirmFirst")} />;

  return (
    <div className="space-y-6">
      <EnglishNote />
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <p className="text-sm font-medium">{t("career.rolesToPlan")}</p>
        {roles.data?.roles.map((r) => (
          <button
            key={r.id}
            aria-pressed={selected.includes(r.id)}
            onClick={() => setSelected((s) => (s.includes(r.id) ? s.filter((x) => x !== r.id) : [...s, r.id].slice(-3)))}
            className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs aria-pressed:border-teal aria-pressed:bg-teal-soft aria-pressed:text-teal"
          >
            <span lang="en">{r.title}</span>
          </button>
        ))}
        <p className="w-full text-xs text-muted">{t("career.pickUpTo")}</p>
      </div>

      <Section title={t("career.skillGap")} id="gap">
        {gap.error ? (
          <ErrorState message={gap.error} onRetry={gap.reload} />
        ) : !gap.data ? (
          <LoadingBlock />
        ) : gap.data.roles.length === 0 ? (
          <p className="text-sm text-muted">{t("career.noRoles")}</p>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {gap.data.roles.map((g) => (
              <div key={g.role_id} className="rounded-lg border border-line p-4">
                <h3 className="text-lg" lang="en">{g.title}</h3>
                <p className="mb-3 text-xs text-muted">
                  {t("career.summary", { demonstrated: g.summary.demonstrated, listed: g.summary.listed_only, gaps: g.summary.gap })}
                </p>
                <ul className="space-y-1.5">
                  {g.skills.map((s) => (
                    <li key={s.skill} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        {s.skill} <span className="text-[11px] text-muted">{s.importance === "required" ? t("career.core") : t("career.preferred")}</span>
                        {s.related_evidence.length > 0 && <span className="block text-[11px] text-info">{t("career.related", { list: s.related_evidence.join(", ") })}</span>}
                      </span>
                      <Badge tone={STATE_TONE[s.state]} className="shrink-0">{STATE_KEY[s.state] ? t(STATE_KEY[s.state]) : s.state.replace("_", " ")}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t("career.roadmap")} id="road">
          {road.error ? (
            <ErrorState message={road.error} onRetry={road.reload} />
          ) : !road.data ? (
            <LoadingBlock />
          ) : road.data.status === "insufficient_evidence" ? (
            <Alert tone="warn">{road.data.message}</Alert>
          ) : road.data.steps.length === 0 ? (
            <p className="text-sm text-ok">{t("career.noGaps")}</p>
          ) : (
            <ol className="space-y-3">
              {road.data.steps.map((s) => (
                <li key={s.skill} className="border-l-2 border-teal pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={s.phase === "now" ? "teal" : s.phase === "next" ? "info" : "neutral"}>{PHASE_KEY[s.phase] ? t(PHASE_KEY[s.phase]) : s.phase}</Badge>
                    <span className="font-medium">{s.skill}</span>
                    <span className="text-xs text-muted">{t("career.forRole", { role: s.for_role })}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink-2">{s.action}</p>
                  <Resources r={s.resources} />
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section title={t("career.projects")} id="proj">
          {!road.data?.portfolio_projects?.length ? (
            <p className="text-sm text-muted">{t("career.projectsEmpty")}</p>
          ) : (
            <ul className="space-y-4">
              {road.data.portfolio_projects.map((p) => (
                <li key={p.title} className="rounded-lg border border-line p-3">
                  <p className="flex items-center gap-2 font-medium">
                    <Lightbulb className="h-4 w-4 text-ai" aria-hidden /> <span lang="en">{p.title}</span>
                  </p>
                  <p className="mt-1 text-sm text-ink-2">{p.brief}</p>
                  <p className="mt-1 text-xs text-muted">
                    <strong>{t("career.evidenceToShow")}</strong> {p.evidence}
                  </p>
                  {p.builds_evidence_for.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.builds_evidence_for.map((s) => (
                        <Badge key={s} tone="teal">{s}</Badge>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">{t("career.projectsNote")}</p>
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <InterviewQuestions versionId={versionId} jds={jds.data ?? []} />
        <CoverLetter versionId={versionId} jds={jds.data ?? []} roles={roles.data?.roles ?? []} />
      </div>

      <Section title={t("career.listings")} id="listings">
        {listings.data?.status === "unavailable" ? (
          <div className="flex items-start gap-3 text-sm text-ink-2">
            <Briefcase className="mt-0.5 h-5 w-5 text-muted" aria-hidden />
            <p>
              {listings.data.message}{" "}
              {t.rich("career.trackIn", {
                link: (c) => (
                  <a className="text-teal underline" href="/applications">
                    {c}
                  </a>
                ),
              })}
            </p>
          </div>
        ) : listings.error ? (
          <ErrorState message={listings.error} onRetry={listings.reload} />
        ) : (
          <LoadingBlock />
        )}
      </Section>
    </div>
  );
}

function Resources({ r }: { r: ResourceLookup }) {
  const t = useT();
  if (r.status === "unavailable")
    return (
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
        <BookOpen className="h-3 w-3" aria-hidden /> {t("career.resUnavailable")}
      </p>
    );
  if (!r.resources?.length) return <p className="mt-1 text-[11px] text-muted">{t("career.noResources")}</p>;
  return (
    <ul className="mt-1 space-y-0.5">
      {r.resources.map((x) => (
        <li key={x.url} className="text-xs">
          <a href={x.url} target="_blank" rel="noopener noreferrer" className="text-teal underline">
            <span lang="en">{x.title}</span>
          </a>{" "}
          <span className="text-muted">
            · {x.source} · {t("career.retrieved", { date: x.retrieved_on })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function useGenerate(path: string) {
  const [data, setData] = useState<CareerArtifact | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(body: object) {
    setBusy(true);
    setError(null);
    try {
      setData(await api<CareerArtifact>(path, { body }));
    } catch (e) {
      setError({ code: e instanceof ApiError ? e.code : "error", message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }
  return { data, error, busy, run };
}

function InterviewQuestions({ versionId, jds }: { versionId: string; jds: JD[] }) {
  const t = useT();
  const g = useGenerate("/api/career/interview-questions");
  const [jd, setJd] = useState("");
  const qs = (g.data?.content.questions ?? []) as { question: string; why: string; based_on: string }[];
  return (
    <Section title={t("career.iq")} id="iq" aside={<MessagesSquare className="h-5 w-5 text-muted" aria-hidden />}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("career.jdOptional")} id="iq-jd">
          <select id="iq-jd" className="input" value={jd} onChange={(e) => setJd(e.target.value)}>
            <option value="">{t("career.noneResumeOnly")}</option>
            {jds.map((j) => (
              <option key={j.id} value={j.id} lang="en">
                {j.title}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn btn-ai" disabled={g.busy} onClick={() => g.run({ version_id: versionId, jd_id: jd || null })}>
          {g.busy ? <Spinner label={t("career.generating")} /> : t("career.generateQs")}
        </button>
      </div>
      <div aria-live="polite" className="mt-4 space-y-3">
        {g.error && <Alert tone="bad">{g.error.message}</Alert>}
        {g.data && (
          <>
            <div className="flex flex-wrap gap-2">
              <AIBadge>{t("career.aiQs")}</AIBadge>
              <FixtureBadge show={g.data.is_fixture} />
              {g.data.provider === "template" && <Badge>{t("career.templateBased")}</Badge>}
            </div>
            {g.data.content.note && <Alert tone="warn">{g.data.content.note}</Alert>}
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {qs.map((q, i) => (
                <li key={i}>
                  <p>{q.question}</p>
                  <p className="text-xs text-muted">{q.why}</p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Section>
  );
}

function CoverLetter({ versionId, jds, roles }: { versionId: string; jds: JD[]; roles: Role[] }) {
  const t = useT();
  const g = useGenerate("/api/career/cover-letter");
  const [target, setTarget] = useState("");
  const c = g.data?.content;
  return (
    <Section title={t("career.cl")} id="cl" aside={<FileSignature className="h-5 w-5 text-muted" aria-hidden />}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("career.writeFor")} id="cl-target">
          <select id="cl-target" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t("career.general")}</option>
            <optgroup label={t("career.jds")}>
              {jds.map((j) => (
                <option key={j.id} value={`jd:${j.id}`} lang="en">
                  {j.title}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("career.roles")}>
              {roles.map((r) => (
                <option key={r.id} value={`role:${r.id}`} lang="en">
                  {r.title}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <button
          className="btn btn-ai"
          disabled={g.busy}
          onClick={() => {
            const [k, id] = target.split(":");
            g.run({ version_id: versionId, jd_id: k === "jd" ? id : null, role_id: k === "role" ? id : null });
          }}
        >
          {g.busy ? <Spinner label={t("career.writing")} /> : t("career.draftCl")}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">{t("career.clNote")}</p>
      <div aria-live="polite" className="mt-4 space-y-3">
        {g.error && (
          <Alert tone={g.error.code === "ai_consent_required" ? "warn" : "bad"}>
            {g.error.message} {g.error.code === "ai_consent_required" && <a href="/settings#privacy">{t("career.openPrivacy")}</a>}
          </Alert>
        )}
        {c?.paragraphs && (
          <>
            <div className="flex flex-wrap gap-2">
              <AIBadge>{t("career.aiDraft")}</AIBadge>
              <FixtureBadge show={g.data!.is_fixture} />
              {c.status === "grounded" ? <Badge tone="ok">{t("career.grounded")}</Badge> : <Badge tone="warn">{t("career.needsReview")}</Badge>}
            </div>
            {c.grounding && c.grounding.unsupported.length > 0 && (
              <Alert tone="warn" title={t("career.notFound")}>
                {c.grounding.unsupported.map((u) => `“${u.value}” (${u.type})`).join(", ")}. {t("career.removeThese")}
              </Alert>
            )}
            <div className="ai-surface space-y-3 p-4 text-sm leading-relaxed">
              {c.paragraphs.map((p, i) => (
                <p key={i}>
                  <WithPlaceholders text={p} />
                </p>
              ))}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(c.paragraphs!.join("\n\n"))}>
              {t("career.copyText")}
            </button>
          </>
        )}
      </div>
    </Section>
  );
}
