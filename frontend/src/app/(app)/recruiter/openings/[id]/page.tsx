"use client";

import { ChevronLeft, Columns3, GitCompareArrows, Lock, PencilLine, Rows3, Trash2, Unlock, Upload, Users } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { OpeningMeta, SampleBadge } from "@/components/leaderboard";
import { OpeningForm } from "@/components/opening-form";
import { activeFilterCount, BulkUpload, CandidateFilterBar, CandidateTable, EMPTY_FILTERS, filterQuery, PipelineBoard, type FilterState } from "@/components/recruiter";
import { Alert, Badge, cx, Empty, ErrorState, LoadingBlock, Section, Spinner } from "@/components/ui";
import { roleTitle } from "@/lib/labels";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { ApplicationStage, CandidateList, CandidateRow, RecruiterOpeningFull, Role } from "@/lib/types";

const IMPORTANCE_KEY: Record<string, MessageKey> = { required: "rec.imp.required", preferred: "rec.imp.preferred" };

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
  const t = useT();
  const confirm = useConfirm();
  const op = useApi<RecruiterOpeningFull>(`/api/recruiter/openings/${id}`);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const fq = filterQuery(filters);
  const cands = useApi<CandidateList>(`/api/recruiter/openings/${id}/candidates${fq ? `?${fq}` : ""}`);
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles", [], { static: true });
  const allSkills = useMemo(
    () => Array.from(new Set((roles.data?.roles ?? []).flatMap((r) => [...r.required_skills, ...r.preferred_skills]))).sort((a, b) => a.localeCompare(b)),
    [roles.data],
  );
  const [view, setView] = useState<"table" | "board">(params.get("view") === "board" ? "board" : "table");
  const [selected, setSelected] = useState<string[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(params.get("created") ? t("recopen.published") : null);
  const [busy, setBusy] = useState<"status" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  if (op.loading && !op.data) return <LoadingBlock label={t("recopen.loading")} />;
  if (op.error || !op.data) return <ErrorState message={op.error ?? t("recopen.notFound")} onRetry={op.reload} />;
  const o = op.data;

  async function toggleStatus() {
    const next = o.status === "open" ? "closed" : "open";
    setBusy("status");
    setError(null);
    try {
      const r = await api<RecruiterOpeningFull>(`/api/recruiter/openings/${id}`, { method: "PATCH", body: { status: next } });
      op.setData({ ...o, ...r });
      setNotice(next === "closed" ? t("recopen.closedNotice") : t("recopen.reopened"));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!(await confirm({ title: t("recopen.confirmDelete", { title: o.title, count: o.applicants }) }))) return;
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

  /** Next page of the filtered, ranked list, appended to what is shown. */
  async function loadMore() {
    if (!cands.data) return;
    const shown = cands.data.candidates;
    setLoadingMore(true);
    setError(null);
    try {
      const q = new URLSearchParams(fq);
      q.set("offset", String(shown.length));
      q.set("limit", String(cands.data.limit));
      const next = await api<CandidateList>(`/api/recruiter/openings/${id}/candidates?${q}`);
      const have = new Set(shown.map((c) => c.application_id));
      cands.setData({ ...next, candidates: [...shown, ...next.candidates.filter((c) => !have.has(c.application_id))], offset: 0 });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function setStage(aid: string, stage: ApplicationStage) {
    if (!cands.data) return;
    cands.setData({ ...cands.data, candidates: cands.data.candidates.map((c) => (c.application_id === aid ? { ...c, stage } : c)) });
  }

  async function removeUploaded(c: CandidateRow) {
    if (!(await confirm({ title: t("rec.confirmRemove", { name: c.name }), confirmLabel: t("common.remove") }))) return;
    setError(null);
    try {
      await api(`/api/recruiter/applications/${c.application_id}`, { method: "DELETE" });
      setSelected((s) => s.filter((x) => x !== c.application_id));
      setNotice(t("recopen.removed", { name: c.name }));
      await cands.reload();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/recruiter" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> {t("rec.allOpenings")}
        </Link>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl sm:text-3xl" lang="en">{o.title}</h1>
              <Badge tone={o.status === "open" ? "ok" : "neutral"}>{o.status === "open" ? t("rec.statusOpen") : t("rec.statusClosed")}</Badge>
              {o.is_demo && <SampleBadge />}
            </div>
            <OpeningMeta o={o} className="mt-1" />
            {o.role_title && <p className="mt-1 text-xs text-muted">{t("recopen.closestRole", { role: roleTitle(t, o.role_id, o.role_title) })}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
              <PencilLine className="h-4 w-4" aria-hidden /> {editing ? t("recopen.closeEditor") : t("common.edit")}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={toggleStatus} disabled={!!busy}>
              {busy === "status" ? (
                <Spinner label={t("common.saving")} />
              ) : o.status === "open" ? (
                <>
                  <Lock className="h-4 w-4" aria-hidden /> {t("recopen.close")}
                </>
              ) : (
                <>
                  <Unlock className="h-4 w-4" aria-hidden /> {t("recopen.reopen")}
                </>
              )}
            </button>
            <button className="btn btn-ghost btn-sm text-bad" onClick={remove} disabled={!!busy}>
              {busy === "delete" ? (
                <Spinner label={t("recopen.deleting")} />
              ) : (
                <>
                  <Trash2 className="h-4 w-4" aria-hidden /> {t("common.delete")}
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}

      {editing && (
        <Section title={t("recopen.editTitle")} id="edit">
          <OpeningForm
            initial={o}
            submitLabel={t("recopen.saveChanges")}
            onCancel={() => setEditing(false)}
            onSubmit={async (v) => {
              const r = await api<RecruiterOpeningFull>(`/api/recruiter/openings/${id}`, { method: "PATCH", body: v });
              op.setData({ ...o, ...r });
              setEditing(false);
              setNotice(r.rescored_applications ? t("recopen.savedRescored", { count: r.rescored_applications }) : t("recopen.saved"));
              await cands.reload();
            }}
          />
        </Section>
      )}

      <section aria-labelledby="cands-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="cands-h" className="text-2xl">
            {t("recopen.candidates")}
            {cands.data && (
              <span className="num ml-2 text-base font-normal text-muted">
                {cands.data.candidates.length}
                {cands.data.candidates.length !== cands.data.matched ? ` ${t("recopen.ofTotal", { total: cands.data.matched })}` : ""}
              </span>
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md bg-paper-2 p-1" role="group" aria-label={t("recopen.view")}>
              {(
                [
                  ["table", t("recopen.table"), Rows3],
                  ["board", t("recopen.board"), Columns3],
                ] as const
              ).map(([v, label, Icon]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cx("inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium", view === v ? "bg-card shadow-sm" : "text-ink-2")}
                >
                  <Icon className="h-4 w-4" aria-hidden /> {label}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowUpload((u) => !u)} aria-expanded={showUpload}>
              <Upload className="h-4 w-4" aria-hidden /> {t("recopen.bulk")}
            </button>
          </div>
        </div>
        {cands.data?.note && (
          <Alert tone="info" title={t("recopen.readingOrder")}>
            {cands.data.note}
          </Alert>
        )}
        {showUpload && (
          <Section title={t("recopen.bulkTitle")} id="bulk">
            <BulkUpload openingId={id} onDone={() => void cands.reload()} />
          </Section>
        )}
        <CandidateFilterBar
          value={filters}
          onApply={(f) => {
            setFilters(f);
            setSelected([]);
          }}
          openingSkills={o.skills}
          allSkills={allSkills}
        />
        {view === "table" && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm" aria-live="polite">
            <span className="text-ink-2">
              {selected.length === 0 ? t("recopen.tickCompare") : t("recopen.selectedCompare", { count: selected.length })}
            </span>
            <Link
              href={`/recruiter/openings/${id}/compare?ids=${selected.join(",")}`}
              aria-disabled={selected.length < 2}
              className={cx("btn btn-primary btn-sm", selected.length < 2 && "pointer-events-none opacity-55")}
              tabIndex={selected.length < 2 ? -1 : undefined}
            >
              <GitCompareArrows className="h-4 w-4" aria-hidden /> {t("recopen.compare")}
              {selected.length >= 2 ? ` ${selected.length}` : ""}
            </Link>
            {selected.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected([])}>
                {t("recopen.clearSelection")}
              </button>
            )}
          </div>
        )}
        {cands.loading && !cands.data ? (
          <LoadingBlock label={t("recopen.ranking")} />
        ) : cands.error ? (
          <ErrorState message={cands.error} onRetry={cands.reload} />
        ) : !cands.data?.candidates.length ? (
          cands.data && cands.data.total > 0 && activeFilterCount(filters) > 0 ? (
            <Empty icon={<Users className="h-8 w-8" aria-hidden />} title={t("recopen.noMatch")}>
              {t("recopen.totalLoosen", { count: cands.data.total })}
            </Empty>
          ) : (
            <Empty icon={<Users className="h-8 w-8" aria-hidden />} title={t("recopen.noApplicants")}>
              {t("recopen.noApplicantsBody")}
            </Empty>
          )
        ) : view === "table" ? (
          <CandidateTable
            rows={cands.data.candidates}
            selected={selected}
            onSelect={(aid, on) => setSelected((s) => (on ? [...s, aid].slice(0, 4) : s.filter((x) => x !== aid)))}
            onStage={setStage}
            onRemove={removeUploaded}
          />
        ) : (
          <PipelineBoard rows={cands.data.candidates} onStage={setStage} />
        )}
        {cands.data?.has_more && (
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1" data-testid="load-more">
            <span className="text-xs text-muted">
              {t("recopen.showingOf", { shown: cands.data.candidates.length, matched: cands.data.matched })}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <Spinner label={t("recopen.loadingMore")} /> : t("recopen.loadMore", { count: Math.min(cands.data.limit, cands.data.matched - cands.data.candidates.length) })}
            </button>
          </div>
        )}
      </section>

      <Section title={t("recopen.postedDesc")} id="desc">
        <details>
          <summary className="cursor-pointer text-sm text-teal">{t("recopen.showDesc")}</summary>
          <p className="mt-3 whitespace-pre-line break-words text-sm text-ink-2">{o.description}</p>
          {o.requirements.length > 0 && (
            <>
              <h3 className="label mt-4">{t("recopen.reqsAsRead")}</h3>
              <ul className="space-y-1 text-sm">
                {o.requirements.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={r.importance === "required" ? "warn" : "neutral"}>{IMPORTANCE_KEY[r.importance] ? t(IMPORTANCE_KEY[r.importance]) : r.importance}</Badge>
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
