"use client";

import { ChevronDown, Compass, Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/components/shell";
import { Alert, Badge, Bar, Empty, ErrorState, LoadingBlock, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Recommendation, Recommendations, Role } from "@/lib/types";
import { useResume } from "../context";

const DOMAINS = ["ai", "data", "analytics", "software", "web", "infrastructure", "quality", "mobile", "business"];

export default function RolesPage() {
  const { versionId } = useResume();
  const { user } = useUser();
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const [prefs, setPrefs] = useState({
    target_roles: user.career_prefs.target_roles ?? [],
    domains: user.career_prefs.domains ?? [],
  });
  const [data, setData] = useState<Recommendations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!versionId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<Recommendations>(`/api/versions/${versionId}/recommendations`, { body: prefs }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [versionId, prefs]);

  useEffect(() => {
    void load();
    // run once on mount; preference changes apply via the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  if (!versionId) return <Empty title="Confirm the extraction first" />;

  const toggle = (k: "target_roles" | "domains", v: string) =>
    setPrefs((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-5">
        {error && <ErrorState message={error} onRetry={load} />}
        {!data && !error && <LoadingBlock label="Ranking roles…" />}
        {data && (
          <>
            <Alert tone="info" title="Relative fit, not hiring probability">
              {data.disclaimer}
            </Alert>
            {data.status === "insufficient_evidence" ? (
              <div className="card p-6">
                <div className="flex items-start gap-3">
                  <Compass className="mt-1 h-6 w-6 text-warn" aria-hidden />
                  <div>
                    <h2 className="text-xl">Not enough evidence yet</h2>
                    <p className="mt-1 text-sm text-ink-2">{data.message}</p>
                    {data.tentative && data.tentative.length > 0 && (
                      <p className="mt-3 text-xs text-muted">
                        Very tentative, low-confidence directions: {data.tentative.map((t) => t.title).join(", ")}. Add more detail before relying on
                        them.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <ol className="space-y-4">
                {data.recommendations.map((r, i) => (
                  <RecCard key={r.role_id} r={r} open={i === 0} />
                ))}
              </ol>
            )}
            <p className="text-xs text-muted num">
              {data.recommender_version} · embeddings: {data.embedding_model} · taxonomy {data.taxonomy_version}
            </p>
          </>
        )}
      </div>

      <aside className="space-y-5">
        {data && (
          <Section title="Seniority estimate" id="sen">
            <p className="text-2xl font-display">{data.seniority.label}</p>
            <p className="mt-1 text-sm text-ink-2">
              Plausible range: <strong>{data.seniority.plausible_range.join(" – ")}</strong> · uncertainty{" "}
              <Badge tone={data.seniority.uncertainty === "low" ? "ok" : data.seniority.uncertainty === "medium" ? "info" : "warn"}>{data.seniority.uncertainty}</Badge>
            </p>
            <p className="mt-2 num text-xs text-muted">
              ≈{data.seniority.effective_years} effective years (range {data.seniority.years_range[0]}–{data.seniority.years_range[1]})
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-ink-2">
              {data.seniority.basis.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">{data.seniority.note}</p>
          </Section>
        )}
        <Section title="Preferences" id="prefs">
          <fieldset>
            <legend className="label">Target roles</legend>
            <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {roles.data?.roles.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={prefs.target_roles.includes(r.id)} onChange={() => toggle("target_roles", r.id)} />
                  {r.title}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-4">
            <legend className="label">Preferred domains</legend>
            <div className="flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={prefs.domains.includes(d)}
                  onClick={() => toggle("domains", d)}
                  className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs aria-pressed:border-teal aria-pressed:bg-teal-soft aria-pressed:text-teal"
                >
                  {d}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="mt-3 flex gap-1.5 text-xs text-muted">
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden /> Preferences change the ordering by a small, shown adjustment. They never change the fit score.
            Locations and work arrangements are saved in Settings.
          </p>
          <button className="btn btn-primary btn-sm mt-3" onClick={load} disabled={loading}>
            {loading ? <Spinner label="Updating" /> : "Apply preferences"}
          </button>
          {data?.preference_note && <p className="mt-2 text-xs text-muted">{data.preference_note}</p>}
        </Section>
      </aside>
    </div>
  );
}

function RecCard({ r, open: initial }: { r: Recommendation; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const conf = { high: "ok", medium: "info", low: "warn" } as const;
  return (
    <li className="card rise">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4 sm:w-44">
          <span className="num text-xs text-muted">#{r.rank}</span>
          <div>
            <p className="num text-3xl font-semibold leading-none">{Math.round(r.fit_score)}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted">relative fit</p>
          </div>
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl">{r.title}</h2>
            <Badge tone={conf[r.confidence]}>{r.confidence} confidence</Badge>
            {r.preference_adjustment > 0 && <Badge tone="teal">+{r.preference_adjustment} preference</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-2">{r.description}</p>
        </div>
        <button className="btn btn-secondary btn-sm self-start sm:self-center" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Details <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </div>
      {open && (
        <div className="grid gap-5 border-t border-line p-5 md:grid-cols-2">
          <div>
            <h3 className="label">Why</h3>
            <ul className="list-disc space-y-1 pl-4 text-sm">
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
              {r.preference_reasons.map((x) => (
                <li key={x} className="text-teal">
                  {x}
                </li>
              ))}
            </ul>
            <h3 className="label mt-4">Score components</h3>
            <dl className="space-y-2 text-xs">
              {[
                ["Core skills (40%)", r.components.required_coverage],
                ["Preferred skills (20%)", r.components.preferred_coverage],
                ["Text similarity (25%)", r.components.semantic],
                ["Title signal (15%)", r.components.title_signal],
              ].map(([k, v]) => (
                <div key={k as string}>
                  <div className="flex justify-between">
                    <dt>{k}</dt>
                    <dd className="num">{Math.round((v as number) * 100)}%</dd>
                  </div>
                  <Bar value={v as number} label={k as string} />
                </div>
              ))}
            </dl>
          </div>
          <div className="space-y-4">
            <SkillList title="Demonstrated" tone="ok" items={r.matched_skills.map((m) => ({ k: m.skill, hint: m.evidence[0]?.text }))} />
            <SkillList title="Listed but not shown in work" tone="warn" items={r.weak_skills.map((w) => ({ k: w.skill, hint: w.reason }))} />
            <SkillList
              title="You may have these — add only if true"
              tone="info"
              items={r.possibly_unlisted.map((p) => ({ k: p.skill, hint: `Related to ${p.because_you_have.join(", ")}` }))}
            />
            <SkillList title="Missing core skills" tone="bad" items={r.missing_required.map((k) => ({ k }))} />
            <div>
              <h3 className="label">Next steps</h3>
              <ul className="list-decimal space-y-1 pl-4 text-sm">
                {r.next_steps.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function SkillList({ title, items, tone }: { title: string; items: { k: string; hint?: string }[]; tone: "ok" | "warn" | "bad" | "info" }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="label">{title}</h3>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i.k} title={i.hint}>
            <Badge tone={tone}>{i.k}</Badge>
          </span>
        ))}
      </div>
    </div>
  );
}
