"use client";

import { CalendarClock, FileUp, Filter, GripVertical, Lock, MessageSquare, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { api, errMsg } from "@/lib/api";
import { useT, type TFunction } from "@/lib/i18n";
import { STAGES, type ApplicationStage, type BulkUploadResult, type CandidateRow, type CandidateSource, type Note } from "@/lib/types";
import { KeywordChips, ScoreBar, TierBadge } from "./leaderboard";
import { STAGE_KEY, StageSelect } from "./stage-select";
import { Alert, Badge, cx, Field, fmtDate, Spinner } from "./ui";

// ---------------------------------------------------------------- badges

export function UploadedBadge({ expiresAt }: { expiresAt: string | null }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone="info">
        <FileUp className="h-3 w-3" aria-hidden /> {t("rec.uploadedBadge")}
      </Badge>
      {expiresAt && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted" title={t("rec.autoDeleted")}>
          <CalendarClock className="h-3 w-3" aria-hidden /> {t("rec.deletedOn", { date: fmtDate(expiresAt) })}
        </span>
      )}
    </span>
  );
}

/** Years of experience, e.g. "3.5 yrs". Pass `t` for the current language (English without it). */
export function fmtYears(y: number | null | undefined, t?: TFunction) {
  if (y == null) return "—";
  const n = Math.round(y * 10) / 10;
  if (t) return t("rec.years", { count: n });
  return `${n} yr${y === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- filters

export interface FilterState {
  mustHave: string[];
  minYears: string;
  minScore: string;
  stage: ApplicationStage | "";
  source: CandidateSource | "";
}
export const EMPTY_FILTERS: FilterState = { mustHave: [], minYears: "", minScore: "", stage: "", source: "" };

export function filterQuery(f: FilterState) {
  const q = new URLSearchParams();
  f.mustHave.forEach((s) => q.append("must_have", s));
  if (f.minYears !== "") q.set("min_years", f.minYears);
  if (f.minScore !== "") q.set("min_score", f.minScore);
  if (f.stage) q.append("stage", f.stage);
  if (f.source) q.set("source", f.source);
  return q.toString();
}

export function activeFilterCount(f: FilterState) {
  return f.mustHave.length + (f.minYears !== "" ? 1 : 0) + (f.minScore !== "" ? 1 : 0) + (f.stage ? 1 : 0) + (f.source ? 1 : 0);
}

/** Shortlisting filters. Applied on "Apply filters" so typing a number doesn't refetch on every keystroke. */
export function CandidateFilterBar({ value, onApply, openingSkills, allSkills }: {
  value: FilterState;
  onApply: (f: FilterState) => void;
  openingSkills: string[];
  allSkills: string[];
}) {
  const t = useT();
  const [f, setF] = useState<FilterState>(value);
  const others = useMemo(() => allSkills.filter((s) => !openingSkills.includes(s)), [allSkills, openingSkills]);
  const n = activeFilterCount(value);

  function submit(e: FormEvent) {
    e.preventDefault();
    onApply(f);
  }
  return (
    <form className="card space-y-4 p-4" onSubmit={submit} aria-labelledby="filters-h" data-testid="candidate-filters">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="filters-h" className="flex items-center gap-1.5 text-base">
          <Filter className="h-4 w-4 text-teal" aria-hidden /> {t("rec.f.title")}
          {n > 0 && <Badge tone="teal">{t("rec.f.active", { count: n })}</Badge>}
        </h3>
        <p className="text-xs text-muted">{t("rec.f.note")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <label htmlFor="f-skill" className="label">
            {t("rec.f.mustHave")}
          </label>
          <select
            id="f-skill"
            className="input"
            value=""
            onChange={(e) => {
              const s = e.target.value;
              if (s && !f.mustHave.includes(s) && f.mustHave.length < 10) setF({ ...f, mustHave: [...f.mustHave, s] });
            }}
          >
            <option value="">{t("rec.f.addSkill")}</option>
            {openingSkills.length > 0 && (
              <optgroup label={t("rec.f.inOpening")}>
                {openingSkills.map((s) => (
                  <option key={s} value={s} disabled={f.mustHave.includes(s)}>
                    {s}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={t("rec.f.otherSkills")}>
              {others.map((s) => (
                <option key={s} value={s} disabled={f.mustHave.includes(s)}>
                  {s}
                </option>
              ))}
            </optgroup>
          </select>
          {f.mustHave.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("rec.f.selected")}>
              {f.mustHave.map((s) => (
                <li key={s}>
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#b8d6d0] bg-teal-soft py-0.5 pl-2 pr-1 text-xs font-medium text-teal">
                    {s}
                    <button
                      type="button"
                      className="rounded-full p-0.5 hover:bg-white/60"
                      aria-label={t("rec.f.removeSkill", { skill: s })}
                      onClick={() => setF({ ...f, mustHave: f.mustHave.filter((x) => x !== s) })}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Field label={t("rec.f.minYears")} id="f-years">
          <input id="f-years" className="input" type="number" min={0} max={50} step={0.5} inputMode="decimal" value={f.minYears} onChange={(e) => setF({ ...f, minYears: e.target.value })} placeholder={t("rec.f.any")} />
        </Field>
        <Field label={t("rec.f.minScore")} id="f-score">
          <input id="f-score" className="input" type="number" min={0} max={100} step={1} inputMode="numeric" value={f.minScore} onChange={(e) => setF({ ...f, minScore: e.target.value })} placeholder={t("rec.f.any")} />
        </Field>
        <Field label={t("rec.f.stage")} id="f-stage">
          <select id="f-stage" className="input" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as FilterState["stage"] })}>
            <option value="">{t("rec.f.allStages")}</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {t(STAGE_KEY[s])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("rec.f.source")} id="f-source">
          <select id="f-source" className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as FilterState["source"] })}>
            <option value="">{t("rec.f.allSources")}</option>
            <option value="applied">{t("rec.f.applied")}</option>
            <option value="uploaded">{t("rec.f.uploaded")}</option>
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary btn-sm" type="submit">
          {t("rec.f.apply")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={activeFilterCount(f) === 0 && n === 0}
          onClick={() => {
            setF(EMPTY_FILTERS);
            onApply(EMPTY_FILTERS);
          }}
        >
          {t("rec.f.clear")}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- table

export function CandidateTable({ rows, selected, onSelect, onStage, onRemove }: {
  rows: CandidateRow[];
  selected: string[];
  onSelect: (id: string, on: boolean) => void;
  onStage: (aid: string, s: ApplicationStage) => void;
  onRemove: (row: CandidateRow) => void;
}) {
  const t = useT();
  return (
    <div className="card relative overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <caption className="sr-only">{t("rec.t.caption")}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
            <th scope="col" className="w-10 px-3 py-3 font-semibold">
              <span className="sr-only">{t("rec.t.select")}</span>
            </th>
            <th scope="col" className="px-3 py-3 font-semibold">#</th>
            <th scope="col" className="px-3 py-3 font-semibold">{t("rec.t.candidate")}</th>
            <th scope="col" className="w-44 px-3 py-3 font-semibold">{t("rec.t.score")}</th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">{t("rec.t.years")}</th>
            <th scope="col" className="px-3 py-3 font-semibold">{t("rec.t.keywords")}</th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">{t("rec.t.notes")}</th>
            <th scope="col" className="w-40 px-3 py-3 font-semibold">{t("rec.t.stage")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const on = selected.includes(c.application_id);
            return (
              <tr key={c.application_id} className={cx("border-b border-line align-top last:border-0", on && "bg-teal-soft/40")} data-testid="candidate-row">
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label={t("rec.t.compareAria", { name: c.name })}
                    checked={on}
                    disabled={!on && selected.length >= 4}
                    onChange={(e) => onSelect(c.application_id, e.target.checked)}
                  />
                </td>
                <td className="num px-3 py-3 font-semibold text-muted">{c.rank}</td>
                <td className="px-3 py-3">
                  <Link href={`/recruiter/applications/${c.application_id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  {c.email && (
                    <p className="max-w-[220px] truncate text-xs text-muted" title={c.email}>
                      {c.email}
                    </p>
                  )}
                  {c.source === "uploaded" ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <UploadedBadge expiresAt={c.expires_at} />
                      <button className="inline-flex items-center gap-1 text-[11px] font-medium text-bad hover:underline" onClick={() => onRemove(c)}>
                        <Trash2 className="h-3 w-3" aria-hidden /> {t("rec.t.remove")}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted">{t("rec.t.appliedOn", { date: fmtDate(c.applied_at) })}</p>
                  )}
                </td>
                <td className="px-3 py-3">
                  <ScoreBar score={c.score} tier={c.tier.id} label={t("rec.scoreAria", { name: c.name })} />
                  <div className="mt-1.5">
                    <TierBadge tier={c.tier} />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">
                    {t("rec.countsLine", { matched: c.counts.matched ?? 0, partial: c.counts.partial ?? 0, missing: c.counts.missing ?? 0 })}
                  </p>
                </td>
                <td className="num px-3 py-3 text-right" data-testid="years">
                  {fmtYears(c.years, t)}
                </td>
                <td className="px-3 py-3">
                  <KeywordChips matched={c.keywords_matched} missing={c.keywords_missing} limit={5} />
                </td>
                <td className="px-3 py-3 text-right">
                  <span className={cx("inline-flex items-center gap-1 text-xs", c.notes ? "font-semibold text-ink" : "text-muted")} aria-label={t("rec.t.notesAria", { count: c.notes })}>
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden /> {c.notes}
                  </span>
                </td>
                <td className="px-3 py-3">
                  <StageSelect applicationId={c.application_id} stage={c.stage} name={c.name} onChange={(s) => onStage(c.application_id, s)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- board

/** Pipeline board. Every card has a keyboard-accessible "Move to" select; drag and drop is a mouse shortcut. */
export function PipelineBoard({ rows, onStage }: { rows: CandidateRow[]; onStage: (aid: string, s: ApplicationStage) => void }) {
  const t = useT();
  const [over, setOver] = useState<ApplicationStage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function drop(e: DragEvent, stage: ApplicationStage) {
    e.preventDefault();
    setOver(null);
    const aid = e.dataTransfer.getData("text/plain");
    const row = rows.find((r) => r.application_id === aid);
    if (!row || row.stage === stage) return;
    setErr(null);
    try {
      await api(`/api/recruiter/applications/${aid}`, { method: "PATCH", body: { stage } });
      onStage(aid, stage);
    } catch (ex) {
      setErr(errMsg(ex));
    }
  }

  return (
    <div className="space-y-3">
      {err && <Alert tone="bad">{err}</Alert>}
      <p className="text-xs text-muted">{t("rec.b.help")}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(6,minmax(0,1fr))]" data-testid="pipeline-board">
        {STAGES.map((s) => {
          const items = rows.filter((r) => r.stage === s);
          return (
            <section
              key={s}
              aria-labelledby={`col-${s}`}
              data-testid={`board-col-${s}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(s);
              }}
              onDragLeave={() => setOver((o) => (o === s ? null : o))}
              onDrop={(e) => drop(e, s)}
              className={cx("flex min-h-32 flex-col rounded-lg border bg-paper-2/60 p-2", over === s ? "border-teal bg-teal-soft/50" : "border-line")}
            >
              <h3 id={`col-${s}`} className="flex items-center justify-between gap-2 px-1 pb-2 text-sm">
                <span className="min-w-0 break-words">{t(STAGE_KEY[s])}</span>
                <span className="num rounded-full bg-card px-2 text-xs text-muted">{items.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {items.map((c) => (
                  <li
                    key={c.application_id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", c.application_id)}
                    className="rounded-md border border-line bg-card p-2.5 shadow-sm"
                    data-testid="board-card"
                  >
                    <div className="flex items-start gap-1">
                      <GripVertical className="mt-0.5 hidden h-4 w-4 shrink-0 cursor-grab text-line-strong sm:block" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <Link href={`/recruiter/applications/${c.application_id}`} className="block truncate text-sm font-medium hover:underline" title={c.name}>
                          {c.name}
                        </Link>
                        <div className="mt-1">
                          <ScoreBar score={c.score} tier={c.tier.id} label={t("rec.scoreAria", { name: c.name })} />
                        </div>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                          <span>{fmtYears(c.years, t)}</span>
                          {c.notes > 0 && (
                            <span className="inline-flex items-center gap-0.5">
                              <MessageSquare className="h-3 w-3" aria-hidden /> {c.notes}
                            </span>
                          )}
                          {c.source === "uploaded" && <Badge tone="info">{t("rec.uploadedBadge")}</Badge>}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2">
                      <p className="mb-0.5 text-[11px] font-semibold text-muted" aria-hidden>
                        {t("rec.b.moveTo")}
                      </p>
                      <StageSelect applicationId={c.application_id} stage={c.stage} name={c.name} onChange={(st) => onStage(c.application_id, st)} />
                    </div>
                  </li>
                ))}
                {items.length === 0 && <li className="px-1 py-3 text-center text-xs text-muted">{t("rec.b.noOne")}</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bulk upload

export function BulkUpload({ openingId, onDone }: { openingId: string; onDone: () => void }) {
  const t = useT();
  const [files, setFiles] = useState<File[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BulkUploadResult | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [inputKey, setInputKey] = useState(0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!files.length) return setErr(t("rec.u.errFiles"));
    if (!consent) return setErr(t("rec.u.errConsent"));
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    form.append("consent_attested", "true");
    setBusy(true);
    try {
      const r = await api<BulkUploadResult>(`/api/recruiter/openings/${openingId}/bulk-upload`, { form });
      setResult(r);
      setRemoved([]);
      setFiles([]);
      setConsent(false);
      setInputKey((k) => k + 1);
      onDone();
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(false);
    }
  }

  async function remove(aid: string, name: string) {
    if (!window.confirm(t("rec.confirmRemove", { name }))) return;
    try {
      await api(`/api/recruiter/applications/${aid}`, { method: "DELETE" });
      setRemoved((r) => [...r, aid]);
      onDone();
    } catch (ex) {
      setErr(errMsg(ex));
    }
  }

  return (
    <div className="space-y-4" data-testid="bulk-upload">
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-ink-2">{t("rec.u.intro")}</p>
        <Alert tone="info" title={t("rec.u.keptTitle")}>
          {t("rec.u.keptBody")}
        </Alert>
        <div>
          <label htmlFor="bulk-files" className="label">
            {t("rec.u.files")}
          </label>
          <input
            key={inputKey}
            id="bulk-files"
            type="file"
            multiple
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-semibold"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {files.length > 0 && <p className="mt-1 text-xs text-muted">{t("rec.u.selected", { count: files.length })}</p>}
        </div>
        <label className="flex items-start gap-2 rounded-md border border-line bg-paper p-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            <strong>{t("rec.u.consent")}</strong>
            <span className="block text-xs text-muted">{t("rec.u.consentSub")}</span>
          </span>
        </label>
        {err && <Alert tone="bad">{err}</Alert>}
        <button className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? <Spinner label={t("rec.u.uploading")} /> : (<><Upload className="h-4 w-4" aria-hidden /> {t("rec.u.submit")}</>)}
        </button>
      </form>

      {result && (
        <div className="space-y-2" aria-live="polite" data-testid="bulk-results">
          <h3 className="text-base">
            {t("rec.u.results", { added: result.added.length })}
            {result.failed.length ? t("rec.u.resultsFailed", { failed: result.failed.length }) : ""}
          </h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {result.added.map((a) => (
              <li key={a.application_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="bulk-added">
                <Badge tone="ok">{t("rec.u.added")}</Badge>
                <span className="min-w-0 flex-1 break-words">
                  {removed.includes(a.application_id) ? (
                    <span className="text-muted line-through">{a.name}</span>
                  ) : (
                    <Link href={`/recruiter/applications/${a.application_id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                  )}
                  <span className="block break-all text-xs text-muted">{a.file}</span>
                </span>
                <span className="num text-sm font-semibold">{Math.round(a.score)}</span>
                <TierBadge tier={a.tier} />
                {removed.includes(a.application_id) ? (
                  <span className="text-xs text-muted">{t("rec.u.removed")}</span>
                ) : (
                  <button className="btn btn-ghost btn-sm text-bad" onClick={() => remove(a.application_id, a.name)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> {t("rec.t.remove")}
                  </button>
                )}
              </li>
            ))}
            {result.failed.map((f, i) => (
              <li key={`f${i}`} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm" data-testid="bulk-failed">
                <Badge tone="bad">{t("rec.u.failed")}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-medium">{f.file}</span>
                  <span className="text-xs text-ink-2">{f.message}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{result.note}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- notes

export function NotesPanel({ applicationId, notes, currentUserId, isAdmin, onChange }: {
  applicationId: string;
  notes: Note[];
  currentUserId: string;
  isAdmin: boolean;
  onChange: (n: Note[]) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const n = await api<Note>(`/api/recruiter/applications/${applicationId}/notes`, { body: { text } });
      onChange([...notes, n]);
      setText("");
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(false);
    }
  }
  async function del(n: Note) {
    if (!window.confirm(t("rec.n.confirmDelete"))) return;
    try {
      await api(`/api/recruiter/notes/${n.id}`, { method: "DELETE" });
      onChange(notes.filter((x) => x.id !== n.id));
    } catch (ex) {
      setErr(errMsg(ex));
    }
  }

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="notes-h" data-testid="notes">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="notes-h" className="text-xl">
          {t("rec.n.title")}
        </h2>
        <Badge tone="neutral">
          <Lock className="h-3 w-3" aria-hidden /> {t("rec.n.hrOnly")}
        </Badge>
      </div>
      <p className="mb-3 text-xs text-muted">{t("rec.n.help")}</p>
      {notes.length === 0 ? (
        <p className="text-sm text-muted">{t("rec.n.none")}</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-line bg-paper p-3 text-sm" data-testid="note">
              <p className="whitespace-pre-line break-words">{n.text}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>
                  {n.author} · {fmtDate(n.created_at)}
                </span>
                {(n.author_id === currentUserId || isAdmin) && (
                  <button className="inline-flex items-center gap-1 text-bad hover:underline" onClick={() => del(n)}>
                    <Trash2 className="h-3 w-3" aria-hidden /> {t("common.delete")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="mt-4 space-y-2" onSubmit={add}>
        <label htmlFor="note-text" className="label">
          {t("rec.n.add")}
        </label>
        <textarea id="note-text" className="input min-h-20" maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("rec.n.placeholder")} />
        {err && <Alert tone="bad">{err}</Alert>}
        <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
          {busy ? <Spinner label={t("common.saving")} /> : t("rec.n.save")}
        </button>
      </form>
    </section>
  );
}
