"use client";

import { AlertTriangle, CheckCircle2, FlaskConical, Info, Languages, Loader2, RotateCcw, Sparkles, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n, useT, type MessageKey } from "@/lib/i18n";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label ?? t("common.loadingShort")}
    </span>
  );
}

export function LoadingBlock({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="card flex min-h-40 items-center justify-center p-8">
      <Spinner label={label ?? t("common.loading")} />
    </div>
  );
}

type Tone = "info" | "ok" | "warn" | "bad" | "ai";
const toneCls: Record<Tone, string> = {
  info: "bg-info-soft text-info border-[#c3d0e4]",
  ok: "bg-ok-soft text-ok border-[#bcd9c4]",
  warn: "bg-warn-soft text-warn border-[#ecc89c]",
  bad: "bg-bad-soft text-bad border-[#e9b7af]",
  ai: "bg-ai-soft text-ai border-ai-line",
};
const toneIcon: Record<Tone, ReactNode> = {
  info: <Info className="h-4 w-4 shrink-0" aria-hidden />,
  ok: <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />,
  warn: <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />,
  bad: <XCircle className="h-4 w-4 shrink-0" aria-hidden />,
  ai: <Sparkles className="h-4 w-4 shrink-0" aria-hidden />,
};

export function Alert({ tone = "info", title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("flex gap-3 rounded-lg border px-4 py-3 text-sm", toneCls[tone])} role={tone === "bad" ? "alert" : "status"}>
      <span className="mt-0.5">{toneIcon[tone]}</span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="mt-0.5 leading-relaxed [&_a]:underline">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <Alert
      tone="bad"
      title={t("common.somethingWrong")}
      action={
        onRetry && (
          <button className="btn btn-secondary btn-sm" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {t("common.retry")}
          </button>
        )
      }
    >
      {message}
    </Alert>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <h3 className="text-lg">{title}</h3>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: Tone | "neutral" | "teal"; children: ReactNode; className?: string }) {
  const cls =
    tone === "neutral"
      ? "bg-paper-2 text-ink-2 border-line"
      : tone === "teal"
        ? "bg-teal-soft text-teal border-[#b8d6d0]"
        : toneCls[tone];
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold", cls, className)}>{children}</span>;
}

/** Mandatory label whenever a result comes from the development fixture provider. */
export function FixtureBadge({ show = true }: { show?: boolean }) {
  const t = useT();
  if (!show) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded border-2 border-dashed border-[#b45309] bg-[#fff7ed] px-2 py-0.5 text-xs font-bold text-[#9a3412]"
      title={t("common.fixtureTitle")}
    >
      <FlaskConical className="h-3.5 w-3.5" aria-hidden /> {t("common.fixtureBadge")}
    </span>
  );
}

export function AIBadge({ children }: { children?: ReactNode }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-ai-line bg-ai-soft px-2 py-0.5 text-xs font-semibold text-ai">
      <Sparkles className="h-3.5 w-3.5" aria-hidden /> {children ?? t("common.aiSuggestionNotApplied")}
    </span>
  );
}

export function ScoreDial({ value, label, size = 88 }: { value: number | null; label?: string; size?: number }) {
  const t = useT();
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  const color = value == null ? "#c6bdab" : value >= 75 ? "#0f5c55" : value >= 50 ? "#b7791f" : "#a3271d";
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#ebe4d6" strokeWidth={7} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={7}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset .8s ease" }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num font-semibold leading-none" style={{ fontSize: Math.max(13, Math.round(size * 0.24)) }}>{value ?? "—"}</span>
        {label && size >= 80 && <span className="mt-1 text-[10px] uppercase tracking-wider text-muted">{label}</span>}
      </span>
      <span className="sr-only">{value == null ? t("common.noScore") : t("common.outOf100", { value })}</span>
    </div>
  );
}

export function Bar({ value, max = 1, tone = "teal", label }: { value: number; max?: number; tone?: "teal" | "ai" | "muted"; label: string }) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  const bg = tone === "teal" ? "bg-teal" : tone === "ai" ? "bg-ai" : "bg-line-strong";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-paper-2" role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full", bg)} style={{ width: `${pct}%`, transition: "width .6s ease" }} />
    </div>
  );
}

export function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="rise">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h1 className="text-3xl leading-tight sm:text-4xl">{title}</h1>
        {children && <div className="mt-2 max-w-2xl text-sm text-ink-2">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="card p-5 sm:p-6" aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="scroll-mt-20 text-xl">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function LiveRegion({ message }: { message: string }) {
  return (
    <p className="sr-only" aria-live="polite" role="status">
      {message}
    </p>
  );
}

/** One quiet line telling non-English readers that the text coming from the API (reasons, tips,
    rubric explanations, resume content) is in English. Renders nothing in English. */
export function EnglishNote({ kind = "analysis", className }: { kind?: "analysis" | "generic" | "resume"; className?: string }) {
  const { locale, t } = useI18n();
  if (locale === "en") return null;
  const key: MessageKey = kind === "analysis" ? "common.englishNote" : kind === "resume" ? "common.englishNoteResume" : "common.englishNoteGeneric";
  return (
    <p className={cx("flex items-center gap-1.5 text-xs text-muted", className)} data-testid="english-note">
      <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden /> {t(key)}
    </p>
  );
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function pct(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
