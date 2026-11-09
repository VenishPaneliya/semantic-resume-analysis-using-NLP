"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Badge, ErrorState, LoadingBlock } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { Resume } from "@/lib/types";
import { ResumeContext } from "./context";

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

export default function ResumeLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const t = useT();
  const { data: resume, error, loading, reload } = useApi<Resume>(`/api/resumes/${id}`);

  if (loading && !resume) return <LoadingBlock label={t("resume.loading")} />;
  if (error || !resume) return <ErrorState message={error ?? t("resume.notFound")} onRetry={reload} />;

  const confirmed = !!resume.latest_version_id;
  return (
    <ResumeContext.Provider value={{ resume, reload, versionId: resume.latest_version_id }}>
      <div className="mb-6">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> {t("resume.allResumes")}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl sm:text-3xl">{resume.title}</h1>
          {resume.latest_version_number && <Badge tone="teal">v{resume.latest_version_number}</Badge>}
          {resume.source_resume_id && <Badge>{t("dash.targetedVariant")}{resume.target_role ? ` · ${resume.target_role.replace(/_/g, " ")}` : ""}</Badge>}
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
                    <span className="inline-block cursor-not-allowed whitespace-nowrap px-3 py-2 text-sm text-muted/60" title={t("resume.confirmFirst")} aria-disabled="true">
                      {t(tab.label)}
                    </span>
                  ) : (
                    <Link
                      href={href}
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
