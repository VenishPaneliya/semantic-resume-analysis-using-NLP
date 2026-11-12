"""Job handlers: resume parsing/extraction and document export."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Export, Extraction, ProcessingJob, Resume, ResumeVersion, utcnow
from app.schemas.resume import ResumeContent
from app.services.export.render import find_placeholders, render_docx, render_pdf
from app.services.extraction.extractor import extract
from app.services.jobs import JobError, handler
from app.services.parsing.parsers import ParseError
from app.services.parsing.sandbox import parse_isolated
from app.services.storage import get_storage
from app.services.upload_validation import UploadRejected, check_parsed_limits, refine_parse_error


@handler("parse_resume")
def parse_resume(db: Session, job: ProcessingJob) -> None:
    resume = db.get(Resume, job.target_id)
    if resume is None:
        raise JobError("not_found", "Resume no longer exists.")
    if resume.extraction is not None:
        return  # idempotent: already extracted
    resume.status = "processing"
    job.stage, job.progress = "parsing", 20
    db.commit()
    try:
        data = get_storage().get(resume.file_key)
    except FileNotFoundError as exc:
        raise JobError("file_missing", "The uploaded file could not be found.") from exc
    try:
        parsed = parse_isolated(resume.file_kind, data)
    except ParseError as exc:
        exc = refine_parse_error(resume.file_kind, data, exc)
        raise JobError(exc.code, exc.message, exc.retryable) from exc
    try:
        check_parsed_limits(parsed)
    except UploadRejected as exc:
        raise JobError(exc.code, exc.message) from exc
    job.stage, job.progress = "extracting", 70
    result = extract(parsed["text"], parsed["pages"])
    warnings = list(dict.fromkeys(parsed.get("warnings", []) + result["warnings"]))
    db.add(Extraction(
        resume_id=resume.id, user_id=resume.user_id, raw_text=parsed["text"], pages=parsed["pages"],
        fields={k: result[k] for k in ("content", "evidence", "confidence", "uncertain", "detected_sections",
                                        "unparsed_sections", "unrecognized_skills")},
        layout=parsed["layout"], warnings=warnings, ocr_used=parsed.get("ocr_used", False),
        parser_version=parsed["parser_version"], extractor_version=result["extractor_version"],
    ))
    resume.page_count = parsed["layout"].get("page_count") or resume.page_count
    resume.status = "needs_review"
    resume.error_code = resume.error_message = None


@handler("export")
def export_doc(db: Session, job: ProcessingJob) -> None:
    exp = db.get(Export, job.target_id)
    if exp is None:
        raise JobError("not_found", "Export no longer exists.")
    if exp.status == "ready" and exp.file_key:
        return
    v = db.get(ResumeVersion, exp.version_id)
    if v is None:
        raise JobError("not_found", "Version no longer exists.")
    c = ResumeContent.model_validate(v.content)
    job.stage = "rendering"
    if exp.format == "pdf":
        data, pages = render_pdf(c, exp.template, exp.page_size)
        exp.page_count = pages
        ctype = "application/pdf"
    else:
        data = render_docx(c, exp.template, exp.page_size)
        ctype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    key = f"users/{exp.user_id}/exports/{exp.id}.{exp.format}"
    get_storage().put(key, data, ctype)
    exp.file_key = key
    exp.unresolved_placeholders = find_placeholders(c)
    exp.status = "ready"


RETENTION_BATCH = 200
OPEN_APPLICATION_RECHECK = timedelta(days=7)


def _batches(ids: list, size: int):
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def resume_last_activity(db: Session, resume: Resume) -> datetime:
    """Most recent sign that a resume is in use: the resume itself, a new version, an export, or an
    application (to an opening here or in the user's own tracker) that uses one of its versions."""
    from app.models import Application, OpeningApplication

    vids = select(ResumeVersion.id).where(ResumeVersion.resume_id == resume.id)
    stamps = [resume.created_at, resume.updated_at,
              db.scalar(select(func.max(ResumeVersion.created_at)).where(ResumeVersion.resume_id == resume.id)),
              db.scalar(select(func.max(Export.created_at)).where(Export.version_id.in_(vids))),
              db.scalar(select(func.max(OpeningApplication.updated_at)).where(OpeningApplication.version_id.in_(vids))),
              db.scalar(select(func.max(Application.updated_at)).where(Application.resume_version_id.in_(vids)))]
    return max(_aware(s) for s in stamps if s is not None)


def has_open_application(db: Session, resume: Resume) -> bool:
    """An application to an opening that is still open and not yet decided (hired/rejected)."""
    from app.models import JobOpening, OpeningApplication

    vids = select(ResumeVersion.id).where(ResumeVersion.resume_id == resume.id)
    return db.scalar(
        select(func.count(OpeningApplication.id))
        .join(JobOpening, JobOpening.id == OpeningApplication.opening_id)
        .where(OpeningApplication.version_id.in_(vids), JobOpening.status == "open",
               OpeningApplication.stage.not_in(("hired", "rejected")))
    ) > 0


def _aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def retention_sweep(db: Session, *, batch_size: int = RETENTION_BATCH, now: datetime | None = None) -> dict:
    """Delete data past its retention window. Work is committed every `batch_size` rows, so a sweep
    that is stopped (time limit, deploy) keeps what it finished and the next run continues.

    - Resumes: FILE_RETENTION_DAYS after their *last activity* (see resume_last_activity), never while
      one of their versions has an open application. `retention_until` is pushed forward instead.
    - Analyses, recommendations, JD matches: ANALYSIS_RETENTION_DAYS after creation (caches).
    - Exports: 30 days. Bulk-uploaded candidates: at `expires_at`.
    - Accounts never verified: UNVERIFIED_ACCOUNT_RETENTION_DAYS after registration.
    - Finished processing jobs: PROCESSING_JOB_RETENTION_DAYS after they finished (a failed parse
      job is kept while its resume exists, so the user can still retry it)."""
    from app.models import Analysis, JDMatch, OpeningApplication, RoleRecommendation, User
    from app.services.account import delete_account, delete_resume

    s = get_settings()
    now = now or utcnow()
    storage = get_storage()
    removed = {"resumes": 0, "resumes_kept_in_use": 0, "exports": 0, "analyses": 0, "uploaded_candidates": 0,
               "unverified_accounts": 0, "processing_jobs": 0}
    keep_for = timedelta(days=s.file_retention_days)

    due = list(db.scalars(select(Resume.id).where(Resume.retention_until.is_not(None), Resume.retention_until < now)
                          .order_by(Resume.retention_until)))
    for chunk in _batches(due, batch_size):
        for rid in chunk:
            r = db.get(Resume, rid)
            if r is None:
                continue
            last = resume_last_activity(db, r)
            if last + keep_for > now:
                r.retention_until = last + keep_for
                removed["resumes_kept_in_use"] += 1
            elif has_open_application(db, r):
                r.retention_until = now + OPEN_APPLICATION_RECHECK
                removed["resumes_kept_in_use"] += 1
            else:
                delete_resume(db, r)
                removed["resumes"] += 1
        db.commit()

    cutoff = now - timedelta(days=s.analysis_retention_days)
    for model in (Analysis, RoleRecommendation, JDMatch):
        ids = list(db.scalars(select(model.id).where(model.created_at < cutoff)))
        for chunk in _batches(ids, batch_size):
            db.execute(delete(model).where(model.id.in_(chunk)))
            db.commit()
            removed["analyses"] += len(chunk)

    ids = list(db.scalars(select(Export.id).where(Export.created_at < now - timedelta(days=30))))
    for chunk in _batches(ids, batch_size):
        for e in db.scalars(select(Export).where(Export.id.in_(chunk))):
            if e.file_key:
                storage.delete(e.file_key)
            db.delete(e)
            removed["exports"] += 1
        db.commit()

    ids = list(db.scalars(select(OpeningApplication.id).where(OpeningApplication.source == "uploaded",
                                                              OpeningApplication.expires_at.is_not(None),
                                                              OpeningApplication.expires_at < now)))
    for chunk in _batches(ids, batch_size):
        for a in db.scalars(select(OpeningApplication).where(OpeningApplication.id.in_(chunk))):
            db.delete(a)
            removed["uploaded_candidates"] += 1
        db.commit()

    unverified_cutoff = now - timedelta(days=s.unverified_account_retention_days)
    ids = list(db.scalars(select(User.id).where(User.email_verified_at.is_(None), User.created_at < unverified_cutoff)))
    for uid in ids:  # delete_account commits per account
        u = db.get(User, uid)
        if u is not None and u.email_verified_at is None:
            delete_account(db, u)
            removed["unverified_accounts"] += 1

    job_cutoff = now - timedelta(days=s.processing_job_retention_days)
    finished = list(db.execute(
        select(ProcessingJob.id, ProcessingJob.kind, ProcessingJob.status, ProcessingJob.target_id)
        .where(ProcessingJob.status.in_(("succeeded", "failed")),
               func.coalesce(ProcessingJob.finished_at, ProcessingJob.updated_at) < job_cutoff)
    ))
    failed_parse_targets = {t for _, kind, st, t in finished if kind == "parse_resume" and st == "failed"}
    live = set(db.scalars(select(Resume.id).where(Resume.id.in_(failed_parse_targets)))) if failed_parse_targets else set()
    ids = [jid for jid, kind, st, t in finished if not (kind == "parse_resume" and st == "failed" and t in live)]
    for chunk in _batches(ids, batch_size):
        db.execute(delete(ProcessingJob).where(ProcessingJob.id.in_(chunk)))
        db.commit()
        removed["processing_jobs"] += len(chunk)
    db.commit()
    return removed
