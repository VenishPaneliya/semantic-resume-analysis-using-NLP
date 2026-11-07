from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.config import get_settings
from app.db import get_db
from app.models import Export, Resume, User
from app.services.editor import latest_version
from app.services.export.render import TEMPLATES, safe_filename
from app.services.jobs import dispatch, enqueue
from app.services.storage import sign_download
from app.versions import EXPORT_VERSION

router = APIRouter(prefix="/api", tags=["exports"])


class ExportIn(BaseModel):
    format: Literal["pdf", "docx"]
    template: Literal["student", "professional", "technical"] = "professional"
    page_size: Literal["A4", "LETTER"] = "A4"


def export_out(e: Export) -> dict:
    return {"id": e.id, "version_id": e.version_id, "format": e.format, "template": e.template, "page_size": e.page_size,
            "status": e.status, "page_count": e.page_count, "unresolved_placeholders": e.unresolved_placeholders,
            "error_message": e.error_message, "created_at": e.created_at.isoformat()}


@router.get("/templates")
def templates():
    return [{"id": t.id, "name": t.name, "description": t.description, "recommended_order": list(t.recommended_order)} for t in TEMPLATES.values()]


@router.post("/resumes/{resume_id}/exports", status_code=202)
def create_export(resume_id: str, body: ExportIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Always exports the latest saved version of the resume."""
    r = get_owned(db, Resume, resume_id, user)
    v = latest_version(db, r.id)
    if v is None:
        raise err(409, "not_confirmed", "Confirm the extraction before exporting.")
    existing = db.scalar(select(Export).where(Export.version_id == v.id, Export.format == body.format, Export.template == body.template,
                                              Export.page_size == body.page_size, Export.status == "ready"))
    if existing:
        return export_out(existing)
    e = Export(user_id=user.id, version_id=v.id, format=body.format, template=body.template, page_size=body.page_size,
               content_hash=v.content_hash)
    db.add(e)
    db.commit()
    job = enqueue(db, user_id=user.id, kind="export", target_id=e.id,
                  key=f"export:{e.id}:{v.content_hash}:{EXPORT_VERSION}", max_attempts=2)
    dispatch(job.id)
    db.refresh(e)
    return export_out(e)


@router.get("/exports/{export_id}")
def get_export(export_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return export_out(get_owned(db, Export, export_id, user))


@router.get("/exports/{export_id}/link")
def export_link(export_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    e = get_owned(db, Export, export_id, user)
    if e.status != "ready" or not e.file_key:
        raise err(409, "not_ready", "The export is not ready yet.")
    from app.models import ResumeVersion

    v = db.get(ResumeVersion, e.version_id)
    name = (v.content.get("contact", {}) or {}).get("name") if v else None
    ctype = "application/pdf" if e.format == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    tok = sign_download(user.id, e.file_key, safe_filename(name, e.format), ctype)
    return {"url": f"/api/files/download?token={tok}", "expires_in": get_settings().signed_url_ttl_seconds,
            "unresolved_placeholders": e.unresolved_placeholders}
