"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Badge, ErrorState, LoadingBlock } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import type { Resume } from "@/lib/types";
import { ResumeContext } from "./context";

const TABS = [
  { seg: "review", label: "Extraction" },
  { seg: "analysis", label: "Analysis" },
  { seg: "roles", label: "Roles" },
  { seg: "leaderboard", label: "Leaderboard" },
  { seg: "match", label: "Job match" },
  { seg: "editor", label: "Editor" },
  { seg: "career", label: "Career" },
];

export default function ResumeLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { data: resume, error, loading, reload } = useApi<Resume>(`/api/resumes/${id}`);

  if (loading && !resume) return <LoadingBlock label="Loading resume…" />;
  if (error || !resume) return <ErrorState message={error ?? "Resume not found."} onRetry={reload} />;

  const confirmed = !!resume.latest_version_id;
  return (
    <ResumeContext.Provider value={{ resume, reload, versionId: resume.latest_version_id }}>
      <div className="mb-6">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ChevronLeft className="h-4 w-4" aria-hidden /> All resumes
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl sm:text-3xl">{resume.title}</h1>
          {resume.latest_version_number && <Badge tone="teal">v{resume.latest_version_number}</Badge>}
          {resume.source_resume_id && <Badge>Targeted variant{resume.target_role ? ` · ${resume.target_role.replace(/_/g, " ")}` : ""}</Badge>}
        </div>
        <nav aria-label="Resume sections" className="mt-4 -mx-4 overflow-x-auto px-4">
          <ul className="flex min-w-max gap-1 border-b border-line">
            {TABS.map((t) => {
              const href = `/resumes/${id}/${t.seg}`;
              const active = pathname.startsWith(href);
              const disabled = !confirmed && t.seg !== "review";
              return (
                <li key={t.seg}>
                  {disabled ? (
                    <span className="inline-block cursor-not-allowed px-3 py-2 text-sm text-muted/60" title="Confirm the extraction first" aria-disabled="true">
                      {t.label}
                    </span>
                  ) : (
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`-mb-px inline-block border-b-2 px-3 py-2 text-sm font-medium ${active ? "border-teal text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
                    >
                      {t.label}
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
