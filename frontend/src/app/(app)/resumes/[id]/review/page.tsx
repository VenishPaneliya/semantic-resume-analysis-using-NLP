"use client";

import { AlertTriangle, CheckCircle2, FileSearch, Quote, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ContentForm, SECTION_LABEL, SECTION_LABEL_KEY } from "@/components/content-form";
import { Alert, Badge, EnglishNote, ErrorState, LoadingBlock, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useT, type MessageKey } from "@/lib/i18n";
import type { Extraction, ResumeContent, SectionKey } from "@/lib/types";
import { useResume } from "../context";

const WARNINGS: Record<string, { tone: "warn" | "bad" | "info"; text: MessageKey }> = {
  embedded_instructions_detected: { tone: "bad", text: "review.warn.embedded" },
  content_in_page_header: { tone: "warn", text: "review.warn.header" },
  ocr_used_text_may_contain_errors: { tone: "warn", text: "review.warn.ocr" },
  pdf_active_content_ignored: { tone: "info", text: "review.warn.active" },
  pdf_permissions_encryption: { tone: "info", text: "review.warn.permissions" },
};

export default function ReviewPage() {
  const t = useT();
  const { resume, reload } = useResume();
  const router = useRouter();
  const [ex, setEx] = useState<Extraction | null>(null);
  const [content, setContent] = useState<ResumeContent | null>(null);
  const [error, setError] = useState<{ msg: string; code?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const e = await api<Extraction>(`/api/resumes/${resume.id}/extraction`);
      setEx(e);
      setContent(e.content);
    } catch (e) {
      setError({ msg: errMsg(e), code: (e as { code?: string }).code });
    }
  }
  useEffect(() => {
    if (resume.status === "processing") {
      const timer = setInterval(() => void reload(), 1500);
      return () => clearInterval(timer);
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume.status]);

  if (resume.status === "processing")
    return (
      <div className="card p-8" aria-live="polite">
        <Spinner label={resume.job?.stage ? t("review.processingStage", { stage: resume.job.stage }) : t("review.processing")} />
      </div>
    );
  if (resume.status === "failed")
    return (
      <ErrorState
        message={`${resume.error_message ?? t("dash.processingFailed")} ${t("review.failedHint")}`}
        onRetry={
          resume.job
            ? async () => {
                await api(`/api/processing-jobs/${resume.job!.id}/retry`, { method: "POST" });
                await reload();
              }
            : undefined
        }
      />
    );
  if (error) return <ErrorState message={error.msg} onRetry={load} />;
  if (!ex || !content) return <LoadingBlock label={t("review.loading")} />;

  const confirmed = !!resume.latest_version_id;
  const uncertainBy = new Map<string, string[]>();
  ex.uncertain.forEach((u) => uncertainBy.set(u.path, [...(uncertainBy.get(u.path) ?? []), u.reason]));
  const unparsed = new Map(ex.unparsed_sections.map((u) => [u.section, u.reason]));
  const allSections = Object.keys(SECTION_LABEL) as SectionKey[];
  const missing = allSections.filter((s) => !ex.detected_sections.includes(s) && isEmpty(content, s));

  const note = (path: string) => {
    if (path.startsWith("section:")) {
      const s = path.slice(8);
      if (unparsed.has(s))
        return (
          <div className="mb-3">
            <Alert tone="warn" title={t("review.notParsedTitle")}>
              {t("review.notParsedBody", { section: t(SECTION_LABEL_KEY[s as SectionKey]) })}
            </Alert>
          </div>
        );
      if (missing.includes(s as SectionKey))
        return <p className="mb-3 text-xs text-muted">{t("review.sectionNotFound")}</p>;
      return null;
    }
    const conf = ex.confidence[path];
    const unc = uncertainBy.get(path);
    const ev = ex.evidence[path] ?? ex.evidence[`${path}/title`] ?? ex.evidence[`${path}/name`] ?? ex.evidence[`${path}/degree`];
    const isBullet = path.includes("/bullets/");
    if (!conf && !unc && (!ev || isBullet)) {
      return isBullet && ev ? <EvidenceLine page={ev.page} /> : null;
    }
    return (
      <div className="mb-2 mt-1.5 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {conf !== undefined && <ConfidenceBadge value={conf} />}
          {ev && !isBullet && (
            <span className="inline-flex max-w-full items-center gap-1 truncate text-xs text-muted">
              <Quote className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">“{ev.text}”</span>
              {ev.page != null && <span className="num shrink-0">{t("review.pageShort", { page: ev.page })}</span>}
            </span>
          )}
        </div>
        {unc?.map((r) => (
          <p key={r} className="flex items-start gap-1 text-xs text-warn">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {t("review.uncertain", { reason: r })}
          </p>
        ))}
      </div>
    );
  };

  async function confirm() {
    setSaving(true);
    setSaveErr(null);
    try {
      await api(`/api/resumes/${resume.id}/review`, { method: "PUT", body: { content } });
      await reload();
      router.push(`/resumes/${resume.id}/analysis`);
    } catch (e) {
      setSaveErr(errMsg(e));
      setSaving(false);
    }
  }

  const layout = ex.layout as Record<string, unknown>;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-5">
        {confirmed ? (
          <Alert tone="ok" title={t("review.confirmedTitle")}>
            {t("review.confirmedBody")}
          </Alert>
        ) : (
          <Alert tone="info" title={t("review.checkTitle")}>
            {t("review.checkBody")}
          </Alert>
        )}
        <EnglishNote kind="resume" />
        {ex.warnings.map((w) => {
          const m = WARNINGS[w];
          return m ? (
            <Alert key={w} tone={m.tone} title={w === "embedded_instructions_detected" ? t("review.embeddedTitle") : undefined}>
              {t(m.text)}
            </Alert>
          ) : null;
        })}
        <fieldset disabled={confirmed} className="disabled:opacity-80">
          <ContentForm value={content} onChange={setContent} note={note} idPrefix="review" />
        </fieldset>
        {!confirmed && (
          <div className="card sticky bottom-3 z-10 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <p className="flex-1 text-sm text-ink-2">{t("review.confirmNote")}</p>
            {saveErr && <p className="text-sm text-bad" role="alert">{saveErr}</p>}
            <button className="btn btn-primary" onClick={confirm} disabled={saving}>
              {saving ? <Spinner label={t("common.saving")} /> : (<><CheckCircle2 className="h-4 w-4" aria-hidden /> {t("review.confirm")}</>)}
            </button>
          </div>
        )}
      </div>

      <aside className="space-y-5">
        <Section title={t("review.document")} id="doc-facts">
          <dl className="space-y-2 text-sm">
            <Row k={t("review.file")} v={resume.original_filename} />
            <Row k={t("review.pages")} v={String(layout.page_count ?? t("review.notPaginated"))} />
            <Row k={t("review.textLayer")} v={ex.ocr_used ? t("review.ocrUsed") : t("common.yes")} />
            {typeof layout.body_font_size_pt === "number" && <Row k={t("review.bodyFont")} v={`${layout.body_font_size_pt} pt`} />}
            {typeof layout.distinct_font_count === "number" && <Row k={t("review.distinctFonts")} v={String(layout.distinct_font_count)} />}
            <Row k={t("review.parser")} v={`${ex.parser_version} · ${ex.extractor_version}`} />
          </dl>
          <p className="mt-3 text-xs text-muted">{t("review.measuredNote")}</p>
          <button
            className="btn btn-secondary btn-sm mt-3"
            onClick={async () => {
              const { url } = await api<{ url: string }>(`/api/resumes/${resume.id}/original-link`);
              window.open(url, "_blank", "noopener");
            }}
          >
            <FileSearch className="h-4 w-4" aria-hidden /> {t("review.viewOriginal")}
          </button>
        </Section>
        <Section title={t("review.sections")} id="sections">
          <ul className="space-y-1.5 text-sm">
            {allSections.map((s) => (
              <li key={s} className="flex items-center justify-between gap-2">
                <span className="min-w-0">{t(SECTION_LABEL_KEY[s])}</span>
                {unparsed.has(s) ? (
                  <Badge tone="warn" className="shrink-0">{t("review.badge.notParsed")}</Badge>
                ) : ex.detected_sections.includes(s) ? (
                  <Badge tone="ok" className="shrink-0">{t("review.badge.found")}</Badge>
                ) : missing.includes(s) ? (
                  <Badge className="shrink-0">{t("review.badge.missing")}</Badge>
                ) : (
                  <Badge tone="teal" className="shrink-0">{t("review.badge.inferred")}</Badge>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            {t.rich("review.legend", { b: (c) => <strong>{c}</strong> })}
          </p>
        </Section>
        {ex.unrecognized_skills.length > 0 && (
          <Section title={t("review.unrecognised")} id="unrec">
            <p className="mb-2 text-xs text-muted">{t("review.unrecognisedBody")}</p>
            <div className="flex flex-wrap gap-1.5">
              {ex.unrecognized_skills.map((s) => (
                <Badge key={s}>{s}</Badge>
              ))}
            </div>
          </Section>
        )}
        {ex.uncertain.length > 0 && (
          <Alert tone="warn" title={t("review.uncertainCount", { count: ex.uncertain.length })}>
            {t.rich("review.uncertainBody", { icon: () => <ShieldAlert className="inline h-3.5 w-3.5" aria-hidden /> })}
          </Alert>
        )}
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{v}</dd>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const t = useT();
  const tone = value >= 0.8 ? "ok" : value >= 0.6 ? "info" : "warn";
  return <Badge tone={tone}>{t("review.confidence", { pct: Math.round(value * 100) })}</Badge>;
}

function EvidenceLine({ page }: { page: number | null }) {
  const t = useT();
  return page != null ? <p className="ml-5 text-[11px] text-muted num">{t("review.source", { page })}</p> : null;
}

function isEmpty(c: ResumeContent, s: SectionKey) {
  const v = c[s];
  if (s === "skills") return !(c.skills.technical.length || c.skills.soft.length || c.skills.other.length);
  if (Array.isArray(v)) return v.length === 0;
  return !v;
}
