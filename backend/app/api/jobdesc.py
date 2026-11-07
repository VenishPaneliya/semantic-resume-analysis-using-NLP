from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.config import get_settings
from app.db import get_db
from app.models import JDMatch, JobDescription, ResumeVersion, UsageEvent, User, utcnow
from app.security.crypto import sha256_hex
from app.services.ml.embeddings import get_embedder
from app.services.ml.jd import extract_jd, match
from app.services.parsing.parsers import ParseError
from app.services.parsing.sandbox import parse_isolated
from app.services.upload_validation import validate_upload
from app.versions import JD_MATCHER_VERSION

router = APIRouter(prefix="/api/job-descriptions", tags=["job-descriptions"])


class JDIn(BaseModel):
    text: str = Field(min_length=40, max_length=30000)
    title: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=200)


def jd_out(j: JobDescription, include_text: bool = False) -> dict:
    out = {"id": j.id, "title": j.title, "company": j.company, "source": j.source, "extracted": j.extracted,
           "created_at": j.created_at.isoformat()}
    if include_text:
        out["text"] = j.raw_text
    return out


def _create(db: Session, user: User, text: str, title: str | None, company: str | None, source: str) -> JobDescription:
    ex = extract_jd(text)
    j = JobDescription(user_id=user.id, title=(title or ex.get("title") or "Untitled role")[:200],
                       company=(company or ex.get("company")), raw_text=text, extracted=ex, source=source)
    db.add(j)
    db.commit()
    return j


@router.post("", status_code=201)
def create(body: JDIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return jd_out(_create(db, user, body.text, body.title, body.company, "paste"))


@router.post("/upload", status_code=201)
def upload(file: UploadFile = File(...), title: str | None = Form(default=None), user: User = Depends(verified_user),
           db: Session = Depends(get_db)):
    # sync route: FastAPI runs it in the threadpool, so parsing never blocks the event loop
    s = get_settings()
    n = db.scalar(select(func.count(UsageEvent.id)).where(UsageEvent.user_id == user.id, UsageEvent.kind == "upload",
                                                          UsageEvent.created_at >= utcnow() - timedelta(days=1))) or 0
    if n >= s.uploads_per_day:
        raise err(429, "upload_quota", f"Daily upload limit reached ({s.uploads_per_day}).")
    data = file.file.read(s.max_upload_bytes + 1)
    v = validate_upload(file.filename or "", file.content_type, data)
    try:
        parsed = parse_isolated(v.kind, data)
    except ParseError as exc:
        raise err(422, exc.code, exc.message) from exc
    db.add(UsageEvent(user_id=user.id, kind="upload", operation=f"jd_{v.kind}"))
    return jd_out(_create(db, user, parsed["text"][:30000], title, None, "upload"))


@router.get("")
def list_jds(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return [jd_out(j) for j in db.scalars(select(JobDescription).where(JobDescription.user_id == user.id).order_by(JobDescription.created_at.desc()))]


@router.get("/{jd_id}")
def get_jd(jd_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return jd_out(get_owned(db, JobDescription, jd_id, user), include_text=True)


@router.delete("/{jd_id}", status_code=204)
def delete_jd(jd_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, JobDescription, jd_id, user))
    db.commit()
    return Response(status_code=204)


@router.post("/{jd_id}/match/{version_id}")
def match_jd(jd_id: str, version_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    j = get_owned(db, JobDescription, jd_id, user)
    v = get_owned(db, ResumeVersion, version_id, user)
    emb = get_embedder()
    key = sha256_hex(json.dumps([v.content_hash, j.id, j.updated_at.isoformat(), JD_MATCHER_VERSION, emb.name]))
    cached = db.scalar(select(JDMatch).where(JDMatch.version_id == v.id, JDMatch.jd_id == j.id, JDMatch.cache_key == key))
    if cached:
        return {**cached.result, "cached": True, "jd": jd_out(j)}
    result = match(v.content, j.extracted)
    db.add(JDMatch(user_id=user.id, version_id=v.id, jd_id=j.id, cache_key=key, matcher_version=JD_MATCHER_VERSION,
                   embedding_model=emb.name, result=result))
    db.commit()
    return {**result, "cached": False, "jd": jd_out(j)}
