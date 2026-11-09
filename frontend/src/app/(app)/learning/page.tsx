"use client";

import { BookOpen, CheckCircle2, ExternalLink, GraduationCap, PencilLine, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Bar, Empty, ErrorState, fmtDate, LoadingBlock, PageHeader } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { LearningItem, LearningPlan, LearningStatus, Resume } from "@/lib/types";

const COLUMNS: { id: LearningStatus; label: MessageKey; help: MessageKey }[] = [
  { id: "todo", label: "learning.col.todo", help: "learning.col.todoHelp" },
  { id: "learning", label: "learning.col.learning", help: "learning.col.learningHelp" },
  { id: "done", label: "learning.col.done", help: "learning.col.doneHelp" },
];

export default function LearningPage() {
  const t = useT();
  const { data, setData, error, loading, reload } = useApi<LearningPlan>("/api/learning");
  const resumes = useApi<Resume[]>("/api/resumes");
  const [err, setErr] = useState<string | null>(null);
  const editorResume = resumes.data?.find((r) => r.latest_version_id);
  const editorHref = editorResume ? `/resumes/${editorResume.id}/editor` : "/dashboard";

  function replace(item: LearningItem) {
    if (!data) return;
    const items = data.items.map((i) => (i.id === item.id ? item : i));
    const done = items.filter((i) => i.status === "done").length;
    setData({ ...data, items, progress: { done, total: items.length, percent: items.length ? Math.round((100 * done) / items.length) : 0 } });
  }

  async function move(item: LearningItem, status: LearningStatus) {
    setErr(null);
    try {
      replace(await api<LearningItem>(`/api/learning/${item.id}`, { method: "PATCH", body: { status } }));
    } catch (e) {
      setErr(errMsg(e));
    }
  }
  async function remove(item: LearningItem) {
    if (!window.confirm(t("learning.confirmRemove", { skill: item.skill }))) return;
    setErr(null);
    try {
      await api(`/api/learning/${item.id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={t("learning.eyebrow")} title={t("learning.title")}>
        {t("learning.intro")}
      </PageHeader>

      {loading && !data ? (
        <LoadingBlock label={t("learning.loading")} />
      ) : error || !data ? (
        <ErrorState message={error ?? t("learning.loadError")} onRetry={reload} />
      ) : data.items.length === 0 ? (
        <Empty
          icon={<GraduationCap className="h-8 w-8" aria-hidden />}
          title={t("learning.empty")}
          action={
            <Link href="/dashboard" className="btn btn-secondary btn-sm">
              {t("learning.goResumes")}
            </Link>
          }
        >
          {t("learning.emptyBody")}
        </Empty>
      ) : (
        <>
          <div className="card p-5" data-testid="learning-progress">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg">{t("learning.progress")}</h2>
              <p className="text-sm text-ink-2">
                {t.rich(
                  "learning.progressSummary",
                  { b: (c) => <span className="num font-semibold text-ink">{c}</span> },
                  { done: data.progress.done, total: data.progress.total, percent: data.progress.percent },
                )}
              </p>
            </div>
            <Bar value={data.progress.percent} max={100} label={t("learning.progressAria")} />
          </div>
          {err && <Alert tone="bad">{err}</Alert>}
          <div className="grid gap-4 md:grid-cols-[repeat(3,minmax(0,1fr))]">
            {COLUMNS.map((col) => {
              const items = data.items.filter((i) => i.status === col.id);
              return (
                <section key={col.id} aria-labelledby={`lc-${col.id}`} className="rounded-lg border border-line bg-paper-2/60 p-3" data-testid={`learning-col-${col.id}`}>
                  <h2 id={`lc-${col.id}`} className="flex items-center justify-between gap-2 px-1 text-base">
                    <span>{t(col.label)}</span>
                    <span className="num rounded-full bg-card px-2 text-xs text-muted">{items.length}</span>
                  </h2>
                  <p className="mb-2 px-1 text-xs text-muted">{t(col.help)}</p>
                  <ul className="space-y-3">
                    {items.map((i) => (
                      <ItemCard key={i.id} item={i} editorHref={editorHref} onMove={(s) => move(i, s)} onRemove={() => remove(i)} />
                    ))}
                    {items.length === 0 && <li className="px-1 py-4 text-center text-xs text-muted">{t("learning.nothing")}</li>}
                  </ul>
                </section>
              );
            })}
          </div>
          <p className="text-xs text-muted">{data.resource_provider !== "none" ? t("learning.resourcesNote") : t("learning.resourcesNoteOff")}</p>
        </>
      )}
    </div>
  );
}

function ItemCard({ item, editorHref, onMove, onRemove }: { item: LearningItem; editorHref: string; onMove: (s: LearningStatus) => void; onRemove: () => void }) {
  const t = useT();
  const r = item.resources;
  return (
    <li className="rounded-md border border-line bg-card p-3 shadow-sm" data-testid="learning-item">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base leading-tight">{item.skill}</h3>
          {item.target.title && <p className="mt-0.5 text-xs text-muted">{t("learning.for", { title: item.target.title })}</p>}
        </div>
        <button className="btn btn-ghost btn-sm !p-1 text-muted" onClick={onRemove} aria-label={t("learning.removeAria", { skill: item.skill })}>
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {item.evidence_in_resume && (
        <p className="mt-2">
          <Badge tone="teal">
            <CheckCircle2 className="h-3 w-3" aria-hidden /> {t("learning.shownOnResume")}
          </Badge>
        </p>
      )}

      <div className="mt-3">
        <p className="label !mb-1 flex items-center gap-1">
          <BookOpen className="h-3.5 w-3.5" aria-hidden /> {t("learning.resources")}
        </p>
        {r.status === "ok" && r.resources?.length ? (
          <ul className="space-y-1.5">
            {r.resources.map((x) => (
              <li key={x.url} className="text-sm">
                <a href={x.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 break-words font-medium text-teal hover:underline">
                  {x.title} <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span className="sr-only">{t("learning.newTab")}</span>
                </a>
                <span className="block text-[11px] text-muted">
                  {x.source ? `${x.source} · ` : ""}
                  {t("learning.checkedOn", { date: fmtDate(x.retrieved_on) })}
                </span>
              </li>
            ))}
          </ul>
        ) : r.status === "unavailable" ? (
          <p className="text-xs text-muted">{r.message ?? t("learning.off")}</p>
        ) : (
          <p className="text-xs text-muted" data-testid="no-resource">
            {t("learning.noResource", { skill: item.skill })}
          </p>
        )}
      </div>

      {item.next_step && (
        <div className="mt-3 rounded-md border border-[#b8d6d0] bg-teal-soft p-2.5 text-xs text-teal" data-testid="next-step">
          <p>{item.next_step}</p>
          <Link href={editorHref} className="mt-1 inline-flex items-center gap-1 font-semibold underline">
            <PencilLine className="h-3.5 w-3.5" aria-hidden /> {t("learning.openEditor")}
          </Link>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={`ls-${item.id}`} className="text-xs font-semibold text-muted">
          {t("learning.status")}
        </label>
        <select id={`ls-${item.id}`} className="input w-auto !py-1 text-sm" value={item.status} onChange={(e) => onMove(e.target.value as LearningStatus)} aria-label={t("learning.statusAria", { skill: item.skill })}>
          {COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>
              {t(c.label)}
            </option>
          ))}
        </select>
        {item.status !== "done" && (
          <button className="btn btn-secondary btn-sm" onClick={() => onMove("done")}>
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {t("learning.markDone")}
          </button>
        )}
      </div>
      {item.completed_at && <p className="mt-1 text-[11px] text-muted">{t("learning.completed", { date: fmtDate(item.completed_at) })}</p>}
    </li>
  );
}
