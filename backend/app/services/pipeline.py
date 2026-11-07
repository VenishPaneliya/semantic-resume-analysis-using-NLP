"""Job handlers: resume parsing/extraction and document export."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
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
        raise JobError(exc.code, exc.message, exc.retryable) from exc
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


def retention_sweep(db: Session) -> dict:
    """Delete files and derived data past their retention windows."""
    s = get_settings()
    now = utcnow()
    storage = get_storage()
    removed = {"resumes": 0, "exports": 0, "analyses": 0}
    from app.models import Analysis, JDMatch, RoleRecommendation
    from app.services.account import delete_resume

    for r in db.scalars(select(Resume).where(Resume.retention_until.is_not(None), Resume.retention_until < now)):
        delete_resume(db, r)
        removed["resumes"] += 1
    cutoff = now - timedelta(days=s.analysis_retention_days)
    for model in (Analysis, RoleRecommendation, JDMatch):
        for row in db.scalars(select(model).where(model.created_at < cutoff)):
            db.delete(row)
            removed["analyses"] += 1
    for e in db.scalars(select(Export).where(Export.created_at < now - timedelta(days=30))):
        if e.file_key:
            storage.delete(e.file_key)
        db.delete(e)
        removed["exports"] += 1
    db.commit()
    return removed
