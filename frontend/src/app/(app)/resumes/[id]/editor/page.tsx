"use client";

import { ArrowDown, ArrowUp, CopyPlus, Download, GitCompareArrows, History, RotateCcw, Save, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { ContentForm, SECTION_LABEL_KEY } from "@/components/content-form";
import { DiffView, ResumePreview } from "@/components/preview";
import { SuggestionCard } from "@/components/suggestion-card";
import { WhatIfPanel } from "@/components/what-if";
import { Alert, Badge, Empty, EnglishNote, ErrorState, Field, fmtDate, LiveRegion, LoadingBlock, Spinner, useTabs } from "@/components/ui";
import { categoryName, roleTitle } from "@/lib/labels";
import { api, ApiError, downloadSigned, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { Bullet, Compare, ExportRow, JD, ResumeContent, Role, Suggestion, Template, Version } from "@/lib/types";
import { useResume } from "../context";

type Panel = "preview" | "suggestions" | "history" | "export";
const PANELS: readonly Panel[] = ["preview", "suggestions", "history", "export"];
type Op = "rewrite_bullet" | "grammar" | "shorten" | "tone" | "tailor" | "improve_summary";
type Tone = "confident" | "formal" | "concise" | "friendly";
const TONES: Tone[] = ["confident", "formal", "concise", "friendly"];
const SOURCE_KEY: Record<string, MessageKey> = {
  extracted: "editor.source.extracted",
  user_edit: "editor.source.user_edit",
  ai_accepted: "editor.source.ai_accepted",
  restore: "editor.source.restore",
};

export default function EditorPage() {
  const t = useT();
  const { resume, versionId, reload } = useResume();
  const [version, setVersion] = useState<Version | null>(null);
  const [draft, setDraft] = useState<ResumeContent | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("preview");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<{ code: string; message: string } | null>(null);
  const [tone, setTone] = useState<Tone>("confident");
  const [tailor, setTailor] = useState<{ kind: "role" | "jd"; id: string }>({ kind: "role", id: resume.target_role ?? "" });
  const [template, setTemplate] = useState("professional");
  const [live, setLive] = useState("");
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles", [], { static: true });
  const jds = useApi<JD[]>("/api/job-descriptions");
  const tabs = useTabs(PANELS, panel, setPanel, "ed");

  const loadVersion = useCallback(async (vid: string) => {
    setLoadErr(null);
    try {
      const v = await api<Version>(`/api/versions/${vid}`);
      setVersion(v);
      setDraft(v.content);
      const s = await api<Suggestion[]>(`/api/versions/${vid}/suggestions`);
      setSuggestions(s.filter((x) => x.status === "pending" || x.status === "needs_facts"));
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    if (versionId) void loadVersion(versionId);
  }, [versionId, loadVersion]);

  const dirty = useMemo(() => !!(version && draft && JSON.stringify(version.content) !== JSON.stringify(draft)), [version, draft]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  if (!versionId) return <Empty level={2} title={t("resume.confirmFirst")} />;
  if (loadErr) return <ErrorState message={loadErr} onRetry={() => loadVersion(versionId)} />;
  if (!version || !draft) return <LoadingBlock label={t("editor.loading")} />;

  async function save() {
    if (!version || !draft) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const v = await api<Version>(`/api/resumes/${resume.id}/versions`, { body: { base_version_id: version.id, content: draft, label: "Manual edit" } });
      setVersion(v);
      setDraft(v.content);
      setLive(t("editor.savedAs", { n: v.number }));
      await reload();
    } catch (e) {
      setSaveErr(e instanceof ApiError && e.code === "stale_version" ? `${e.message} ${t("editor.staleHint")}` : errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function suggest(op: Op, path: string) {
    if (dirty) {
      setAiErr({ code: "unsaved", message: t("editor.saveFirst") });
      return;
    }
    const body: Record<string, unknown> = { operation: op, target_path: path };
    if (op === "tone") body.tone = tone;
    if (op === "tailor") {
      if (!tailor.id) {
        setAiErr({ code: "missing_target", message: t("editor.chooseTailor") });
        return;
      }
      if (tailor.kind === "role") body.target_role = tailor.id;
      else body.jd_id = tailor.id;
    }
    setBusyPath(path + op);
    setAiErr(null);
    setLive(t("editor.generating"));
    try {
      const s = await api<Suggestion>(`/api/versions/${version!.id}/suggestions`, { body });
      setSuggestions((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      setPanel("suggestions");
      setLive(t("editor.readyLive"));
    } catch (e) {
      const err = e instanceof ApiError ? { code: e.code, message: e.message } : { code: "error", message: errMsg(e) };
      setAiErr(err);
      setLive(t("editor.failedLive"));
    } finally {
      setBusyPath(null);
    }
  }

  const pendingPaths = new Set(suggestions.flatMap((s) => (s.target_path.includes("/bullets/") || s.target_path === "summary" ? [s.target_path] : s.items.map((i) => `${s.target_path}/${i.target_id}`))));

  const bulletActions = (path: string, b: Bullet) => (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("editor.aiTools")}>
      {(
        [
          ["rewrite_bullet", t("editor.op.rewrite")],
          ["grammar", t("editor.op.grammar")],
          ["shorten", t("editor.op.shorten")],
          ["tone", t("editor.op.tone", { tone: t(`editor.tone.${tone}` as const) })],
          ["tailor", t("editor.op.tailor")],
        ] as [Op, string][]
      ).map(([op, label]) => (
        <button
          key={op}
          type="button"
          className="btn btn-ai btn-sm !px-2 !py-0.5 !text-[11px]"
          disabled={!!busyPath || !b.text.trim()}
          onClick={() => suggest(op, path)}
        >
          {busyPath === path + op ? <Spinner label="" /> : op === "rewrite_bullet" ? <Wand2 className="h-3 w-3" aria-hidden /> : null}
          {label}
        </button>
      ))}
      {pendingPaths.has(path) && <Badge tone="ai">{t("editor.pending")}</Badge>}
    </div>
  );

  const summaryActions = (
    <div className="mt-2 flex flex-wrap gap-1">
      <button type="button" className="btn btn-ai btn-sm" disabled={!!busyPath} onClick={() => suggest("improve_summary", "summary")}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> {draft.summary ? t("editor.improveSummary") : t("editor.draftSummary")}
      </button>
      {draft.summary && (
        <button type="button" className="btn btn-ai btn-sm" disabled={!!busyPath} onClick={() => suggest("grammar", "summary")}>
          {t("editor.op.grammar")}
        </button>
      )}
      {draft.summary && (
        <button type="button" className="btn btn-ai btn-sm" disabled={!!busyPath} onClick={() => suggest("shorten", "summary")}>
          {t("editor.op.shorten")}
        </button>
      )}
    </div>
  );

  function moveSection(i: number, d: -1 | 1) {
    const order = [...draft!.section_order];
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setDraft({ ...draft!, section_order: order });
  }

  return (
    <div>
      <LiveRegion message={live} />
      <div className="card sticky top-16 z-20 mb-5 flex flex-wrap items-center gap-3 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Badge tone="teal">v{version.number}</Badge>
          <span className="min-w-0 truncate text-muted">{version.label ?? (SOURCE_KEY[version.source] ? t(SOURCE_KEY[version.source]) : version.source)}</span>
          {dirty && <Badge tone="warn">{t("editor.unsaved")}</Badge>}
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor="tone" className="sr-only">
            {t("editor.toneLabel")}
          </label>
          <select id="tone" className="input w-auto max-w-full !py-1 text-xs" value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
            {TONES.map((x) => (
              <option key={x} value={x}>
                {t("editor.op.tone", { tone: t(`editor.tone.${x}` as const) })}
              </option>
            ))}
          </select>
          <label htmlFor="tailor" className="sr-only">
            {t("editor.tailorTo")}
          </label>
          <select
            id="tailor"
            className="input w-auto max-w-[220px] !py-1 text-xs"
            value={`${tailor.kind}:${tailor.id}`}
            onChange={(e) => {
              const [kind, ...rest] = e.target.value.split(":");
              setTailor({ kind: kind as "role" | "jd", id: rest.join(":") });
            }}
          >
            <option value="role:">{t("editor.tailorChoose")}</option>
            <optgroup label={t("editor.rolesGroup")}>
              {roles.data?.roles.map((r) => (
                <option key={r.id} value={`role:${r.id}`}>
                  {roleTitle(t, r.id, r.title)}
                </option>
              ))}
            </optgroup>
            {jds.data && jds.data.length > 0 && (
              <optgroup label={t("editor.jdGroup")}>
                {jds.data.map((j) => (
                  <option key={j.id} value={`jd:${j.id}`}>
                    {j.title}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn btn-secondary btn-sm" disabled={!dirty || saving} onClick={() => setDraft(version.content)}>
            {t("editor.discard")}
          </button>
          <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
            {saving ? <Spinner label={t("common.saving")} /> : (<><Save className="h-4 w-4" aria-hidden /> {t("editor.saveVersion")}</>)}
          </button>
        </div>
      </div>

      {saveErr && <div className="mb-4"><Alert tone="bad" title={t("editor.notSaved")}>{saveErr}</Alert></div>}
      {aiErr && (
        <div className="mb-4">
          <Alert tone={aiErr.code === "ai_consent_required" ? "warn" : "bad"} title={t("editor.aiUnavailable")} action={<button className="btn btn-ghost btn-sm" onClick={() => setAiErr(null)}>{t("common.dismiss")}</button>}>
            {aiErr.message}{" "}
            {aiErr.code === "ai_consent_required" && <Link href="/settings#privacy">{t("editor.reviewPrivacy")}</Link>}
            {["provider_busy", "provider_unreachable", "invalid_ai_output"].includes(aiErr.code) && ` ${t("editor.tryShortly")}`}
          </Alert>
        </div>
      )}

      <WhatIfPanel versionId={version.id} draft={draft} dirty={dirty} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        <div>
          <p className="mb-3 text-xs text-muted">
            {t.rich("editor.intro", { amber: (c) => <span className="rounded bg-ai-soft px-1 text-ai">{c}</span> })}
          </p>
          <ContentForm value={draft} onChange={setDraft} bulletActions={bulletActions} summaryActions={summaryActions} highlight={(p) => pendingPaths.has(p)} idPrefix="ed" />
        </div>

        <div className="xl:sticky xl:top-36 xl:self-start">
          <div role="tablist" aria-label={t("editor.panels")} className="mb-3 flex flex-wrap gap-1 rounded-md bg-paper-2 p-1">
            {(
              [
                ["preview", t("editor.tab.preview")],
                ["suggestions", t("editor.tab.ai", { count: suggestions.length })],
                ["history", t("editor.tab.history")],
                ["export", t("editor.tab.export")],
              ] as [Panel, string][]
            ).map(([p, l]) => (
              <button key={p} {...tabs.tab(p)} className="flex-1 whitespace-nowrap rounded px-2 py-1.5 text-sm font-medium text-ink-2 aria-selected:bg-card aria-selected:text-ink aria-selected:shadow-sm">
                {l}
              </button>
            ))}
          </div>
          {/* only the wide two-column layout needs its own scroll area; below that the panel uses the page height */}
          <div {...tabs.panel(panel)} className="rounded-lg xl:max-h-[calc(100vh-12rem)] xl:overflow-y-auto">
            {panel === "preview" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <label className="label" htmlFor="prev-tpl">
                      {t("editor.previewTemplate")}
                    </label>
                    <select id="prev-tpl" className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
                      <option value="student">{t("editor.tpl.student")}</option>
                      <option value="professional">{t("editor.tpl.professional")}</option>
                      <option value="technical">{t("editor.tpl.technical")}</option>
                    </select>
                  </div>
                </div>
                {/* section order is used now and then: folded away so the preview gets the space */}
                <details className="card group p-3" data-testid="section-order">
                  <summary className="cursor-pointer text-sm font-semibold">{t("editor.sectionOrder")}</summary>
                  <ol className="mt-2 space-y-1">
                    {draft.section_order.map((k, i) => (
                      <li key={k} className="flex items-center justify-between rounded border border-line bg-paper px-2 py-1 text-sm">
                        <span>
                          <span className="num mr-2 text-xs text-muted">{i + 1}</span>
                          {t(SECTION_LABEL_KEY[k])}
                        </span>
                        <span className="shrink-0">
                          <button className="btn btn-ghost btn-sm !p-1" aria-label={t("form.moveUp", { name: t(SECTION_LABEL_KEY[k]) })} disabled={i === 0} onClick={() => moveSection(i, -1)}>
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <button className="btn btn-ghost btn-sm !p-1" aria-label={t("form.moveDown", { name: t(SECTION_LABEL_KEY[k]) })} disabled={i === draft.section_order.length - 1} onClick={() => moveSection(i, 1)}>
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
                <EnglishNote kind="resume" />
                <div className="rounded-lg bg-paper-2 p-3">
                  <ResumePreview c={draft} template={template} />
                </div>
              </div>
            )}
            {panel === "suggestions" && (
              <div className="space-y-3">
                {suggestions.length === 0 ? (
                  <Empty icon={<Sparkles className="h-7 w-7" />} title={t("editor.noPending")}>
                    {t("editor.noPendingBody")}
                  </Empty>
                ) : (
                  <>
                  <EnglishNote kind="generic" />
                  {suggestions.map((s) => (
                    <SuggestionCard
                      key={s.id}
                      s={s}
                      onResolved={async (r) => {
                        setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
                        if (r.accepted && r.versionId) {
                          setLive(t("editor.acceptedLive"));
                          await reload();
                          await loadVersion(r.versionId);
                        } else setLive(t("editor.rejectedLive"));
                      }}
                    />
                  ))}
                  </>
                )}
              </div>
            )}
            {panel === "history" && <HistoryPanel resumeId={resume.id} current={version} onRestored={async (vid) => { await reload(); await loadVersion(vid); }} />}
            {panel === "export" && <ExportPanel resumeId={resume.id} dirty={dirty} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({ resumeId, current, onRestored }: { resumeId: string; current: Version; onRestored: (vid: string) => Promise<void> }) {
  const t = useT();
  const confirm = useConfirm();
  const router = useRouter();
  const { data, error, loading, reload } = useApi<Version[]>(`/api/resumes/${resumeId}/versions`, [current.id]);
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles", [], { static: true });
  const [sel, setSel] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [variant, setVariant] = useState({ title: "", role: "" });

  async function restore(v: Version) {
    if (!(await confirm({ title: t("editor.restoreConfirm", { n: v.number }), confirmLabel: t("editor.restore"), tone: "default" }))) return;
    setBusy(v.id);
    try {
      const nv = await api<Version>(`/api/versions/${v.id}/restore`, { method: "POST" });
      await onRestored(nv.id);
      await reload();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  async function compare() {
    if (sel.length !== 2) return;
    setBusy("cmp");
    try {
      const [a, b] = [...sel].sort((x, y) => (data!.find((v) => v.id === x)!.number - data!.find((v) => v.id === y)!.number));
      setCmp(await api<Compare>(`/api/versions/${a}/compare/${b}`));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  async function createVariant() {
    setBusy("variant");
    try {
      const r = await api<{ id: string }>(`/api/resumes/${resumeId}/variants`, {
        body: { title: variant.title || "Targeted version", target_role: variant.role || null, from_version_id: current.id },
      });
      router.push(`/resumes/${r.id}/editor`);
    } catch (e) {
      setErr(errMsg(e));
      setBusy(null);
    }
  }

  if (loading && !data) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <div className="space-y-4">
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-semibold">
            <History className="h-4 w-4" aria-hidden /> {t("editor.versions")}
          </p>
          <button className="btn btn-secondary btn-sm" disabled={sel.length !== 2 || busy === "cmp"} onClick={compare}>
            <GitCompareArrows className="h-4 w-4" aria-hidden /> {t("editor.compare2")}
          </button>
        </div>
        <p className="mb-2 text-xs text-muted">{t("editor.appendOnly")}</p>
        <ul className="space-y-1.5">
          {data?.map((v) => (
            <li key={v.id} className="flex items-center gap-2 rounded border border-line bg-paper px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                aria-label={t("editor.selectVersion", { n: v.number })}
                checked={sel.includes(v.id)}
                onChange={(e) => setSel((s) => (e.target.checked ? [...s, v.id].slice(-2) : s.filter((x) => x !== v.id)))}
              />
              <span className="num w-8 font-semibold">v{v.number}</span>
              <span className="min-w-0 flex-1 truncate">
                {v.label ?? (SOURCE_KEY[v.source] ? t(SOURCE_KEY[v.source]) : v.source)}
                <span className="block text-[11px] text-muted">
                  {fmtDate(v.created_at)} · {SOURCE_KEY[v.source] ? t(SOURCE_KEY[v.source]) : v.source.replace("_", " ")}
                </span>
              </span>
              {v.source === "ai_accepted" && <Badge tone="ai">AI</Badge>}
              {v.is_latest ? (
                <Badge tone="teal">{t("editor.current")}</Badge>
              ) : (
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => restore(v)}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {t("editor.restore")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {cmp && (
        <div className="card p-4">
          <p className="font-semibold">
            v{cmp.a.number} → v{cmp.b.number}
          </p>
          <p className="mt-1 text-sm">
            {t("editor.overallLine")} <span className="num">{cmp.overall.a ?? "—"}</span> → <span className="num font-semibold">{cmp.overall.b ?? "—"}</span>
          </p>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {cmp.categories.map((c) => (
                <tr key={c.id} className="border-b border-line">
                  <td className="py-1">{categoryName(t, c.id, c.name)}</td>
                  <td className="num py-1 text-right">{c.a ?? "—"}</td>
                  <td className="num py-1 text-right">{c.b ?? "—"}</td>
                  <td className={`num py-1 text-right ${c.delta && c.delta > 0 ? "text-ok" : c.delta && c.delta < 0 ? "text-bad" : "text-muted"}`}>
                    {c.delta == null ? "" : c.delta > 0 ? `+${c.delta}` : c.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="label mt-3">{t("editor.contentChanges", { count: cmp.changes.length })}</p>
          <ul className="space-y-2">
            {cmp.changes.map((ch, i) => (
              <li key={i} className="rounded bg-paper p-2 text-xs">
                <p className="num text-muted">{ch.path}</p>
                {ch.diff ? <DiffView ops={ch.diff} /> : ch.change ? <p>{ch.change}</p> : ch.added || ch.removed ? (
                  <p>
                    {ch.added?.length ? t("editor.added", { list: ch.added.join(", ") }) : ""}
                    {ch.removed?.length ? t("editor.removed", { list: ch.removed.join(", ") }) : ""}
                  </p>
                ) : (
                  <p>{JSON.stringify(ch.before)} → {JSON.stringify(ch.after)}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="card p-4">
        <p className="flex items-center gap-1.5 font-semibold">
          <CopyPlus className="h-4 w-4" aria-hidden /> {t("editor.createVariant")}
        </p>
        <p className="mt-1 text-xs text-muted">{t("editor.variantBody", { n: current.number })}</p>
        <div className="mt-3 grid gap-2">
          <Field label={t("editor.variantName")} id="var-title">
            <input id="var-title" className="input" value={variant.title} onChange={(e) => setVariant({ ...variant, title: e.target.value })} placeholder={t("editor.variantPlaceholder")} />
          </Field>
          <Field label={t("editor.targetRoleOpt")} id="var-role">
            <select id="var-role" className="input" value={variant.role} onChange={(e) => setVariant({ ...variant, role: e.target.value })}>
              <option value="">{t("common.none")}</option>
              {roles.data?.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleTitle(t, r.id, r.title)}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-secondary btn-sm justify-self-start" disabled={busy === "variant"} onClick={createVariant}>
            {busy === "variant" ? <Spinner label={t("editor.creating")} /> : t("editor.createVariantBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportPanel({ resumeId, dirty }: { resumeId: string; dirty: boolean }) {
  const t = useT();
  const templates = useApi<Template[]>("/api/templates", [], { static: true });
  const [opts, setOpts] = useState({ format: "pdf", template: "professional", page_size: "A4" });
  const [exp, setExp] = useState<ExportRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setErr(null);
    setExp(null);
    try {
      let e = await api<ExportRow>(`/api/resumes/${resumeId}/exports`, { body: opts });
      for (let i = 0; i < 40 && e.status !== "ready" && e.status !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        e = await api<ExportRow>(`/api/exports/${e.id}`);
      }
      setExp(e);
      if (e.status === "failed") setErr(e.error_message ?? t("editor.exportFailed"));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4 p-4">
      {dirty && <Alert tone="warn">{t.rich("editor.unsavedExport", { em: (c) => <em>{c}</em> })}</Alert>}
      <fieldset>
        <legend className="label">{t("editor.template")}</legend>
        <div className="grid gap-2">
          {(templates.data ?? []).map((tpl) => (
            <label key={tpl.id} className={`flex cursor-pointer gap-2 rounded border p-2 text-sm ${opts.template === tpl.id ? "border-teal bg-teal-soft" : "border-line"}`}>
              <input type="radio" name="tpl" value={tpl.id} checked={opts.template === tpl.id} onChange={() => setOpts({ ...opts, template: tpl.id })} />
              <span>
                <span className="font-medium">{tpl.name}</span>
                <span className="block text-xs text-muted">{tpl.description}</span>
              </span>
            </label>
          ))}
          {templates.error && <ErrorState message={templates.error} onRetry={templates.reload} />}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("editor.format")} id="fmt">
          <select id="fmt" className="input" value={opts.format} onChange={(e) => setOpts({ ...opts, format: e.target.value })}>
            <option value="pdf">PDF</option>
            <option value="docx">{t("editor.word")}</option>
          </select>
        </Field>
        <Field label={t("editor.pageSize")} id="ps">
          <select id="ps" className="input" value={opts.page_size} onChange={(e) => setOpts({ ...opts, page_size: e.target.value })}>
            <option value="A4">A4</option>
            <option value="LETTER">{t("editor.letter")}</option>
          </select>
        </Field>
      </div>
      <button className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? <Spinner label={t("editor.generatingShort")} /> : (<><Download className="h-4 w-4" aria-hidden /> {t("editor.generateExport")}</>)}
      </button>
      <div aria-live="polite">
        {err && <ErrorState message={err} onRetry={run} />}
        {exp?.status === "ready" && (
          <div className="space-y-3">
            {exp.unresolved_placeholders.length > 0 && (
              <Alert tone="warn" title={t("editor.placeholders", { count: exp.unresolved_placeholders.length })}>
                {t("editor.placeholdersBody")}
                <ul className="mt-1 list-disc pl-4">
                  {exp.unresolved_placeholders.map((p, i) => (
                    <li key={i}>{p.placeholder}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <Alert tone="ok" title={t("editor.exportReady")} action={<button className="btn btn-primary btn-sm" onClick={() => downloadSigned(`/api/exports/${exp.id}/link`)}>{t("common.download")}</button>}>
              {exp.format.toUpperCase()} · {exp.template} · {exp.page_size}
              {exp.page_count ? ` · ${t("common.pages", { count: exp.page_count })}` : ""}. {t("editor.linkExpires")}
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
