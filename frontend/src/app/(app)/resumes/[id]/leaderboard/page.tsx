"use client";

import { ArrowRight, Briefcase, ChevronDown, Compass, Info, Lightbulb, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useUser } from "@/components/shell";
import { DEFAULT_TIERS, DEFAULT_TIPS_MIN, KeywordChips, OpeningMeta, SampleBadge, ScoreBar, StageBadge, TierBadge, tierHelp, TierLegend } from "@/components/leaderboard";
import { TipsDrawer, type TipsTarget } from "@/components/tips-panel";
import { Alert, Badge, Empty, EnglishNote, ErrorState, LoadingBlock, pct, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { OpeningLeaderboard, OpeningRow, Role, RoleLeaderboard, RoleRow, Seniority, User } from "@/lib/types";
import { useResume } from "../context";

type View = "roles" | "openings";

export default function LeaderboardPage() {
  const t = useT();
  const { versionId, resume, reload } = useResume();
  const [view, setView] = useState<View>("roles");
  const [tips, setTips] = useState<TipsTarget | null>(null);
  const closeTips = useCallback(() => setTips(null), []);

  if (!versionId) return <Empty title={t("resume.confirmFirst")} />;

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label={t("lb.view")} className="inline-flex max-w-full flex-wrap gap-1 rounded-md bg-paper-2 p-1">
        {(
          [
            ["roles", t("lb.rolesForMe"), Trophy],
            ["openings", t("lb.openingsForMe"), Briefcase],
          ] as const
        ).map(([v, label, Icon]) => (
          <button
            key={v}
            role="tab"
            id={`tab-${v}`}
            aria-selected={view === v}
            aria-controls={`panel-${v}`}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium aria-selected:bg-card aria-selected:shadow-sm"
            onClick={() => setView(v)}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden /> {label}
          </button>
        ))}
      </div>
      <EnglishNote />

      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
        {view === "roles" ? (
          <RolesView versionId={versionId} onTips={setTips} />
        ) : (
          <OpeningsView versionId={versionId} resumeId={resume.id} onTips={setTips} />
        )}
      </div>

      <TipsDrawer target={tips} versionId={versionId} onClose={closeTips} onVersionChange={() => void reload()} />
    </div>
  );
}

// ---------------------------------------------------------------- A. roles

function RolesView({ versionId, onTips }: { versionId: string; onTips: (t: TipsTarget) => void }) {
  const t = useT();
  const { data, error, loading, reload } = useApi<RoleLeaderboard>(`/api/versions/${versionId}/leaderboard/roles`);
  if (loading && !data) return <LoadingBlock label={t("lb.rankingRoles")} />;
  if (error || !data) return <ErrorState message={error ?? t("lb.loadError")} onRetry={reload} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
      <div className="min-w-0 space-y-4">
        <Alert tone="info" title={t("lb.compat")}>
          {data.disclaimer}
        </Alert>
        {data.status === "insufficient_evidence" ? (
          <div className="card flex items-start gap-3 p-6">
            <Compass className="mt-1 h-6 w-6 shrink-0 text-warn" aria-hidden />
            <div>
              <h2 className="text-xl">{t("lb.notEnough")}</h2>
              <p className="mt-1 text-sm text-ink-2">{data.message}</p>
            </div>
          </div>
        ) : (
          <ol className="space-y-3" aria-label={t("lb.rolesRanked")}>
            {data.rows.map((r) => (
              <RoleItem key={r.role_id} r={r} onTips={onTips} />
            ))}
          </ol>
        )}
      </div>
      <aside className="space-y-5">
        {data.seniority && <SeniorityCard s={data.seniority} />}
        <PreferencesCard onSaved={reload} />
        <TierLegend tiers={data.tiers} tipsMin={data.tips_min_score} />
      </aside>
    </div>
  );
}

const LEVEL_KEY: Record<string, MessageKey> = { low: "roles.level.low", medium: "roles.level.medium", high: "roles.level.high" };
const DOMAINS = ["ai", "data", "analytics", "software", "web", "infrastructure", "quality", "mobile", "business"] as const;

function SeniorityCard({ s }: { s: Seniority }) {
  const t = useT();
  return (
    <Section title={t("roles.seniority")} id="seniority">
      <p className="font-display text-2xl" lang="en">{s.label}</p>
      <p className="mt-1 text-sm text-ink-2">
        {t("roles.plausible")} <strong lang="en">{s.plausible_range.join(" – ")}</strong> · {t("roles.uncertainty")}{" "}
        <Badge tone={s.uncertainty === "low" ? "ok" : s.uncertainty === "medium" ? "info" : "warn"}>
          {LEVEL_KEY[s.uncertainty] ? t(LEVEL_KEY[s.uncertainty]) : s.uncertainty}
        </Badge>
      </p>
      <p className="num mt-2 text-xs text-muted">
        {t("roles.effective", { years: s.effective_years, from: s.years_range[0], to: s.years_range[1] })}
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-ink-2">
        {s.basis.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">{s.note}</p>
    </Section>
  );
}

/** Target roles and domains, saved to the account so the leaderboard, job alerts and career tools all use them. */
function PreferencesCard({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const { user, setUser } = useUser();
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const [prefs, setPrefs] = useState({ target_roles: user.career_prefs.target_roles ?? [], domains: user.career_prefs.domains ?? [] });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (k: "target_roles" | "domains", v: string) =>
    setPrefs((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }));

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      setUser(await api<User>("/api/account/settings", { method: "PATCH", body: { career_prefs: { ...user.career_prefs, ...prefs } } }));
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={t("roles.prefs")} id="prefs">
      <fieldset>
        <legend className="label">{t("roles.targetRoles")}</legend>
        <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
          {roles.data?.roles.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={prefs.target_roles.includes(r.id)} onChange={() => toggle("target_roles", r.id)} />
              <span lang="en">{r.title}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="label">{t("roles.domains")}</legend>
        <div className="flex flex-wrap gap-1.5">
          {DOMAINS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={prefs.domains.includes(d)}
              onClick={() => toggle("domains", d)}
              className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs aria-pressed:border-teal aria-pressed:bg-teal-soft aria-pressed:text-teal"
            >
              {t(`roles.domain.${d}` as const)}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 flex gap-1.5 text-xs text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {t("roles.prefsNote")}
      </p>
      {err && <p className="mt-2 text-xs text-bad" role="alert">{err}</p>}
      <button className="btn btn-primary btn-sm mt-3" onClick={save} disabled={saving}>
        {saving ? <Spinner label={t("roles.updating")} /> : t("roles.apply")}
      </button>
    </Section>
  );
}

function RoleItem({ r, onTips }: { r: RoleRow; onTips: (t: TipsTarget) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panel = `role-${r.role_id}`;
  return (
    <li className="card" data-testid="role-row">
      <button
        className="grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-t-[inherit] p-4 text-left hover:bg-paper-2/40 sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(9rem,14rem)_auto]"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="num text-lg font-semibold text-muted" aria-label={t("lb.rank", { rank: r.rank })}>
          #{r.rank}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg leading-tight" lang="en">{r.title}</span>
            <TierBadge tier={r.tier} />
            {r.preference_adjustment > 0 && <Badge tone="teal">{t("roles.prefAdj", { n: r.preference_adjustment })}</Badge>}
          </span>
        </span>
        <span className="col-span-3 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1">
          <ScoreBar score={r.score} tier={r.tier.id} label={t("lb.compatScore", { title: r.title })} />
        </span>
        <ChevronDown className={`col-start-3 row-start-1 h-4 w-4 text-muted transition-transform sm:col-start-4 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <div className="px-4 pb-4">
        <KeywordChips matched={r.keywords_matched} weak={r.keywords_weak} missing={r.keywords_missing} limit={8} />
      </div>
      {open && (
        <div id={panel} className="space-y-3 border-t border-line p-4">
          <p className="text-sm text-ink-2">{tierHelp(t, r.tier)}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
            {r.preference_reasons.map((x) => (
              <li key={x} className="text-teal">{x}</li>
            ))}
          </ul>
          {r.possibly_unlisted.length > 0 && (
            <div>
              <h3 className="label">{t("roles.maybe")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {r.possibly_unlisted.map((p) => (
                  <span key={p.skill} title={t("roles.relatedTo", { list: p.because_you_have.join(", ") })}>
                    <Badge tone="info">{p.skill}</Badge>
                  </span>
                ))}
              </div>
            </div>
          )}
          {r.next_steps.length > 0 && (
            <div>
              <h3 className="label">{t("roles.nextSteps")}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {r.next_steps.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ol>
            </div>
          )}
          <p className="text-xs text-muted">
            {t("lb.coreShown")} <span className="num">{pct(r.core_coverage)}</span>
            {!r.tips_available && r.tips_blocked_reason && <> · {t("lb.tipsOff", { reason: r.tips_blocked_reason })}</>}
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => onTips({ kind: "role", id: r.role_id, title: r.title })}>
            <Lightbulb className="h-4 w-4 shrink-0" aria-hidden /> {t("tips.improveRole")}
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- B. openings

function OpeningsView({ versionId, resumeId, onTips }: { versionId: string; resumeId: string; onTips: (t: TipsTarget) => void }) {
  const t = useT();
  const { data, error, loading, reload } = useApi<OpeningLeaderboard>(`/api/versions/${versionId}/leaderboard/openings`);
  if (loading && !data) return <LoadingBlock label={t("lb.rankingOpenings")} />;
  if (error || !data) return <ErrorState message={error ?? t("lb.openingsLoadError")} onRetry={reload} />;
  if (data.status === "no_openings" || !data.rows.length)
    return (
      <Empty icon={<Briefcase className="h-8 w-8" aria-hidden />} title={t("lb.noOpenings")}>
        {data.message ?? t("lb.noOpeningsBody")}
      </Empty>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
      <div className="min-w-0 space-y-4">
        <Alert tone="info" title={t("lb.compat")}>
          {data.disclaimer}
        </Alert>
        <ol className="space-y-3" aria-label={t("lb.openingsRanked")}>
          {data.rows.map((o) => (
            <OpeningItem key={o.id} o={o} resumeId={resumeId} onTips={onTips} />
          ))}
        </ol>
      </div>
      <aside>
        <TierLegend tiers={DEFAULT_TIERS} tipsMin={DEFAULT_TIPS_MIN} />
      </aside>
    </div>
  );
}

function OpeningItem({ o, resumeId, onTips }: { o: OpeningRow; resumeId: string; onTips: (t: TipsTarget) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const href = `/openings/${o.id}?resume=${resumeId}`;
  const panel = `opening-${o.id}`;
  return (
    <li className="card" data-testid="opening-row">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(9rem,14rem)]">
        <span className="num text-lg font-semibold text-muted" aria-label={t("lb.rank", { rank: o.rank })}>
          #{o.rank}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={href} className="font-display text-lg leading-tight hover:underline">
              {o.title}
            </Link>
            <TierBadge tier={o.tier} />
            {o.is_demo && <SampleBadge />}
            {o.application && (
              <span className="inline-flex items-center gap-1">
                <Badge tone="teal">{t("lb.applied")}</Badge>
                <StageBadge stage={o.application.stage} />
              </span>
            )}
          </div>
          <OpeningMeta o={o} className="mt-1" />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <ScoreBar score={o.score} tier={o.tier.id} label={t("lb.openingCompatScore", { title: o.title, company: o.company })} />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-4">
        <KeywordChips matched={o.keywords_matched} missing={o.keywords_missing} limit={8} />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((x) => !x)}>
            {t("lb.details")} <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
          <Link href={href} className="btn btn-secondary btn-sm">
            {t("lb.viewOpening")} <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
      {open && (
        <div id={panel} className="space-y-3 border-t border-line p-4 text-sm">
          <p className="text-ink-2">{tierHelp(t, o.tier)}</p>
          <p className="text-xs text-muted">
            {t("lb.requirements", { matched: o.counts.matched, partial: o.counts.partial, missing: o.counts.missing })}
            {o.counts.unknown ? ` · ${t("lb.cantJudge", { count: o.counts.unknown })}` : ""}
          </p>
          {o.genuine_gaps.length > 0 && (
            <p>
              <span className="font-semibold">{t("lb.genuineGaps")}</span> {o.genuine_gaps.join(", ")}
            </p>
          )}
          {o.possibly_unlisted.length > 0 && (
            <p>
              <span className="font-semibold">{t("lb.mayHave")}</span> {o.possibly_unlisted.join(", ")}
            </p>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => onTips({ kind: "opening", id: o.id, title: o.title })}>
            <Lightbulb className="h-4 w-4 shrink-0" aria-hidden /> {t("tips.improveOpening")}
          </button>
        </div>
      )}
    </li>
  );
}
