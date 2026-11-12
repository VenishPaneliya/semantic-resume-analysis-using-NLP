"use client";

import { FileUp, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useIsStaff } from "@/components/shell";
import { useConfirm } from "@/components/confirm";
import { Alert, Badge, Bar, Empty, EnglishNote, ErrorState, Field, fmtDate, LoadingBlock, pct, ScoreDial, Section, Spinner, useTabs } from "@/components/ui";
import { matchCountLabel, ReqRow, STATUS_TONE } from "@/components/match-breakdown";
import { api, ApiError, errMsg, uploadWithProgress } from "@/lib/api";
import { fileErrorMessage } from "@/lib/labels";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { JD, MatchResult } from "@/lib/types";
import { useResume } from "../context";


const MODES = ["paste", "upload"] as const;

export default function MatchPage() {
  const t = useT();
  const confirm = useConfirm();
  const { versionId } = useResume();
  const jds = useApi<JD[]>("/api/job-descriptions");
  const [mode, setMode] = useState<"paste" | "upload">("paste");
  const modeTabs = useTabs(MODES, mode, setMode, "jd");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [matching, setMatching] = useState<string | null>(null);
  const [matchErr, setMatchErr] = useState<string | null>(null);

  if (!versionId) return <Empty level={2} title={t("resume.confirmFirst")} />;

  async function runMatch(jdId: string) {
    setMatching(jdId);
    setMatchErr(null);
    try {
      setResult(await api<MatchResult>(`/api/job-descriptions/${jdId}/match/${versionId}`, { method: "POST" }));
    } catch (e) {
      setMatchErr(errMsg(e));
    } finally {
      setMatching(null);
    }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setCreating(true);
    setCreateErr(null);
    try {
      let jd: JD;
      if (mode === "paste") {
        jd = await api<JD>("/api/job-descriptions", {
          body: { text: f.get("text"), title: f.get("title") || null, company: f.get("company") || null },
        });
      } else {
        const file = f.get("file") as File;
        if (!file?.size) throw new Error(t("match.chooseFile"));
        const form = new FormData();
        form.append("file", file);
        if (f.get("title")) form.append("title", String(f.get("title")));
        jd = await uploadWithProgress<JD>("/api/job-descriptions/upload", form, () => {});
      }
      jds.setData([jd, ...(jds.data ?? [])]);
      (e.target as HTMLFormElement).reset();
      await runMatch(jd.id);
    } catch (err) {
      setCreateErr(err instanceof ApiError ? fileErrorMessage(t, err.code, err.message) : errMsg(err));
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!(await confirm({ title: t("match.deleteConfirm") }))) return;
    await api(`/api/job-descriptions/${id}`, { method: "DELETE" });
    jds.setData((jds.data ?? []).filter((j) => j.id !== id));
    if (result?.jd.id === id) setResult(null);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="space-y-5">
        <Section title={t("match.add")} id="add-jd">
          <div role="tablist" aria-label={t("match.inputMethod")} className="mb-4 flex gap-1 rounded-md bg-paper-2 p-1">
            {MODES.map((m) => (
              <button
                key={m}
                {...modeTabs.tab(m)}
                className="flex-1 rounded px-2 py-1 text-sm font-medium text-ink-2 aria-selected:bg-card aria-selected:text-ink aria-selected:shadow-sm"
              >
                {m === "paste" ? t("match.paste") : t("match.upload")}
              </button>
            ))}
          </div>
          <form className="space-y-3" onSubmit={create} {...modeTabs.panel(mode)}>
            {createErr && <Alert tone="bad">{createErr}</Alert>}
            <Field label={t("match.titleOpt")} id="jd-title">
              <input className="input" id="jd-title" name="title" maxLength={200} />
            </Field>
            {mode === "paste" ? (
              <>
                <Field label={t("match.companyOpt")} id="jd-company">
                  <input className="input" id="jd-company" name="company" maxLength={200} />
                </Field>
                <Field label={t("match.jd")} id="jd-text" hint={t("match.jdHint")}>
                  <textarea className="input min-h-48" id="jd-text" name="text" minLength={40} maxLength={30000} required />
                </Field>
              </>
            ) : (
              <Field label={t("match.file")} id="jd-file">
                <input className="input" id="jd-file" name="file" type="file" accept=".pdf,.docx" required />
              </Field>
            )}
            <button className="btn btn-primary w-full justify-center" disabled={creating}>
              {creating ? <Spinner label={t("match.extracting")} /> : (<><FileUp className="h-4 w-4" aria-hidden /> {t("match.addCompare")}</>)}
            </button>
          </form>
        </Section>
        <Section title={t("match.saved")} id="saved">
          {jds.loading && !jds.data ? (
            <LoadingBlock />
          ) : jds.error ? (
            <ErrorState message={jds.error} onRetry={jds.reload} />
          ) : !jds.data?.length ? (
            <p className="text-sm text-muted">{t("match.noneYet")}</p>
          ) : (
            <ul className="space-y-2">
              {jds.data.map((j) => (
                <li key={j.id} className={`flex items-center gap-2 rounded-md border p-2 ${result?.jd.id === j.id ? "border-teal bg-teal-soft" : "border-line"}`}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => runMatch(j.id)} disabled={!!matching}>
                    <p className="truncate text-sm font-medium">{j.title}</p>
                    <p className="text-xs text-muted">
                      {j.company ? `${j.company} · ` : ""}
                      {fmtDate(j.created_at)}
                    </p>
                  </button>
                  {matching === j.id && <Spinner label="" />}
                  <button className="btn btn-ghost btn-sm" aria-label={t("dash.deleteAria", { title: j.title })} onClick={() => remove(j.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </aside>

      <div className="space-y-5" aria-live="polite">
        {matchErr && <ErrorState message={matchErr} />}
        {!result && !matching && <Empty title={t("match.emptyTitle")}>{t("match.emptyBody")}</Empty>}
        {matching && !result && <LoadingBlock label={t("match.comparing")} />}
        {result && <MatchView m={result} />}
      </div>
    </div>
  );
}

function MatchView({ m }: { m: MatchResult }) {
  const t = useT();
  const staff = useIsStaff();
  const ex = m.jd.extracted;
  return (
    <>
      <EnglishNote />
      {m.jd_warnings.includes("embedded_instructions_detected") && (
        <Alert tone="warn" title={t("match.instructionsTitle")}>
          {t("match.instructionsBody")}
        </Alert>
      )}
      <div className="card rise grid gap-5 p-5 sm:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center">
          <ScoreDial value={m.overall} size={116} label={t("mb.compat")} />
        </div>
        <div>
          <h2 className="text-2xl">{m.jd.title}</h2>
          <p className="text-sm text-ink-2">
            {[m.jd.company, ex.location, ex.work_arrangement, ex.years_required != null ? t("match.years", { n: ex.years_required }) : null].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-2 text-xs text-muted">{m.overall_label}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(m.counts) as (keyof typeof m.counts)[]).map((k) => (
              <Badge key={k} tone={STATUS_TONE[k]}>
                {matchCountLabel(t, k, m.counts[k])}
              </Badge>
            ))}
          </div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            {[
              [t("mb.reqCoverage"), m.components.requirement_coverage],
              [t("mb.kwCoverage"), m.components.keyword_coverage],
              [t("mb.semantic"), m.components.semantic_alignment],
            ].map(([k, v]) => (
              <div key={k as string}>
                <dt className="flex justify-between gap-2">
                  <span>{k}</span>
                  <span className="num">{pct(v as number | null)}</span>
                </dt>
                <dd className="mt-1">
                  <Bar value={(v as number | null) ?? 0} label={k as string} />
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            {t.rich("match.expLineUser", { b: (c) => <strong>{c}</strong> }, { value: m.components.experience_alignment.replace("_", " ") })}
          </p>
          {/* the scoring formula and model name are for staff checking the system, not for candidates */}
          {staff && (
            <p className="mt-1 num text-[11px] text-muted">
              {m.formula} · {m.embedding_model} · {m.matcher_version}
            </p>
          )}
        </div>
      </div>

      <Section title={t("mb.reqs")} id="reqs">
        <ul className="divide-y divide-line">
          {m.requirements.map((r) => (
            <ReqRow key={r.id} r={r} />
          ))}
        </ul>
      </Section>

      <div className="grid gap-5 md:grid-cols-2">
        <Section title={t("mb.gaps")} id="gaps">
          {m.genuine_gaps.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm">{m.genuine_gaps.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">{t("mb.noneIdentified")}</p>
          )}
          <p className="mt-3 text-xs text-muted">{t("match.gapsNote")}</p>
        </Section>
        <Section title={t("match.mayHave")} id="unlisted">
          {m.possibly_unlisted.length ? (
            <ul className="list-disc space-y-1 pl-4 text-sm">{m.possibly_unlisted.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : (
            <p className="text-sm text-muted">{t("mb.noneIdentified")}</p>
          )}
          <p className="mt-3 text-xs text-muted">{t("match.mayHaveNote")}</p>
        </Section>
      </div>
      <Alert tone="info" title={t("match.noStuffing")}>
        {m.guidance}
      </Alert>
    </>
  );
}
