"""Account/document deletion and personal-data export."""

from __future__ import annotations

import io
import json
import zipfile

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AISuggestion,
    Analysis,
    Application,
    AuditLog,
    CareerArtifact,
    Export,
    JDMatch,
    JobDescription,
    OpeningApplication,
    ProcessingJob,
    Resume,
    ResumeVersion,
    RoleRecommendation,
    UsageEvent,
    User,
    utcnow,
)
from app.services.audit import audit
from app.services.storage import get_storage


def delete_resume(db: Session, resume: Resume) -> None:
    """Delete a resume, all versions and every derived artefact, plus stored files. The
    shared original file is removed only when no variant still references it."""
    storage = get_storage()
    vids = list(db.scalars(select(ResumeVersion.id).where(ResumeVersion.resume_id == resume.id)))
    if vids:
        for e in db.scalars(select(Export).where(Export.version_id.in_(vids))):
            if e.file_key:
                storage.delete(e.file_key)
            for job in db.scalars(select(ProcessingJob).where(ProcessingJob.target_id == e.id)):
                db.delete(job)
        for model in (Analysis, RoleRecommendation, JDMatch, AISuggestion, Export, CareerArtifact, OpeningApplication):
            for row in db.scalars(select(model).where(model.version_id.in_(vids))):
                db.delete(row)
        for app_row in db.scalars(select(Application).where(Application.resume_version_id.in_(vids))):
            app_row.resume_version_id = None
    for job in db.scalars(select(ProcessingJob).where(ProcessingJob.target_id == resume.id)):
        db.delete(job)
    others = db.scalars(select(Resume.id).where(Resume.file_key == resume.file_key, Resume.id != resume.id)).first()
    if not others:
        storage.delete(resume.file_key)
    db.delete(resume)  # cascades extraction + versions
    db.flush()


def delete_account(db: Session, user: User, ip: str | None = None) -> dict:
    storage = get_storage()
    counts = {"resumes": 0, "files_removed": 0}
    for r in list(db.scalars(select(Resume).where(Resume.user_id == user.id))):
        delete_resume(db, r)
        counts["resumes"] += 1
    counts["files_removed"] = storage.delete_prefix(f"users/{user.id}/")
    for model in (JobDescription, Application, CareerArtifact, OpeningApplication):
        for row in db.scalars(select(model).where(model.user_id == user.id)):
            db.delete(row)
    for ev in db.scalars(select(UsageEvent).where(UsageEvent.user_id == user.id)):
        ev.user_id = None  # keep anonymous aggregate cost data
    uid = user.id
    db.delete(user)  # cascades sessions, tokens, oauth accounts
    audit(db, "account.deleted", uid, "user", uid, ip=ip, count=counts["resumes"])
    db.commit()
    return counts


def export_user_data(db: Session, user: User) -> bytes:
    """ZIP with JSON of all personal data plus original uploads."""
    storage = get_storage()
    buf = io.BytesIO()

    def rows(model, **flt):
        q = select(model)
        for k, v in flt.items():
            q = q.where(getattr(model, k) == v)
        out = []
        for r in db.scalars(q):
            d = {c.name: getattr(r, c.name) for c in r.__table__.columns}
            out.append({k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in d.items() if k not in ("password_hash", "token_hash")})
        return out

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", "Your Resume Intelligence data export. JSON files contain all records linked to your account.\n")
        z.writestr("account.json", json.dumps(rows(User, id=user.id), indent=2, default=str))
        resumes = rows(Resume, user_id=user.id)
        z.writestr("resumes.json", json.dumps(resumes, indent=2, default=str))
        for model, name in ((ResumeVersion, "versions"), (Analysis, "analyses"), (RoleRecommendation, "recommendations"),
                            (JDMatch, "jd_matches"), (JobDescription, "job_descriptions"), (AISuggestion, "ai_suggestions"),
                            (CareerArtifact, "career_artifacts"), (Application, "applications"), (OpeningApplication, "opening_applications"), (Export, "exports"),
                            (UsageEvent, "usage")):
            z.writestr(f"{name}.json", json.dumps(rows(model, user_id=user.id), indent=2, default=str))
        z.writestr("audit_log.json", json.dumps(rows(AuditLog, user_id=user.id), indent=2, default=str))
        for r in db.scalars(select(Resume).where(Resume.user_id == user.id, Resume.source_resume_id.is_(None))):
            try:
                z.writestr(f"uploads/{r.id}_{r.original_filename}", storage.get(r.file_key))
            except Exception:  # noqa: BLE001
                z.writestr(f"uploads/{r.id}_MISSING.txt", "Original file not available (deleted by retention policy).")
    audit(db, "account.data_exported", user.id, "user", user.id)
    db.commit()
    _ = utcnow
    return buf.getvalue()
