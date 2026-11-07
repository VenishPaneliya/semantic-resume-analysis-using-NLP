"use client";

import { ArrowDown, ArrowUp, CopyPlus, Download, GitCompareArrows, History, RotateCcw, Save, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContentForm, SECTION_LABEL } from "@/components/content-form";
import { DiffView, ResumePreview } from "@/components/preview";
import { SuggestionCard } from "@/components/suggestion-card";
import { Alert, Badge, Empty, ErrorState, Field, fmtDate, LiveRegion, LoadingBlock, Spinner } from "@/components/ui";
import { api, ApiError, downloadSigned, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Bullet, Compare, ExportRow, JD, ResumeContent, Role, Suggestion, Template, Version } from "@/lib/types";
import { useResume } from "../context";

type Panel = "preview" | "suggestions" | "history" | "export";
type Op = "rewrite_bullet" | "grammar" | "shorten" | "tone" | "tailor" | "improve_summary";

export default function EditorPage() {
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
  const [tone, setTone] = useState<"confident" | "formal" | "concise" | "friendly">("confident");
  const [tailor, setTailor] = useState<{ kind: "role" | "jd"; id: string }>({ kind: "role", id: resume.target_role ?? "" });
  const [template, setTemplate] = useState("professional");
  const [live, setLive] = useState("");
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const jds = useApi<JD[]>("/api/job-descriptions");

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

  if (!versionId) return <Empty title="Confirm the extraction first" />;
  if (loadErr) return <ErrorState message={loadErr} onRetry={() => loadVersion(versionId)} />;
  if (!version || !draft) return <LoadingBlock label="Loading editor…" />;

  async function save() {
    if (!version || !draft) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const v = await api<Version>(`/api/resumes/${resume.id}/versions`, { body: { base_version_id: version.id, content: draft, label: "Manual edit" } });
      setVersion(v);
      setDraft(v.content);
      setLive(`Saved as version ${v.number}.`);
      await reload();
    } catch (e) {
      setSaveErr(e instanceof ApiError && e.code === "stale_version" ? `${e.message} Your unsaved edits are still on screen; copy anything you need first.` : errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function suggest(op: Op, path: string) {
    if (dirty) {
      setAiErr({ code: "unsaved", message: "Save your manual edits first — AI suggestions are made against a saved version." });
      return;
    }
    const body: Record<string, unknown> = { operation: op, target_path: path };
    if (op === "tone") body.tone = tone;
    if (op === "tailor") {
      if (!tailor.id) {
        setAiErr({ code: "missing_target", message: "Choose a role or job description to tailor to (toolbar above)." });
        return;
      }
      if (tailor.kind === "role") body.target_role = tailor.id;
      else body.jd_id = tailor.id;
    }
    setBusyPath(path + op);
    setAiErr(null);
    setLive("Generating AI suggestion…");
    try {
      const s = await api<Suggestion>(`/api/versions/${version!.id}/suggestions`, { body });
      setSuggestions((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
      setPanel("suggestions");
      setLive("AI suggestion ready for review. It has not been applied.");
    } catch (e) {
      const err = e instanceof ApiError ? { code: e.code, message: e.message } : { code: "error", message: errMsg(e) };
      setAiErr(err);
      setLive("AI suggestion failed.");
    } finally {
      setBusyPath(null);
    }
  }

  const pendingPaths = new Set(suggestions.flatMap((s) => (s.target_path.includes("/bullets/") || s.target_path === "summary" ? [s.target_path] : s.items.map((i) => `${s.target_path}/${i.target_id}`))));

  const bulletActions = (path: string, b: Bullet) => (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="AI tools for this bullet">
      {(
        [
          ["rewrite_bullet", "Rewrite"],
          ["grammar", "Grammar"],
          ["shorten", "Shorten"],
          ["tone", `Tone: ${tone}`],
          ["tailor", "Tailor"],
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
      {pendingPaths.has(path) && <Badge tone="ai">suggestion pending</Badge>}
    </div>
  );

  const summaryActions = (
    <div className="mt-2 flex flex-wrap gap-1">
      <button type="button" className="btn btn-ai btn-sm" disabled={!!busyPath} onClick={() => suggest("improve_summary", "summary")}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> {draft.summary ? "Improve summary" : "Draft a summary from my facts"}
      </button>
      {draft.summary && (
        <button type="button" className="btn btn-ai btn-sm" disabled={!!busyPath} onClick={() => suggest("grammar", "summary")}>
          Grammar
        </button>
      )}
      {draft.summary && (
        <button type="button" className="btn btn-ai btn-sm" disabled={!!busyPath} onClick={() => suggest("shorten", "summary")}>
          Shorten
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
        <div className="flex items-center gap-2 text-sm">
          <Badge tone="teal">v{version.number}</Badge>
          <span className="text-muted">{version.label ?? version.source}</span>
          {dirty && <Badge tone="warn">Unsaved changes</Badge>}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label htmlFor="tone" className="sr-only">
            Tone
          </label>
          <select id="tone" className="input w-auto !py-1 text-xs" value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
            {["confident", "formal", "concise", "friendly"].map((t) => (
              <option key={t} value={t}>
                Tone: {t}
              </option>
            ))}
          </select>
          <label htmlFor="tailor" className="sr-only">
            Tailor to
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
            <option value="role:">Tailor to… (choose)</option>
            <optgroup label="Roles">
              {roles.data?.roles.map((r) => (
                <option key={r.id} value={`role:${r.id}`}>
                  {r.title}
                </option>
              ))}
            </optgroup>
            {jds.data && jds.data.length > 0 && (
              <optgroup label="Job descriptions">
                {jds.data.map((j) => (
                  <option key={j.id} value={`jd:${j.id}`}>
                    {j.title}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn btn-secondary btn-sm" disabled={!dirty || saving} onClick={() => setDraft(version.content)}>
            Discard
          </button>
          <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
            {saving ? <Spinner label="Saving" /> : (<><Save className="h-4 w-4" aria-hidden /> Save version</>)}
          </button>
        </div>
      </div>

      {saveErr && <div className="mb-4"><Alert tone="bad" title="Not saved">{saveErr}</Alert></div>}
      {aiErr && (
        <div className="mb-4">
          <Alert tone={aiErr.code === "ai_consent_required" ? "warn" : "bad"} title="AI suggestion unavailable" action={<button className="btn btn-ghost btn-sm" onClick={() => setAiErr(null)}>Dismiss</button>}>
            {aiErr.message}{" "}
            {aiErr.code === "ai_consent_required" && <Link href="/settings#privacy">Review AI privacy settings</Link>}
            {["provider_busy", "provider_unreachable", "invalid_ai_output"].includes(aiErr.code) && " Your resume and analysis are unaffected — try again shortly."}
          </Alert>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        <div>
          <p className="mb-3 text-xs text-muted">
            Your confirmed content is shown in plain fields. AI suggestions appear separately in{" "}
            <span className="rounded bg-ai-soft px-1 text-ai">amber</span> and change nothing until you accept them.
          </p>
          <ContentForm value={draft} onChange={setDraft} bulletActions={bulletActions} summaryActions={summaryActions} highlight={(p) => pendingPaths.has(p)} idPrefix="ed" />
        </div>

        <div className="xl:sticky xl:top-36 xl:self-start">
          <div role="tablist" aria-label="Editor panels" className="mb-3 flex gap-1 rounded-md bg-paper-2 p-1">
            {(
              [
                ["preview", "Preview"],
                ["suggestions", `AI (${suggestions.length})`],
                ["history", "History"],
                ["export", "Export"],
              ] as [Panel, string][]
            ).map(([p, l]) => (
              <button key={p} role="tab" aria-selected={panel === p} aria-controls={`panel-${p}`} className="flex-1 rounded px-2 py-1.5 text-sm font-medium aria-selected:bg-card aria-selected:shadow-sm" onClick={() => setPanel(p)}>
                {l}
              </button>
            ))}
          </div>
          <div id={`panel-${panel}`} role="tabpanel" className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-lg">
            {panel === "preview" && (
              <div className="space-y-4">
                <div className="card p-4">
                  <p className="label">Section order</p>
                  <ol className="space-y-1">
                    {draft.section_order.map((k, i) => (
                      <li key={k} className="flex items-center justify-between rounded border border-line bg-paper px-2 py-1 text-sm">
                        <span>
                          <span className="num mr-2 text-xs text-muted">{i + 1}</span>
                          {SECTION_LABEL[k]}
                        </span>
                        <span>
                          <button className="btn btn-ghost btn-sm !p-1" aria-label={`Move ${SECTION_LABEL[k]} up`} disabled={i === 0} onClick={() => moveSection(i, -1)}>
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <button className="btn btn-ghost btn-sm !p-1" aria-label={`Move ${SECTION_LABEL[k]} down`} disabled={i === draft.section_order.length - 1} onClick={() => moveSection(i, 1)}>
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-3">
                    <label className="label" htmlFor="prev-tpl">
                      Preview template
                    </label>
                    <select id="prev-tpl" className="input" value={template} onChange={(e) => setTemplate(e.target.value)}>
                      <option value="student">Fresher / Student</option>
                      <option value="professional">Experienced Professional</option>
                      <option value="technical">Technical Specialist</option>
                    </select>
                  </div>
                </div>
                <div className="rounded-lg bg-paper-2 p-3">
                  <ResumePreview c={draft} template={template} />
                </div>
              </div>
            )}
            {panel === "suggestions" && (
              <div className="space-y-3">
                {suggestions.length === 0 ? (
                  <Empty icon={<Sparkles className="h-7 w-7" />} title="No pending suggestions">
                    Use the amber buttons under a bullet or the summary. Suggestions are checked against your confirmed facts and never applied
                    automatically.
                  </Empty>
                ) : (
                  suggestions.map((s) => (
                    <SuggestionCard
                      key={s.id}
                      s={s}
                      onResolved={async (r) => {
                        setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
                        if (r.accepted && r.versionId) {
                          setLive("Suggestion accepted and saved as a new version.");
                          await reload();
                          await loadVersion(r.versionId);
                        } else setLive("Suggestion rejected.");
                      }}
                    />
                  ))
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
  const router = useRouter();
  const { data, error, loading, reload } = useApi<Version[]>(`/api/resumes/${resumeId}/versions`, [current.id]);
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const [sel, setSel] = useState<string[]>([]);
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [variant, setVariant] = useState({ title: "", role: "" });

  async function restore(v: Version) {
    if (!window.confirm(`Restore version ${v.number}? This creates a new version with its content; nothing is deleted.`)) return;
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
        <div className="mb-2 flex items-center justify-between">
          <p className="flex items-center gap-1.5 font-semibold">
            <History className="h-4 w-4" aria-hidden /> Versions
          </p>
          <button className="btn btn-secondary btn-sm" disabled={sel.length !== 2 || busy === "cmp"} onClick={compare}>
            <GitCompareArrows className="h-4 w-4" aria-hidden /> Compare 2
          </button>
        </div>
        <p className="mb-2 text-xs text-muted">History is append-only. Restoring creates a new version; your original upload is never modified.</p>
        <ul className="space-y-1.5">
          {data?.map((v) => (
            <li key={v.id} className="flex items-center gap-2 rounded border border-line bg-paper px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                aria-label={`Select version ${v.number} for comparison`}
                checked={sel.includes(v.id)}
                onChange={(e) => setSel((s) => (e.target.checked ? [...s, v.id].slice(-2) : s.filter((x) => x !== v.id)))}
              />
              <span className="num w-8 font-semibold">v{v.number}</span>
              <span className="min-w-0 flex-1 truncate">
                {v.label ?? v.source}
                <span className="block text-[11px] text-muted">
                  {fmtDate(v.created_at)} · {v.source.replace("_", " ")}
                </span>
              </span>
              {v.source === "ai_accepted" && <Badge tone="ai">AI</Badge>}
              {v.is_latest ? (
                <Badge tone="teal">current</Badge>
              ) : (
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => restore(v)}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restore
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
            Overall indicator: <span className="num">{cmp.overall.a ?? "—"}</span> → <span className="num font-semibold">{cmp.overall.b ?? "—"}</span>
          </p>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {cmp.categories.map((c) => (
                <tr key={c.id} className="border-b border-line">
                  <td className="py-1">{c.name}</td>
                  <td className="num py-1 text-right">{c.a ?? "—"}</td>
                  <td className="num py-1 text-right">{c.b ?? "—"}</td>
                  <td className={`num py-1 text-right ${c.delta && c.delta > 0 ? "text-ok" : c.delta && c.delta < 0 ? "text-bad" : "text-muted"}`}>
                    {c.delta == null ? "" : c.delta > 0 ? `+${c.delta}` : c.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="label mt-3">Content changes ({cmp.changes.length})</p>
          <ul className="space-y-2">
            {cmp.changes.map((ch, i) => (
              <li key={i} className="rounded bg-paper p-2 text-xs">
                <p className="num text-muted">{ch.path}</p>
                {ch.diff ? <DiffView ops={ch.diff} /> : ch.change ? <p>{ch.change}</p> : ch.added || ch.removed ? (
                  <p>
                    {ch.added?.length ? `Added: ${ch.added.join(", ")}. ` : ""}
                    {ch.removed?.length ? `Removed: ${ch.removed.join(", ")}.` : ""}
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
          <CopyPlus className="h-4 w-4" aria-hidden /> Create a targeted variant
        </p>
        <p className="mt-1 text-xs text-muted">A separate resume starting from v{current.number}, with its own history. Good for role-specific versions.</p>
        <div className="mt-3 grid gap-2">
          <Field label="Variant name" id="var-title">
            <input id="var-title" className="input" value={variant.title} onChange={(e) => setVariant({ ...variant, title: e.target.value })} placeholder="e.g. Resume — ML roles" />
          </Field>
          <Field label="Target role (optional)" id="var-role">
            <select id="var-role" className="input" value={variant.role} onChange={(e) => setVariant({ ...variant, role: e.target.value })}>
              <option value="">None</option>
              {roles.data?.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-secondary btn-sm justify-self-start" disabled={busy === "variant"} onClick={createVariant}>
            {busy === "variant" ? <Spinner label="Creating" /> : "Create variant"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportPanel({ resumeId, dirty }: { resumeId: string; dirty: boolean }) {
  const templates = useApi<Template[]>("/api/templates");
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
      if (e.status === "failed") setErr(e.error_message ?? "Export failed.");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4 p-4">
      {dirty && <Alert tone="warn">You have unsaved edits. Exports always use the latest <em>saved</em> version.</Alert>}
      <fieldset>
        <legend className="label">Template</legend>
        <div className="grid gap-2">
          {(templates.data ?? []).map((t) => (
            <label key={t.id} className={`flex cursor-pointer gap-2 rounded border p-2 text-sm ${opts.template === t.id ? "border-teal bg-teal-soft" : "border-line"}`}>
              <input type="radio" name="tpl" value={t.id} checked={opts.template === t.id} onChange={() => setOpts({ ...opts, template: t.id })} />
              <span>
                <span className="font-medium">{t.name}</span>
                <span className="block text-xs text-muted">{t.description}</span>
              </span>
            </label>
          ))}
          {templates.error && <ErrorState message={templates.error} onRetry={templates.reload} />}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Format" id="fmt">
          <select id="fmt" className="input" value={opts.format} onChange={(e) => setOpts({ ...opts, format: e.target.value })}>
            <option value="pdf">PDF</option>
            <option value="docx">Word (DOCX)</option>
          </select>
        </Field>
        <Field label="Page size" id="ps">
          <select id="ps" className="input" value={opts.page_size} onChange={(e) => setOpts({ ...opts, page_size: e.target.value })}>
            <option value="A4">A4</option>
            <option value="LETTER">US Letter</option>
          </select>
        </Field>
      </div>
      <button className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? <Spinner label="Generating" /> : (<><Download className="h-4 w-4" aria-hidden /> Generate export</>)}
      </button>
      <div aria-live="polite">
        {err && <ErrorState message={err} onRetry={run} />}
        {exp?.status === "ready" && (
          <div className="space-y-3">
            {exp.unresolved_placeholders.length > 0 && (
              <Alert tone="warn" title={`${exp.unresolved_placeholders.length} unresolved placeholder${exp.unresolved_placeholders.length > 1 ? "s" : ""}`}>
                These are highlighted in the file. Replace them with real facts or remove them before sending:
                <ul className="mt-1 list-disc pl-4">
                  {exp.unresolved_placeholders.map((p, i) => (
                    <li key={i}>{p.placeholder}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <Alert tone="ok" title="Export ready" action={<button className="btn btn-primary btn-sm" onClick={() => downloadSigned(`/api/exports/${exp.id}/link`)}>Download</button>}>
              {exp.format.toUpperCase()} · {exp.template} · {exp.page_size}
              {exp.page_count ? ` · ${exp.page_count} page${exp.page_count > 1 ? "s" : ""}` : ""}. The download link expires after a few minutes.
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
