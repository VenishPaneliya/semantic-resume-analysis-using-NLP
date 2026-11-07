"use client";

import { Compass, GraduationCap, Lightbulb, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Suggestion, Tip, Tips } from "@/lib/types";
import { TierBadge } from "./leaderboard";
import { SuggestionCard } from "./suggestion-card";
import { Alert, Badge, ErrorState, LoadingBlock, Spinner } from "./ui";

export type TipsTarget = { kind: "role" | "opening"; id: string; title: string };

const PRIORITY: { id: Tip["priority"]; label: string; tone: "bad" | "warn" | "neutral" }[] = [
  { id: "high", label: "High priority", tone: "bad" },
  { id: "medium", label: "Medium priority", tone: "warn" },
  { id: "low", label: "Low priority", tone: "neutral" },
];

/** Relevance-gated tips for one role or opening. Below the gate it shows a learning path, never resume edits. */
export function TipsContent({ versionId, target, onVersionChange, headingLevel = 2 }: {
  versionId: string;
  target: TipsTarget;
  onVersionChange?: (versionId: string) => void;
  headingLevel?: 2 | 3;
}) {
  const q = target.kind === "role" ? `role_id=${encodeURIComponent(target.id)}` : `opening_id=${encodeURIComponent(target.id)}`;
  const { data, error, loading, reload } = useApi<Tips>(`/api/versions/${versionId}/tips?${q}`);
  const H = headingLevel === 2 ? "h2" : "h3";
  const H2 = headingLevel === 2 ? "h3" : "h4";

  if (loading && !data) return <LoadingBlock label="Checking how close this is…" />;
  if (error || !data) return <ErrorState message={error ?? "Could not load tips."} onRetry={reload} />;

  return (
    <div className="space-y-4" data-testid="tips-content">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">
          Score <strong className="num">{data.score == null ? "—" : Math.round(data.score)}</strong>/100
        </span>
        <TierBadge tier={data.tier} />
      </div>

      {data.eligible ? (
        <>
          {data.tips.length === 0 ? (
            <Alert tone="ok" title="Nothing urgent to change">
              {data.message ?? "Your resume already presents this well."}
            </Alert>
          ) : (
            PRIORITY.map((p) => {
              const tips = data.tips.filter((t) => t.priority === p.id);
              if (!tips.length) return null;
              return (
                <section key={p.id} aria-label={p.label}>
                  <H2 className="label flex items-center gap-2">
                    <Badge tone={p.tone}>{p.label}</Badge>
                  </H2>
                  <ul className="space-y-3">
                    {tips.map((t) => (
                      <TipItem key={t.id} tip={t} versionId={versionId} onVersionChange={onVersionChange} />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
          {data.learning_path.length > 0 && (
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-sm font-semibold">Skills this asks for that your resume doesn&apos;t show</summary>
              <LearningPath items={data.learning_path} />
            </details>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-line bg-paper-2/60 p-4" role="status" data-testid="not-eligible">
          <div className="flex items-start gap-3">
            <Compass className="mt-0.5 h-6 w-6 shrink-0 text-teal" aria-hidden />
            <div>
              <H className="text-lg">Not a close match yet</H>
              <p className="mt-1 text-sm text-ink-2">{data.gate_message}</p>
            </div>
          </div>
          {data.learning_path.length > 0 ? (
            <div className="mt-4">
              <H2 className="label flex items-center gap-1.5">
                <GraduationCap className="h-4 w-4" aria-hidden /> Where to start
              </H2>
              <LearningPath items={data.learning_path} />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No specific skills to list for this target.</p>
          )}
        </div>
      )}

      <Alert tone="info" title="Honesty first">
        {data.honesty_note}
      </Alert>
    </div>
  );
}

function LearningPath({ items }: { items: Tips["learning_path"] }) {
  return (
    <ol className="mt-2 space-y-2">
      {items.map((l) => (
        <li key={l.skill} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-baseline sm:gap-2">
          <span className="flex items-center gap-2 font-medium">
            {l.skill} <Badge tone={l.importance === "required" ? "warn" : "neutral"}>{l.importance}</Badge>
          </span>
          <span className="text-xs text-ink-2">{l.why}</span>
        </li>
      ))}
    </ol>
  );
}

function TipItem({ tip, versionId, onVersionChange }: { tip: Tip; versionId: string; onVersionChange?: (v: string) => void }) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ msg: string; related: boolean } | null>(null);
  const [resolved, setResolved] = useState<"accepted" | "rejected" | null>(null);

  async function draft() {
    if (!tip.action) return;
    setPending(true);
    setError(null);
    const { operation, target_path, target_role, opening_id } = tip.action;
    try {
      const s = await api<Suggestion>(`/api/versions/${versionId}/suggestions`, {
        body: { operation, target_path, ...(target_role ? { target_role } : {}), ...(opening_id ? { opening_id } : {}) },
      });
      setSuggestion(s);
      setResolved(null);
    } catch (e) {
      setError({ msg: errMsg(e), related: e instanceof ApiError && e.code === "target_not_related" });
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="rounded-lg border border-line bg-card p-3">
      <p className="flex items-start gap-2 text-sm font-semibold">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden /> {tip.title}
      </p>
      <p className="mt-1 text-sm text-ink-2">{tip.detail}</p>
      {tip.action?.type === "ai" && !suggestion && (
        <button className="btn btn-secondary btn-sm mt-2" onClick={draft} disabled={pending}>
          {pending ? <Spinner label="Drafting" /> : (<><Sparkles className="h-4 w-4 text-ai" aria-hidden /> Draft with AI</>)}
        </button>
      )}
      {error && (
        <div className="mt-2">
          <Alert tone={error.related ? "warn" : "bad"} title={error.related ? "Not related enough to tailor" : undefined}>
            {error.msg}
          </Alert>
        </div>
      )}
      {suggestion && !resolved && (
        <div className="mt-3">
          <SuggestionCard
            s={suggestion}
            onResolved={(r) => {
              setResolved(r.accepted ? "accepted" : "rejected");
              if (r.accepted && r.versionId) onVersionChange?.(r.versionId);
            }}
          />
        </div>
      )}
      {resolved === "accepted" && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ok" role="status">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Accepted. Saved as a new resume version.
        </p>
      )}
      {resolved === "rejected" && (
        <p className="mt-2 text-xs text-muted" role="status">
          Rejected. Nothing changed.{" "}
          <button className="text-teal underline" onClick={() => { setSuggestion(null); setResolved(null); }}>
            Try again
          </button>
        </p>
      )}
    </li>
  );
}

/** Side drawer wrapper (full-screen sheet on phones). */
export function TipsDrawer({ target, versionId, onClose, onVersionChange }: {
  target: TipsTarget | null;
  versionId: string;
  onClose: () => void;
  onVersionChange?: (v: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        const f = panelRef.current.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, summary, [tabindex]:not([tabindex='-1'])");
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [target, onClose]);

  if (!target) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tips-title"
        className="relative flex h-full w-full max-w-xl flex-col bg-paper shadow-xl sm:border-l sm:border-line"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line bg-card px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow">How to improve for this {target.kind}</p>
            <h2 id="tips-title" className="text-xl leading-tight">
              {target.title}
            </h2>
          </div>
          <button ref={closeRef} className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close tips">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <TipsContent key={`${target.kind}:${target.id}:${versionId}`} versionId={versionId} target={target} onVersionChange={onVersionChange} headingLevel={3} />
        </div>
      </div>
    </div>
  );
}
