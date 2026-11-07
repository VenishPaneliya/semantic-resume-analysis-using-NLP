"use client";

import { ArrowRight, Briefcase, ChevronDown, Compass, Lightbulb, Trophy } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { DEFAULT_TIERS, DEFAULT_TIPS_MIN, KeywordChips, OpeningMeta, SampleBadge, ScoreBar, StageBadge, TierBadge, TierLegend } from "@/components/leaderboard";
import { TipsDrawer, type TipsTarget } from "@/components/tips-panel";
import { Alert, Badge, Empty, ErrorState, LoadingBlock, pct } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { OpeningLeaderboard, OpeningRow, RoleLeaderboard, RoleRow } from "@/lib/types";
import { useResume } from "../context";

type View = "roles" | "openings";

export default function LeaderboardPage() {
  const { versionId, resume, reload } = useResume();
  const [view, setView] = useState<View>("roles");
  const [tips, setTips] = useState<TipsTarget | null>(null);
  const closeTips = useCallback(() => setTips(null), []);

  if (!versionId) return <Empty title="Confirm the extraction first" />;

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Leaderboard view" className="inline-flex gap-1 rounded-md bg-paper-2 p-1">
        {(
          [
            ["roles", "Roles for me", Trophy],
            ["openings", "Openings for me", Briefcase],
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
            <Icon className="h-4 w-4" aria-hidden /> {label}
          </button>
        ))}
      </div>

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
  const { data, error, loading, reload } = useApi<RoleLeaderboard>(`/api/versions/${versionId}/leaderboard/roles`);
  if (loading && !data) return <LoadingBlock label="Ranking roles…" />;
  if (error || !data) return <ErrorState message={error ?? "Could not load the leaderboard."} onRetry={reload} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
      <div className="min-w-0 space-y-4">
        <Alert tone="info" title="Compatibility, not probability">
          {data.disclaimer}
        </Alert>
        {data.status === "insufficient_evidence" ? (
          <div className="card flex items-start gap-3 p-6">
            <Compass className="mt-1 h-6 w-6 shrink-0 text-warn" aria-hidden />
            <div>
              <h2 className="text-xl">Not enough evidence yet</h2>
              <p className="mt-1 text-sm text-ink-2">{data.message}</p>
            </div>
          </div>
        ) : (
          <ol className="space-y-3" aria-label="Roles ranked for this resume">
            {data.rows.map((r) => (
              <RoleItem key={r.role_id} r={r} onTips={onTips} />
            ))}
          </ol>
        )}
      </div>
      <aside>
        <TierLegend tiers={data.tiers} tipsMin={data.tips_min_score} />
      </aside>
    </div>
  );
}

function RoleItem({ r, onTips }: { r: RoleRow; onTips: (t: TipsTarget) => void }) {
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
        <span className="num text-lg font-semibold text-muted" aria-label={`Rank ${r.rank}`}>
          #{r.rank}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg leading-tight">{r.title}</span>
            <TierBadge tier={r.tier} />
          </span>
        </span>
        <span className="col-span-3 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1">
          <ScoreBar score={r.score} tier={r.tier.id} label={`${r.title} compatibility score`} />
        </span>
        <ChevronDown className={`col-start-3 row-start-1 h-4 w-4 text-muted transition-transform sm:col-start-4 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <div className="px-4 pb-4">
        <KeywordChips matched={r.keywords_matched} weak={r.keywords_weak} missing={r.keywords_missing} limit={8} />
      </div>
      {open && (
        <div id={panel} className="space-y-3 border-t border-line p-4">
          <p className="text-sm text-ink-2">{r.tier.help}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Core skills shown: <span className="num">{pct(r.core_coverage)}</span>
            {!r.tips_available && r.tips_blocked_reason && <> · Resume-edit tips are off for this role ({r.tips_blocked_reason}).</>}
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => onTips({ kind: "role", id: r.role_id, title: r.title })}>
            <Lightbulb className="h-4 w-4" aria-hidden /> How to improve for this role
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- B. openings

function OpeningsView({ versionId, resumeId, onTips }: { versionId: string; resumeId: string; onTips: (t: TipsTarget) => void }) {
  const { data, error, loading, reload } = useApi<OpeningLeaderboard>(`/api/versions/${versionId}/leaderboard/openings`);
  if (loading && !data) return <LoadingBlock label="Ranking openings…" />;
  if (error || !data) return <ErrorState message={error ?? "Could not load openings."} onRetry={reload} />;
  if (data.status === "no_openings" || !data.rows.length)
    return (
      <Empty icon={<Briefcase className="h-8 w-8" aria-hidden />} title="No openings yet">
        {data.message ?? "No openings have been posted yet. Check back soon."}
      </Empty>
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
      <div className="min-w-0 space-y-4">
        <Alert tone="info" title="Compatibility, not probability">
          {data.disclaimer}
        </Alert>
        <ol className="space-y-3" aria-label="Openings ranked for this resume">
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
  const [open, setOpen] = useState(false);
  const href = `/openings/${o.id}?resume=${resumeId}`;
  const panel = `opening-${o.id}`;
  return (
    <li className="card" data-testid="opening-row">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(9rem,14rem)]">
        <span className="num text-lg font-semibold text-muted" aria-label={`Rank ${o.rank}`}>
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
                <Badge tone="teal">Applied</Badge>
                <StageBadge stage={o.application.stage} />
              </span>
            )}
          </div>
          <OpeningMeta o={o} className="mt-1" />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <ScoreBar score={o.score} tier={o.tier.id} label={`${o.title} at ${o.company} compatibility score`} />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-4">
        <KeywordChips matched={o.keywords_matched} missing={o.keywords_missing} limit={8} />
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((x) => !x)}>
            Details <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
          <Link href={href} className="btn btn-secondary btn-sm">
            View opening <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
      {open && (
        <div id={panel} className="space-y-3 border-t border-line p-4 text-sm">
          <p className="text-ink-2">{o.tier.help}</p>
          <p className="text-xs text-muted">
            Requirements: {o.counts.matched} matched · {o.counts.partial} partial · {o.counts.missing} missing
            {o.counts.unknown ? ` · ${o.counts.unknown} can't be judged from a resume` : ""}
          </p>
          {o.genuine_gaps.length > 0 && (
            <p>
              <span className="font-semibold">Genuine gaps:</span> {o.genuine_gaps.join(", ")}
            </p>
          )}
          {o.possibly_unlisted.length > 0 && (
            <p>
              <span className="font-semibold">You may have (add only if true):</span> {o.possibly_unlisted.join(", ")}
            </p>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => onTips({ kind: "opening", id: o.id, title: o.title })}>
            <Lightbulb className="h-4 w-4" aria-hidden /> How to improve for this opening
          </button>
        </div>
      )}
    </li>
  );
}
