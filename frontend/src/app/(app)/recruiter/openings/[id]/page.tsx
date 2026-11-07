"use client";

import { ChevronLeft, Lock, PencilLine, Trash2, Unlock, Users } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { KeywordChips, OpeningMeta, SampleBadge, ScoreBar, TierBadge } from "@/components/leaderboard";
import { StageSelect } from "@/components/stage-select";
import { OpeningForm } from "@/components/opening-form";
import { Alert, Badge, Empty, ErrorState, fmtDate, LoadingBlock, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ApplicationStage, CandidateList, CandidateRow, RecruiterOpeningFull } from "@/lib/types";

export default function RecruiterOpeningPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <RecruiterOpening />
    </Suspense>
  );
}

function RecruiterOpening() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const op = useApi<RecruiterOpeningFull>(`/api/recruiter/openings/${id}`);
  const cands = useApi<CandidateList>(`/api/recruiter/openings/${id}/candidates`);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(params.get("created") ? "Opening published. Candidates can now see it and apply." : null);
  const [busy, setBusy] = useState<"status" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (op.loading && !op.data) return <LoadingBlock label="Loading opening…" />;
  if (op.error || !op.data) return <ErrorState message={op.error ?? "Opening not found."} onRetry={op.reload} />;
  const o = op.data;

  async function toggleStatus() {
    const next = o.status === "open" ? "closed" : "open";
    setBusy("status");
    setError(null);
    try {
      const r = await api<RecruiterOpeningFull>(`/api/recruiter/openings/${id}`, { method: "PATCH", body: { status: next } });
      op.setData({ ...o, ...r });
      setNotice(next === "closed" ? "Opening closed. Candidates can no longer see or apply to it." : "Opening reopened.");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete “${o.title}”? This also removes its ${o.applicants} application(s). This can't be undone.`)) return;
    setBusy("delete");
    setError(null);
    try {
      await api(`/api/recruiter/openings/${id}`, { method: "DELETE" });
      router.push("/recruiter");
    } catch (e) {
      setError(errMsg(e));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/recruiter" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> All openings
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl sm:text-3xl">{o.title}</h1>
              <Badge tone={o.status === "open" ? "ok" : "neutral"}>{o.status === "open" ? "Open" : "Closed"}</Badge>
              {o.is_demo && <SampleBadge />}
            </div>
            <OpeningMeta o={o} className="mt-1" />
            {o.role_title && <p className="mt-1 text-xs text-muted">Closest standard role: {o.role_title}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
              <PencilLine className="h-4 w-4" aria-hidden /> {editing ? "Close editor" : "Edit"}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={toggleStatus} disabled={!!busy}>
              {busy === "status" ? <Spinner label="Saving" /> : o.status === "open" ? (<><Lock className="h-4 w-4" aria-hidden /> Close opening</>) : (<><Unlock className="h-4 w-4" aria-hidden /> Reopen</>)}
            </button>
            <button className="btn btn-ghost btn-sm text-bad" onClick={remove} disabled={!!busy}>
              {busy === "delete" ? <Spinner label="Deleting" /> : (<><Trash2 className="h-4 w-4" aria-hidden /> Delete</>)}
            </button>
          </div>
        </div>
      </div>

      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}

      {editing && (
        <Section title="Edit opening" id="edit">
          <OpeningForm
            initial={o}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={async (v) => {
              const r = await api<RecruiterOpeningFull>(`/api/recruiter/openings/${id}`, { method: "PATCH", body: v });
              op.setData({ ...o, ...r });
              setEditing(false);
              setNotice(r.rescored_applications ? `Saved. ${r.rescored_applications} application(s) re-scored against the new description.` : "Saved.");
              await cands.reload();
            }}
          />
        </Section>
      )}

      <section aria-labelledby="cands-h" className="space-y-3">
        <h2 id="cands-h" className="text-2xl">
          Candidates
        </h2>
        {cands.data?.note && (
          <Alert tone="info" title="A reading order, not a decision">
            {cands.data.note}
          </Alert>
        )}
        {cands.loading && !cands.data ? (
          <LoadingBlock label="Ranking candidates…" />
        ) : cands.error ? (
          <ErrorState message={cands.error} onRetry={cands.reload} />
        ) : !cands.data?.candidates.length ? (
          <Empty icon={<Users className="h-8 w-8" aria-hidden />} title="No applicants yet">
            People appear here after they apply and agree to share their resume with you.
          </Empty>
        ) : (
          <CandidateTable rows={cands.data.candidates} onStage={(aid, stage) => cands.setData({ ...cands.data!, candidates: cands.data!.candidates.map((c) => (c.application_id === aid ? { ...c, stage } : c)) })} />
        )}
      </section>

      <Section title="Posted description" id="desc">
        <details>
          <summary className="cursor-pointer text-sm text-teal">Show description and extracted requirements</summary>
          <p className="mt-3 whitespace-pre-line break-words text-sm text-ink-2">{o.description}</p>
          {o.requirements.length > 0 && (
            <>
              <h3 className="label mt-4">Requirements as the matcher reads them</h3>
              <ul className="space-y-1 text-sm">
                {o.requirements.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={r.importance === "required" ? "warn" : "neutral"}>{r.importance}</Badge>
                    <span className="min-w-0">{r.text}</span>
                    <span className="text-xs text-muted">{r.kind}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      </Section>
    </div>
  );
}

function CandidateTable({ rows, onStage }: { rows: CandidateRow[]; onStage: (aid: string, s: ApplicationStage) => void }) {
  return (
    <div className="card relative overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <caption className="sr-only">Candidates ranked by compatibility</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="px-4 py-3 font-semibold">#</th>
            <th scope="col" className="px-4 py-3 font-semibold">Candidate</th>
            <th scope="col" className="w-48 px-4 py-3 font-semibold">Score</th>
            <th scope="col" className="px-4 py-3 font-semibold">Keywords</th>
            <th scope="col" className="w-40 px-4 py-3 font-semibold">Stage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.application_id} className="border-b border-line align-top last:border-0" data-testid="candidate-row">
              <td className="num px-4 py-3 font-semibold text-muted">{c.rank}</td>
              <td className="px-4 py-3">
                <Link href={`/recruiter/applications/${c.application_id}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
                <p className="text-xs text-muted">{c.email}</p>
                <p className="text-xs text-muted">Applied {fmtDate(c.applied_at)}</p>
              </td>
              <td className="px-4 py-3">
                <ScoreBar score={c.score} tier={c.tier.id} label={`${c.name} compatibility score`} />
                <div className="mt-1.5">
                  <TierBadge tier={c.tier} />
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  {c.counts.matched ?? 0} matched · {c.counts.partial ?? 0} partial · {c.counts.missing ?? 0} missing
                </p>
              </td>
              <td className="px-4 py-3">
                <KeywordChips matched={c.keywords_matched} missing={c.keywords_missing} limit={6} />
              </td>
              <td className="px-4 py-3">
                <StageSelect applicationId={c.application_id} stage={c.stage} name={c.name} onChange={(s) => onStage(c.application_id, s)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
