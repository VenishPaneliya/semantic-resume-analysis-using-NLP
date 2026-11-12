"use client";

import { ChevronLeft, Lock } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Badge, ErrorState, LoadingBlock, NotFoundState } from "@/components/ui";
import { ResumeContext } from "./context";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import { resumeTitle, resumeTitleLang, roleTitle } from "@/lib/labels";
import type { Resume } from "@/lib/types";

const TABS: { seg: string; label: MessageKey }[] = [
  { seg: "review", label: "resume.tab.review" },
  { seg: "analysis", label: "resume.tab.analysis" },
  { seg: "leaderboard", label: "resume.tab.leaderboard" }, // includes what was the Roles tab
  { seg: "match", label: "resume.tab.match" },
  { seg: "editor", label: "resume.tab.editor" },
  { seg: "career", label: "resume.tab.career" },
  { seg: "progress", label: "resume.tab.progress" },
  { seg: "interview", label: "resume.tab.interview" },
];

export function ResumeShell({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const t = useT();
  const { data: resume, error, errorCode, loading, reload } = useApi<Resume>(`/api/resumes/${id}`);
  const activeTab = useRef<HTMLAnchorElement>(null);

  // On phones the tab strip scrolls sideways: keep the current tab in view (e.g. "Interview practice").
  useEffect(() => {
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname, resume?.id]);

  if (loading && !resume) return <LoadingBlock label={t("resume.loading")} />;
  // a wrong or deleted resume link (or someone else's resume) is "not found", not a retryable error
  if (errorCode === "not_found" || errorCode === "http_404" || errorCode === "invalid_id" || errorCode === "http_422")
    return <NotFoundState title={t("resume.notFoundTitle")} body={t("resume.notFoundBody")} backHref="/dashboard" backLabel={t("resume.allResumes")} />;
  if (error || !resume) return <ErrorState message={error ?? t("resume.notFound")} onRetry={reload} />;

  const confirmed = !!resume.latest_version_id;
  return (
    <ResumeContext.Provider value={{ resume, reload, versionId: resume.latest_version_id }}>
      <div className="mb-6">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> {t("resume.allResumes")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl sm:text-3xl" lang={resumeTitleLang(t, resume)}>
            {resumeTitle(t, resume)}
          </h1>
          {resume.latest_version_number && <Badge tone="teal">v{resume.latest_version_number}</Badge>}
          {resume.source_resume_id && <Badge>{t("dash.targetedVariant")}{resume.target_role ? ` · ${roleTitle(t, resume.target_role)}` : ""}</Badge>}
        </div>
        <nav aria-label={t("resume.sections")} className="mt-4 -mx-4 overflow-x-auto px-4" data-testid="resume-tabs">
          <ul className="flex min-w-max gap-1 border-b border-line">
            {TABS.map((tab) => {
              const href = `/resumes/${id}/${tab.seg}`;
              const active = pathname.startsWith(href);
              const disabled = !confirmed && tab.seg !== "review";
              return (
                <li key={tab.seg}>
                  {disabled ? (
                    <span
                      className="relative inline-flex cursor-not-allowed items-center gap-1 whitespace-nowrap px-3 py-2 text-sm text-muted"
                      title={t("resume.confirmFirst")}
                      aria-disabled="true"
                    >
                      <Lock className="h-3 w-3 shrink-0" aria-hidden /> {t(tab.label)}
                      <span className="sr-only">({t("resume.confirmFirst")})</span>
                    </span>
                  ) : (
                    <Link
                      href={href}
                      ref={active ? activeTab : undefined}
                      aria-current={active ? "page" : undefined}
                      className={`-mb-px inline-block whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${active ? "border-teal text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
                    >
                      {t(tab.label)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      {children}
    </ResumeContext.Provider>
  );
}
