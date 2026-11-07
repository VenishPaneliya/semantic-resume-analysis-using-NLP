"use client";

import { ArrowRight, CopyPlus, FileText, FileUp, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useUser } from "@/components/shell";
import { Alert, Badge, Empty, ErrorState, fmtDate, LiveRegion, LoadingBlock, PageHeader, Spinner } from "@/components/ui";
import { api, errMsg, uploadWithProgress } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Resume } from "@/lib/types";

const STATUS: Record<Resume["status"], { label: string; tone: "neutral" | "info" | "warn" | "ok" | "bad" }> = {
  uploaded: { label: "Uploaded", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  needs_review: { label: "Needs review", tone: "warn" },
  ready: { label: "Ready", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
};

const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function Dashboard() {
  const { user } = useUser();
  const params = useSearchParams();
  const { data, setData, error, loading, reload } = useApi<Resume[]>(user.email_verified ? "/api/resumes" : null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processing = (data ?? []).filter((r) => r.status === "processing" || r.status === "uploaded");

  // poll while anything is processing
  useEffect(() => {
    if (!processing.length) return;
    const t = setInterval(async () => {
      try {
        const updated = await Promise.all(processing.map((r) => api<Resume>(`/api/resumes/${r.id}`)));
        setData((prev) => (prev ?? []).map((r) => updated.find((u) => u.id === r.id) ?? r));
        updated.forEach((u) => {
          if (u.status === "needs_review") setLive(`${u.title} is ready for review.`);
          if (u.status === "failed") setLive(`${u.title} could not be processed.`);
        });
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [processing, setData]);

  const doUpload = useCallback(
    async (file: File) => {
      setUploadError(null);
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!ext || !["pdf", "docx"].includes(ext)) {
        setUploadError("Please choose a PDF or DOCX file.");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setUploadError("Files must be 5 MB or smaller.");
        return;
      }
      const form = new FormData();
      form.append("file", file);
      setProgress(0);
      setLive(`Uploading ${file.name}`);
      try {
        const r = await uploadWithProgress<Resume>("/api/resumes", form, (p) => {
          setProgress(p);
          if (p % 25 === 0) setLive(`Upload ${p}%`);
        });
        setData((prev) => [r, ...(prev ?? [])]);
        setLive(r.status === "needs_review" ? `${r.title} uploaded and ready for review.` : `${r.title} uploaded; processing…`);
      } catch (e) {
        setUploadError(errMsg(e));
        setLive("Upload failed.");
      } finally {
        setProgress(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [setData],
  );

  async function retry(r: Resume) {
    if (!r.job) return;
    try {
      await api(`/api/processing-jobs/${r.job.id}/retry`, { method: "POST" });
      setData((prev) => (prev ?? []).map((x) => (x.id === r.id ? { ...x, status: "processing", error_message: null } : x)));
    } catch (e) {
      setUploadError(errMsg(e));
    }
  }

  async function remove(r: Resume) {
    if (!window.confirm(`Delete “${r.title}”? This removes the file, all versions and every analysis. This cannot be undone.`)) return;
    try {
      await api(`/api/resumes/${r.id}`, { method: "DELETE" });
      setData((prev) => (prev ?? []).filter((x) => x.id !== r.id));
      setLive(`${r.title} deleted.`);
    } catch (e) {
      setUploadError(errMsg(e));
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void doUpload(f);
  }

  return (
    <>
      <PageHeader eyebrow="Workspace" title={`Hello${user.display_name ? `, ${user.display_name}` : ""}`}>
        Upload a resume, confirm what we extracted, then explore analysis, role fit and edits.
      </PageHeader>
      <LiveRegion message={live} />

      {params.get("welcome") && !user.email_verified && (
        <div className="mb-6">
          <Alert tone="info" title="Account created">
            Check your inbox for a verification link. (In local development the link is printed in the backend console.)
          </Alert>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`card rise rise-1 mb-8 border-2 border-dashed p-6 transition-colors sm:p-8 ${drag ? "border-teal bg-teal-soft" : "border-line-strong"}`}
      >
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <div className="rounded-lg bg-teal-soft p-3 text-teal">
            <FileUp className="h-6 w-6" aria-hidden />
          </div>
          <div className="flex-1">
            <h2 className="text-lg">Upload a resume</h2>
            <p className="text-sm text-ink-2">PDF or DOCX, up to 5 MB and 10 pages. Drag and drop, or choose a file.</p>
          </div>
          <label className={`btn btn-primary ${!user.email_verified || progress !== null ? "pointer-events-none opacity-55" : ""}`}>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              disabled={!user.email_verified || progress !== null}
              onChange={(e) => e.target.files?.[0] && doUpload(e.target.files[0])}
              aria-describedby="upload-help"
            />
            Choose file
          </label>
        </div>
        <p id="upload-help" className="sr-only">
          Accepted formats: PDF and DOCX.
        </p>
        {progress !== null && (
          <div className="mt-5">
            <div className="flex justify-between text-xs text-ink-2">
              <span>{progress < 100 ? "Uploading…" : "Validating and extracting…"}</span>
              <span className="num">{progress}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
              <div className="h-full rounded-full bg-teal transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {uploadError && (
          <div className="mt-4">
            <Alert tone="bad" title="Upload not accepted">
              {uploadError}
            </Alert>
          </div>
        )}
      </div>

      <h2 className="mb-3 text-xl">Your resumes</h2>
      {!user.email_verified ? (
        <Empty icon={<FileText className="h-8 w-8" />} title="Verify your email first">
          Uploads unlock once your email address is verified.
        </Empty>
      ) : loading && !data ? (
        <LoadingBlock label="Loading resumes…" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data?.length ? (
        <Empty icon={<FileText className="h-8 w-8" />} title="No resumes yet">
          Upload your first resume above. We keep the original untouched and work on structured versions.
        </Empty>
      ) : (
        <ul className="grid gap-3">
          {data.map((r, i) => (
            <li key={r.id} className={`card rise p-4 sm:p-5 ${i < 4 ? `rise-${i + 1}` : ""}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-lg">{r.title}</h3>
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    {r.source_resume_id && (
                      <Badge tone="teal">
                        <CopyPlus className="h-3 w-3" aria-hidden /> Targeted variant
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
                    {r.original_filename} · {r.file_kind.toUpperCase()}
                    {r.page_count ? ` · ${r.page_count} page${r.page_count > 1 ? "s" : ""}` : ""} · {fmtDate(r.created_at)}
                    {r.latest_version_number ? ` · v${r.latest_version_number}` : ""}
                  </p>
                  {r.status === "processing" && (
                    <div className="mt-2">
                      <Spinner label={r.job?.stage ? `Processing: ${r.job.stage}` : "Processing…"} />
                    </div>
                  )}
                  {r.status === "failed" && (
                    <p className="mt-2 text-sm text-bad">
                      {r.error_message ?? r.job?.error_message ?? "Processing failed."}
                      {r.job && ` (attempt ${r.job.attempts}/${r.job.max_attempts})`}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {r.status === "needs_review" && (
                    <Link href={`/resumes/${r.id}/review`} className="btn btn-primary btn-sm">
                      Review extraction <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  )}
                  {r.status === "ready" && (
                    <>
                      <Link href={`/resumes/${r.id}/analysis`} className="btn btn-primary btn-sm">
                        Open <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                      <Link href={`/resumes/${r.id}/editor`} className="btn btn-secondary btn-sm">
                        Edit
                      </Link>
                    </>
                  )}
                  {r.status === "failed" && r.job && (
                    <button className="btn btn-secondary btn-sm" onClick={() => retry(r)}>
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(r)} aria-label={`Delete ${r.title}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <Dashboard />
    </Suspense>
  );
}
