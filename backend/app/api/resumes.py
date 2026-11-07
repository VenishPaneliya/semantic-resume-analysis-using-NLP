from __future__ import annotations

import re
from datetime import timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, Request, Response, UploadFile
from fastapi.responses import Response as RawResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import client_ip, err, get_owned, verified_user
from app.config import get_settings
from app.db import get_db
from app.models import ProcessingJob, Resume, UsageEvent, User, utcnow
from app.schemas.resume import ResumeContent
from app.security.crypto import sha256_hex
from app.services.account import delete_resume
from app.services.audit import audit
from app.services.editor import create_version, latest_version
from app.services.jobs import dispatch, enqueue
from app.services.storage import get_storage, sign_download, verify_download
from app.services.upload_validation import validate_upload

router = APIRouter(prefix="/api", tags=["resumes"])


class ResumeOut(BaseModel):
    id: str
    title: str
    original_filename: str
    file_kind: str
    size_bytes: int
    page_count: int | None
    status: str
    error_code: str | None
    error_message: str | None
    created_at: str
    latest_version_id: str | None
    latest_version_number: int | None
    source_resume_id: str | None
    target_role: str | None
    job: dict | None = None


def resume_out(db: Session, r: Resume) -> ResumeOut:
    v = latest_version(db, r.id)
    job = db.scalar(select(ProcessingJob).where(ProcessingJob.target_id == r.id, ProcessingJob.kind == "parse_resume")
                    .order_by(ProcessingJob.created_at.desc()).limit(1))
    return ResumeOut(
        id=r.id, title=r.title, original_filename=r.original_filename, file_kind=r.file_kind, size_bytes=r.size_bytes,
        page_count=r.page_count, status=r.status, error_code=r.error_code, error_message=r.error_message,
        created_at=r.created_at.isoformat(), latest_version_id=v.id if v else None, latest_version_number=v.number if v else None,
        source_resume_id=r.source_resume_id, target_role=r.target_role,
        job={"id": job.id, "status": job.status, "stage": job.stage, "progress": job.progress, "attempts": job.attempts,
             "max_attempts": job.max_attempts, "error_code": job.error_code, "error_message": job.error_message} if job else None,
    )


@router.post("/resumes", status_code=202, response_model=ResumeOut)
def upload(
    request: Request,
    file: UploadFile = File(...),
    title: str | None = Form(default=None, max_length=200),
    user: User = Depends(verified_user),
    db: Session = Depends(get_db),
):
    s = get_settings()
    since = utcnow() - timedelta(days=1)
    n = db.scalar(select(func.count(UsageEvent.id)).where(UsageEvent.user_id == user.id, UsageEvent.kind == "upload", UsageEvent.created_at >= since)) or 0
    if n >= s.uploads_per_day:
        raise err(429, "upload_quota", f"Daily upload limit reached ({s.uploads_per_day}).")
    data = file.file.read(s.max_upload_bytes + 1)
    v = validate_upload(file.filename or "", file.content_type, data)
    digest = sha256_hex(data)
    r = Resume(
        user_id=user.id, title=(title or (file.filename or "Resume").rsplit(".", 1)[0])[:200],
        original_filename=(file.filename or f"resume.{v.kind}")[-255:], file_key="", file_kind=v.kind,
        mime_type=v.mime_type, size_bytes=v.size, sha256=digest, page_count=v.page_count, status="processing",
        retention_until=utcnow() + timedelta(days=s.file_retention_days),
    )
    db.add(r)
    db.flush()
    r.file_key = f"users/{user.id}/resumes/{r.id}/original.{v.kind}"
    get_storage().put(r.file_key, data, v.mime_type)
    db.add(UsageEvent(user_id=user.id, kind="upload", operation=v.kind))
    audit(db, "resume.uploaded", user.id, "resume", r.id, ip=client_ip(request), kind=v.kind)
    db.commit()
    job = enqueue(db, user_id=user.id, kind="parse_resume", target_id=r.id, key=f"parse:{r.id}:{digest}")
    dispatch(job.id)
    db.refresh(r)
    return resume_out(db, r)


@router.get("/resumes", response_model=list[ResumeOut])
def list_resumes(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Resume).where(Resume.user_id == user.id).order_by(Resume.created_at.desc()))
    return [resume_out(db, r) for r in rows]


@router.get("/resumes/{resume_id}", response_model=ResumeOut)
def get_resume(resume_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return resume_out(db, get_owned(db, Resume, resume_id, user))


@router.get("/resumes/{resume_id}/extraction")
def get_extraction(resume_id: str, include_text: bool = Query(False), user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = get_owned(db, Resume, resume_id, user)
    ex = r.extraction
    if ex is None:
        if r.status == "failed":
            raise err(422, r.error_code or "processing_failed", r.error_message or "Processing failed.")
        raise err(409, "not_ready", "Extraction is still in progress.")
    out = {
        "resume_id": r.id, "status": r.status, "content": ex.fields.get("content"), "evidence": ex.fields.get("evidence", {}),
        "confidence": ex.fields.get("confidence", {}), "uncertain": ex.fields.get("uncertain", []),
        "detected_sections": ex.fields.get("detected_sections", []), "unparsed_sections": ex.fields.get("unparsed_sections", []),
        "unrecognized_skills": ex.fields.get("unrecognized_skills", []), "warnings": ex.warnings, "layout": ex.layout,
        "ocr_used": ex.ocr_used, "parser_version": ex.parser_version, "extractor_version": ex.extractor_version, "pages": ex.pages,
    }
    if include_text:
        out["raw_text"] = ex.raw_text
    return out


class ReviewIn(BaseModel):
    content: ResumeContent
    label: str | None = Field(default="Confirmed extraction", max_length=120)


@router.put("/resumes/{resume_id}/review")
def confirm_review(resume_id: str, body: ReviewIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """User-reviewed (and possibly corrected) extraction becomes confirmed version 1.
    Subsequent edits go through the versions API."""
    r = get_owned(db, Resume, resume_id, user)
    if r.extraction is None:
        raise err(409, "not_ready", "Extraction has not finished.")
    if latest_version(db, r.id) is not None:
        raise err(409, "already_confirmed", "This resume already has a confirmed version; edit it in the editor.")
    v = create_version(db, r, body.content, source="extracted", label=body.label)
    r.status = "ready"
    audit(db, "resume.confirmed", user.id, "resume", r.id)
    db.commit()
    return {"version_id": v.id, "number": v.number}


class VariantIn(BaseModel):
    title: str = Field(max_length=200)
    target_role: str | None = Field(default=None, max_length=64)
    from_version_id: str | None = None


@router.post("/resumes/{resume_id}/variants", response_model=ResumeOut, status_code=201)
def create_variant(resume_id: str, body: VariantIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Create a targeted resume (e.g. for a specific role) that starts from an existing
    version. It shares the original upload, which is never modified."""
    src = get_owned(db, Resume, resume_id, user)
    from app.models import ResumeVersion

    base = get_owned(db, ResumeVersion, body.from_version_id, user) if body.from_version_id else latest_version(db, src.id)
    if base is None or base.resume_id != src.id:
        raise err(409, "no_version", "Confirm the extraction before creating variants.")
    r = Resume(user_id=user.id, title=body.title, original_filename=src.original_filename, file_key=src.file_key,
               file_kind=src.file_kind, mime_type=src.mime_type, size_bytes=src.size_bytes, sha256=src.sha256,
               page_count=src.page_count, status="ready", source_resume_id=src.source_resume_id or src.id,
               target_role=body.target_role, retention_until=src.retention_until)
    db.add(r)
    db.flush()
    create_version(db, r, base.content, source="restore", label=f"Created from '{src.title}' v{base.number}", parent_id=base.id,
                   target_role=body.target_role)
    db.commit()
    return resume_out(db, r)


@router.delete("/resumes/{resume_id}", status_code=204)
def remove(resume_id: str, request: Request, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = get_owned(db, Resume, resume_id, user)
    delete_resume(db, r)
    audit(db, "resume.deleted", user.id, "resume", resume_id, ip=client_ip(request))
    db.commit()
    return Response(status_code=204)


@router.get("/resumes/{resume_id}/original-link")
def original_link(resume_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = get_owned(db, Resume, resume_id, user)
    tok = sign_download(user.id, r.file_key, r.original_filename, r.mime_type)
    return {"url": f"/api/files/download?token={tok}", "expires_in": get_settings().signed_url_ttl_seconds}


@router.get("/files/download", include_in_schema=True)
def download(token: str, user: User = Depends(verified_user)):
    """Short-lived signed download. The token is bound to the requesting user, so a leaked
    link is useless to anyone else and expires after SIGNED_URL_TTL_SECONDS."""
    try:
        claims = verify_download(token)
    except PermissionError as exc:
        raise err(403, "link_expired", "This download link has expired. Request a new one.") from exc
    if claims["u"] != user.id:
        raise err(404, "not_found", "File not found.")
    try:
        data = get_storage().get(claims["k"])
    except (FileNotFoundError, ValueError) as exc:
        raise err(404, "not_found", "File not found.") from exc
    raw = re.sub(r'[\r\n"\\]', "", claims["f"])[:200]
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("_") or "download"
    disp = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(raw)}"
    return RawResponse(data, media_type=claims["t"], headers={"content-disposition": disp, "cache-control": "no-store"})
