"use client";

import { ChevronDown, Quote } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Bar, Empty, ErrorState, LoadingBlock, pct, ScoreDial, Section } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { AnalysisResult, Category, Role, Rubric } from "@/lib/types";
import { useResume } from "../context";

const PRIORITY_TONE = { high: "bad", medium: "warn", low: "neutral" } as const;

export default function AnalysisPage() {
  const { versionId } = useResume();
  const [role, setRole] = useState("");
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const rubric = useApi<Rubric>("/api/rubric");
  const a = useApi<AnalysisResult>(versionId ? `/api/versions/${versionId}/analysis${role ? `?target_role=${role}` : ""}` : null);

  if (!versionId) return <Empty title="Confirm the extraction first">Analysis runs on your confirmed content.</Empty>;
  if (a.error) return <ErrorState message={a.error} onRetry={a.reload} />;
  if (!a.data) return <LoadingBlock label="Analysing your resume…" />;
  const r = a.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="card rise flex flex-col items-center gap-3 p-6 text-center">
          <p className="eyebrow">Overall indicator</p>
          <ScoreDial value={r.overall} size={132} label="of 100" />
          <p className="text-xs text-muted">{r.overall_label}. Weighted average of categories with enough data.</p>
          <div className="mt-2 grid w-full grid-cols-3 gap-2 text-center">
            <Stat k="Bullets" v={r.stats.bullets} />
            <Stat k="Roles" v={r.stats.experience_entries} />
            <Stat k="Yrs exp." v={r.timeline.professional_years} />
          </div>
        </div>
        <div className="card rise rise-1 p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl">Category scores</h2>
            <span className="text-xs text-muted num">
              {r.rubric_version} · {r.cached ? "cached" : "fresh"} result
            </span>
          </div>
          <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {r.categories.map((c) => (
              <li key={c.id}>
                <div className="flex items-baseline justify-between text-sm">
                  <a href={`#cat-${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </a>
                  <span className="num text-xs text-muted">
                    {c.status === "scored" ? `${c.score}/100` : c.status === "insufficient_data" ? "insufficient data" : "n/a"} · w{c.weight}
                  </span>
                </div>
                <div className="mt-1">
                  <Bar value={c.score ?? 0} max={100} tone={c.status === "scored" ? "teal" : "muted"} label={`${c.name} score`} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {r.not_extracted.length > 0 && (
        <Alert tone="warn" title="Could not reliably extract">
          <ul className="list-disc pl-4">
            {r.not_extracted.map((n) => (
              <li key={n.section}>{n.message}</li>
            ))}
          </ul>
          These are not counted as missing.
        </Alert>
      )}

      <Section title="Prioritised improvements" id="improvements" aside={<span className="text-xs text-muted">{r.improvements.length} items</span>}>
        {r.improvements.length === 0 ? (
          <p className="text-sm text-ink-2">No deductions. Nice work — consider tailoring for a specific role next.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Improvements ordered by priority and effort</caption>
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th scope="col" className="px-3 py-2">Priority</th>
                  <th scope="col" className="px-3 py-2">Issue & why it matters</th>
                  <th scope="col" className="px-3 py-2">Evidence</th>
                  <th scope="col" className="px-3 py-2">Suggested improvement</th>
                  <th scope="col" className="px-3 py-2">Effort</th>
                </tr>
              </thead>
              <tbody>
                {r.improvements.map((i, idx) => (
                  <tr key={idx} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-3">
                      <Badge tone={PRIORITY_TONE[i.priority]}>{i.priority}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium">{i.issue}</p>
                      <p className="mt-1 text-xs text-ink-2">{i.why}</p>
                      <p className="mt-1 text-[11px] text-muted">{i.category}</p>
                    </td>
                    <td className="max-w-[240px] px-3 py-3">
                      {i.evidence.length ? (
                        i.evidence.map((e, k) => (
                          <p key={k} className="mb-1 text-xs italic text-ink-2">
                            “{e.text}”
                          </p>
                        ))
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-ink-2">{i.suggestion}</td>
                    <td className="px-3 py-3">
                      <Badge>{i.effort}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Role keyword coverage"
        id="kw"
        aside={
          <div className="flex items-center gap-2">
            <label htmlFor="role" className="text-sm text-ink-2">
              Target role
            </label>
            <select id="role" className="input w-auto" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">None</option>
              {roles.data?.roles.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {!r.role_keyword_coverage ? (
          <p className="text-sm text-ink-2">Choose a target role to see which of its core and preferred skills appear in your resume.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">
              Core skills present: <strong className="num">{pct(r.role_keyword_coverage.required_coverage)}</strong> · Preferred:{" "}
              <strong className="num">{pct(r.role_keyword_coverage.preferred_coverage)}</strong>
            </p>
            {(["required", "preferred"] as const).map((k) => (
              <div key={k}>
                <p className="label">{k === "required" ? "Core" : "Preferred"}</p>
                <div className="flex flex-wrap gap-1.5">
                  {r.role_keyword_coverage![k].map((s) => (
                    <Badge key={s.skill} tone={s.status === "demonstrated" ? "ok" : s.status === "listed_only" ? "warn" : "neutral"}>
                      {s.skill} · {s.status.replace("_", " ")}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
            <Alert tone="info">{r.role_keyword_coverage.note}</Alert>
          </div>
        )}
      </Section>

      <div className="space-y-3">
        <h2 className="text-xl">Category details</h2>
        {r.categories.map((c) => (
          <CategoryCard key={c.id} c={c} />
        ))}
      </div>

      <details className="card p-5">
        <summary className="cursor-pointer text-lg font-display">Published rubric {rubric.data && <span className="num text-xs text-muted">({rubric.data.version})</span>}</summary>
        {rubric.error && <ErrorState message={rubric.error} onRetry={rubric.reload} />}
        {rubric.data && (
          <div className="mt-4 space-y-3 text-sm">
            <Alert tone="info">{rubric.data.disclaimer}</Alert>
            <p className="text-ink-2">{rubric.data.scoring}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-muted">
                  <tr className="border-b border-line">
                    <th className="py-2 pr-3">Rule</th>
                    <th className="py-2 pr-3">Category</th>
                    <th className="py-2 pr-3">Max points</th>
                    <th className="py-2">Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {rubric.data.rules.map((x) => (
                    <tr key={x.id} className="border-b border-line align-top">
                      <td className="num py-2 pr-3">{x.id}</td>
                      <td className="py-2 pr-3">{x.category}</td>
                      <td className="num py-2 pr-3">{x.max_points}</td>
                      <td className="py-2 text-ink-2">{x.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: number | undefined }) {
  return (
    <div className="rounded-md border border-line bg-paper px-1 py-2">
      <p className="num text-sm font-semibold">{v ?? "—"}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted">{k}</p>
    </div>
  );
}

function CategoryCard({ c }: { c: Category }) {
  const [open, setOpen] = useState(c.findings.length > 0 && (c.score ?? 100) < 70);
  return (
    <section id={`cat-${c.id}`} className="card">
      <button className="flex w-full items-center gap-4 p-4 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ScoreDial value={c.score} size={56} />
        <div className="flex-1">
          <h3 className="text-base">{c.name}</h3>
          <p className="text-xs text-muted">
            Weight {c.weight}% · {c.status === "scored" ? `${c.findings.length} finding${c.findings.length === 1 ? "" : "s"}` : c.status === "insufficient_data" ? "Insufficient data — excluded from overall" : "Not applicable"}
          </p>
        </div>
        <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="border-t border-line px-4 pb-4 pt-3">
          {c.notes.map((n) => (
            <p key={n} className="mb-2 text-sm text-ink-2">
              {n}
            </p>
          ))}
          {c.findings.length === 0 && <p className="text-sm text-ok">No deductions in this category.</p>}
          <ul className="space-y-3">
            {c.findings.map((f, i) => (
              <li key={i} className="rounded-md border border-line bg-paper/60 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{f.message}</p>
                  <span className="num text-xs text-bad">{f.points > 0 ? `−${f.points}` : "info"}</span>
                </div>
                <p className="mt-1 text-xs text-ink-2">
                  <strong>Why:</strong> {f.why} <strong>Fix:</strong> {f.suggestion}
                </p>
                {f.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {f.evidence.map((e, k) => (
                      <li key={k} className="flex gap-1.5 text-xs italic text-ink-2">
                        <Quote className="mt-0.5 h-3 w-3 shrink-0 not-italic text-muted" aria-hidden />
                        {e.text}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
