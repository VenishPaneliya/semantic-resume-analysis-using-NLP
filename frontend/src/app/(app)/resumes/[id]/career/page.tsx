"use client";

import { BookOpen, Briefcase, FileSignature, Lightbulb, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { WithPlaceholders } from "@/components/preview";
import { AIBadge, Alert, Badge, Empty, ErrorState, Field, FixtureBadge, LoadingBlock, Section, Spinner } from "@/components/ui";
import { api, ApiError, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { CareerArtifact, JD, ResourceLookup, Role, Roadmap, SkillGap } from "@/lib/types";
import { useResume } from "../context";

const STATE_TONE = { demonstrated: "ok", listed_only: "warn", gap: "bad" } as const;

export default function CareerPage() {
  const { versionId, resume } = useResume();
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const jds = useApi<JD[]>("/api/job-descriptions");
  const [selected, setSelected] = useState<string[]>(resume.target_role ? [resume.target_role] : []);
  const qs = selected.map((r) => `roles=${encodeURIComponent(r)}`).join("&");
  const gap = useApi<{ roles: SkillGap[] }>(versionId ? `/api/versions/${versionId}/skill-gap${qs ? `?${qs}` : ""}` : null, [qs]);
  const road = useApi<Roadmap>(versionId ? `/api/career/roadmap/${versionId}${qs ? `?${qs}` : ""}` : null, [qs]);
  const listings = useApi<ResourceLookup>("/api/career/job-listings");

  if (!versionId) return <Empty title="Confirm the extraction first" />;

  return (
    <div className="space-y-6">
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <p className="text-sm font-medium">Roles to plan for:</p>
        {roles.data?.roles.map((r) => (
          <button
            key={r.id}
            aria-pressed={selected.includes(r.id)}
            onClick={() => setSelected((s) => (s.includes(r.id) ? s.filter((x) => x !== r.id) : [...s, r.id].slice(-3)))}
            className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs aria-pressed:border-teal aria-pressed:bg-teal-soft aria-pressed:text-teal"
          >
            {r.title}
          </button>
        ))}
        <p className="w-full text-xs text-muted">Pick up to 3. With none selected we use your target roles from Settings, or the top recommendation.</p>
      </div>

      <Section title="Skill gap dashboard" id="gap">
        {gap.error ? (
          <ErrorState message={gap.error} onRetry={gap.reload} />
        ) : !gap.data ? (
          <LoadingBlock />
        ) : gap.data.roles.length === 0 ? (
          <p className="text-sm text-muted">No roles to compare yet — select one above.</p>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {gap.data.roles.map((g) => (
              <div key={g.role_id} className="rounded-lg border border-line p-4">
                <h3 className="text-lg">{g.title}</h3>
                <p className="mb-3 text-xs text-muted">
                  {g.summary.demonstrated} demonstrated · {g.summary.listed_only} listed only · {g.summary.gap} gaps
                </p>
                <ul className="space-y-1.5">
                  {g.skills.map((s) => (
                    <li key={s.skill} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {s.skill} <span className="text-[11px] text-muted">{s.importance === "required" ? "core" : "preferred"}</span>
                        {s.related_evidence.length > 0 && <span className="block text-[11px] text-info">related: {s.related_evidence.join(", ")}</span>}
                      </span>
                      <Badge tone={STATE_TONE[s.state]}>{s.state.replace("_", " ")}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Learning roadmap" id="road">
          {road.error ? (
            <ErrorState message={road.error} onRetry={road.reload} />
          ) : !road.data ? (
            <LoadingBlock />
          ) : road.data.status === "insufficient_evidence" ? (
            <Alert tone="warn">{road.data.message}</Alert>
          ) : road.data.steps.length === 0 ? (
            <p className="text-sm text-ok">No gaps for these roles. Focus on stronger evidence in your bullets.</p>
          ) : (
            <ol className="space-y-3">
              {road.data.steps.map((s) => (
                <li key={s.skill} className="border-l-2 border-teal pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={s.phase === "now" ? "teal" : s.phase === "next" ? "info" : "neutral"}>{s.phase}</Badge>
                    <span className="font-medium">{s.skill}</span>
                    <span className="text-xs text-muted">for {s.for_role}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink-2">{s.action}</p>
                  <Resources r={s.resources} />
                </li>
              ))}
            </ol>
          )}
        </Section>
        <Section title="Portfolio project ideas" id="proj">
          {!road.data?.portfolio_projects?.length ? (
            <p className="text-sm text-muted">Ideas appear once there are gaps to build evidence for.</p>
          ) : (
            <ul className="space-y-4">
              {road.data.portfolio_projects.map((p) => (
                <li key={p.title} className="rounded-lg border border-line p-3">
                  <p className="flex items-center gap-2 font-medium">
                    <Lightbulb className="h-4 w-4 text-ai" aria-hidden /> {p.title}
                  </p>
                  <p className="mt-1 text-sm text-ink-2">{p.brief}</p>
                  <p className="mt-1 text-xs text-muted">
                    <strong>Evidence to show:</strong> {p.evidence}
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
          <p className="mt-3 text-xs text-muted">Suggestions for building real evidence — never something to claim before you have done it.</p>
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <InterviewQuestions versionId={versionId} jds={jds.data ?? []} />
        <CoverLetter versionId={versionId} jds={jds.data ?? []} roles={roles.data?.roles ?? []} />
      </div>

      <Section title="Job listings" id="listings">
        {listings.data?.status === "unavailable" ? (
          <div className="flex items-start gap-3 text-sm text-ink-2">
            <Briefcase className="mt-0.5 h-5 w-5 text-muted" aria-hidden />
            <p>{listings.data.message} Track roles you find yourself in <a className="text-teal underline" href="/applications">Applications</a>.</p>
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
  if (r.status === "unavailable")
    return (
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
        <BookOpen className="h-3 w-3" aria-hidden /> Learning resources unavailable — no provider configured.
      </p>
    );
  if (!r.resources?.length) return <p className="mt-1 text-[11px] text-muted">No verified resources for this skill yet.</p>;
  return (
    <ul className="mt-1 space-y-0.5">
      {r.resources.map((x) => (
        <li key={x.url} className="text-xs">
          <a href={x.url} target="_blank" rel="noopener noreferrer" className="text-teal underline">
            {x.title}
          </a>{" "}
          <span className="text-muted">
            · {x.source} · retrieved {x.retrieved_on}
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
  const g = useGenerate("/api/career/interview-questions");
  const [jd, setJd] = useState("");
  const qs = (g.data?.content.questions ?? []) as { question: string; why: string; based_on: string }[];
  return (
    <Section title="Interview practice" id="iq" aside={<MessagesSquare className="h-5 w-5 text-muted" aria-hidden />}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Job description (optional)" id="iq-jd">
          <select id="iq-jd" className="input" value={jd} onChange={(e) => setJd(e.target.value)}>
            <option value="">None — use resume only</option>
            {jds.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn btn-ai" disabled={g.busy} onClick={() => g.run({ version_id: versionId, jd_id: jd || null })}>
          {g.busy ? <Spinner label="Generating" /> : "Generate questions"}
        </button>
      </div>
      <div aria-live="polite" className="mt-4 space-y-3">
        {g.error && <Alert tone="bad">{g.error.message}</Alert>}
        {g.data && (
          <>
            <div className="flex flex-wrap gap-2">
              <AIBadge>AI-generated practice questions</AIBadge>
              <FixtureBadge show={g.data.is_fixture} />
              {g.data.provider === "template" && <Badge>Template-based</Badge>}
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
  const g = useGenerate("/api/career/cover-letter");
  const [target, setTarget] = useState("");
  const c = g.data?.content;
  return (
    <Section title="Cover letter" id="cl" aside={<FileSignature className="h-5 w-5 text-muted" aria-hidden />}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Write for" id="cl-target">
          <select id="cl-target" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">General</option>
            <optgroup label="Job descriptions">
              {jds.map((j) => (
                <option key={j.id} value={`jd:${j.id}`}>
                  {j.title}
                </option>
              ))}
            </optgroup>
            <optgroup label="Roles">
              {roles.map((r) => (
                <option key={r.id} value={`role:${r.id}`}>
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
          {g.busy ? <Spinner label="Writing" /> : "Draft cover letter"}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">Written only from your confirmed resume. Anything unknown is left as a placeholder for you to fill in.</p>
      <div aria-live="polite" className="mt-4 space-y-3">
        {g.error && (
          <Alert tone={g.error.code === "ai_consent_required" ? "warn" : "bad"}>
            {g.error.message} {g.error.code === "ai_consent_required" && <a href="/settings#privacy">Open privacy settings</a>}
          </Alert>
        )}
        {c?.paragraphs && (
          <>
            <div className="flex flex-wrap gap-2">
              <AIBadge>AI draft — review before use</AIBadge>
              <FixtureBadge show={g.data!.is_fixture} />
              {c.status === "grounded" ? <Badge tone="ok">All claims found in your resume</Badge> : <Badge tone="warn">Needs review</Badge>}
            </div>
            {c.grounding && c.grounding.unsupported.length > 0 && (
              <Alert tone="warn" title="Not found in your confirmed resume">
                {c.grounding.unsupported.map((u) => `“${u.value}” (${u.type})`).join(", ")}. Remove these or make sure they are true.
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
              Copy text
            </button>
          </>
        )}
      </div>
    </Section>
  );
}
