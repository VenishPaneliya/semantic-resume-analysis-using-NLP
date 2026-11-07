from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.db import get_db
from app.models import Analysis, Extraction, Resume, ResumeVersion, RoleRecommendation, User
from app.schemas.resume import ResumeContent
from app.security.crypto import sha256_hex
from app.services.analysis.rubric import analyse, published_rubric
from app.services.editor import content_diff, create_version, latest_version
from app.services.ml.embeddings import get_embedder
from app.services.ml.recommender import recommend, skill_gap
from app.services.taxonomy import get_taxonomy
from app.versions import RECOMMENDER_VERSION, RUBRIC_VERSION

router = APIRouter(prefix="/api", tags=["versions"])


class VersionOut(BaseModel):
    id: str
    resume_id: str
    number: int
    label: str | None
    source: str
    parent_id: str | None
    created_at: str
    content_hash: str
    target_role: str | None
    is_latest: bool
    content: dict | None = None


def version_out(v: ResumeVersion, latest_id: str | None, with_content: bool = True) -> VersionOut:
    return VersionOut(id=v.id, resume_id=v.resume_id, number=v.number, label=v.label, source=v.source, parent_id=v.parent_id,
                      created_at=v.created_at.isoformat(), content_hash=v.content_hash, target_role=v.target_role,
                      is_latest=v.id == latest_id, content=v.content if with_content else None)


def extraction_for(db: Session, resume: Resume) -> dict | None:
    rid = resume.source_resume_id or resume.id
    ex = db.scalar(select(Extraction).where(Extraction.resume_id == rid))
    if not ex:
        return None
    return {"uncertain": ex.fields.get("uncertain", []), "unparsed_sections": ex.fields.get("unparsed_sections", []),
            "warnings": ex.warnings, "layout": ex.layout, "ocr_used": ex.ocr_used}


@router.get("/rubric")
def rubric():
    """The published scoring rubric (weights, rules, rationale)."""
    return published_rubric()


@router.get("/taxonomy/roles")
def roles():
    tax = get_taxonomy()
    return {"version": tax.version, "roles": [
        {"id": r.id, "title": r.title, "description": r.description, "required_skills": r.required_skills,
         "preferred_skills": r.preferred_skills, "responsibilities": r.responsibilities, "related_titles": r.related_titles,
         "domains": r.domains} for r in tax.roles.values()], "seniority_bands": tax.seniority_bands}


@router.get("/resumes/{resume_id}/versions", response_model=list[VersionOut])
def list_versions(resume_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = get_owned(db, Resume, resume_id, user)
    latest = latest_version(db, r.id)
    rows = db.scalars(select(ResumeVersion).where(ResumeVersion.resume_id == r.id).order_by(ResumeVersion.number.desc()))
    return [version_out(v, latest.id if latest else None, with_content=False) for v in rows]


@router.get("/versions/{version_id}", response_model=VersionOut)
def get_version(version_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    latest = latest_version(db, v.resume_id)
    return version_out(v, latest.id if latest else None)


class SaveIn(BaseModel):
    base_version_id: str
    content: ResumeContent
    label: str | None = Field(default=None, max_length=120)


@router.post("/resumes/{resume_id}/versions", response_model=VersionOut, status_code=201)
def save_version(resume_id: str, body: SaveIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Save a user edit as a new version. `base_version_id` must be the latest version
    (optimistic concurrency) so edits made in another tab are never silently lost."""
    r = get_owned(db, Resume, resume_id, user)
    latest = latest_version(db, r.id)
    if latest is None:
        raise err(409, "not_confirmed", "Confirm the extraction first.")
    if body.base_version_id != latest.id:
        raise err(409, "stale_version", f"A newer version (v{latest.number}) exists. Reload before saving.")
    if body.content.model_dump() == latest.content:
        return version_out(latest, latest.id)
    v = create_version(db, r, body.content, source="user_edit", label=body.label or "Manual edit", parent_id=latest.id)
    db.commit()
    return version_out(v, v.id)


@router.post("/versions/{version_id}/restore", response_model=VersionOut, status_code=201)
def restore(version_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Undo/restore: creates a new latest version with the old content (history is append-only)."""
    old = get_owned(db, ResumeVersion, version_id, user)
    r = db.get(Resume, old.resume_id)
    assert r
    latest = latest_version(db, r.id)
    v = create_version(db, r, old.content, source="restore", label=f"Restored v{old.number}", parent_id=latest.id if latest else None)
    db.commit()
    return version_out(v, v.id)


def _analysis(db: Session, v: ResumeVersion, target_role: str | None) -> dict:
    r = db.get(Resume, v.resume_id)
    assert r
    ex = extraction_for(db, r)
    tax = get_taxonomy()
    key = sha256_hex(json.dumps([v.content_hash, RUBRIC_VERSION, tax.version, target_role, bool(ex),
                                 ex and len(ex["uncertain"])], default=str))
    cached = db.scalar(select(Analysis).where(Analysis.version_id == v.id, Analysis.cache_key == key))
    if cached:
        return {**cached.result, "analysis_id": cached.id, "cached": True, "created_at": cached.created_at.isoformat()}
    result = analyse(v.content, ex, target_role=target_role)
    row = Analysis(user_id=v.user_id, version_id=v.id, cache_key=key, target_role=target_role, rubric_version=RUBRIC_VERSION,
                   taxonomy_version=tax.version, result=result)
    db.add(row)
    db.commit()
    return {**result, "analysis_id": row.id, "cached": False, "created_at": row.created_at.isoformat()}


@router.get("/versions/{version_id}/analysis")
def get_analysis(version_id: str, target_role: str | None = Query(None, max_length=64), user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    if target_role and target_role not in get_taxonomy().roles:
        raise err(422, "unknown_role", "Unknown role.")
    return _analysis(db, v, target_role)


class RecIn(BaseModel):
    target_roles: list[str] | None = Field(default=None, max_length=10)
    domains: list[str] | None = Field(default=None, max_length=10)
    locations: list[str] | None = Field(default=None, max_length=10)
    work_arrangements: list[str] | None = Field(default=None, max_length=3)


@router.post("/versions/{version_id}/recommendations")
def recommendations(version_id: str, body: RecIn | None = None, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    prefs = {**(user.career_prefs or {}), **{k: val for k, val in (body.model_dump() if body else {}).items() if val is not None}}
    emb = get_embedder()
    tax = get_taxonomy()
    key = sha256_hex(json.dumps([v.content_hash, RECOMMENDER_VERSION, emb.name, tax.version, prefs], sort_keys=True))
    cached = db.scalar(select(RoleRecommendation).where(RoleRecommendation.version_id == v.id, RoleRecommendation.cache_key == key))
    if cached:
        return {**cached.result, "cached": True, "created_at": cached.created_at.isoformat()}
    result = recommend(v.content, prefs)
    note = ("Location and work-arrangement preferences are recorded but not used for ranking: role profiles are "
            "location-independent and no job-listing provider is configured.") if (prefs.get("locations") or prefs.get("work_arrangements")) else None
    if note:
        result["preference_note"] = note
    row = RoleRecommendation(user_id=user.id, version_id=v.id, cache_key=key, preferences=prefs, recommender_version=RECOMMENDER_VERSION,
                             embedding_model=emb.name, taxonomy_version=tax.version, result=result)
    db.add(row)
    db.commit()
    return {**result, "cached": False, "created_at": row.created_at.isoformat()}


@router.get("/versions/{version_id}/skill-gap")
def gap(version_id: str, roles: list[str] = Query(default=[]), user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    role_ids = roles or (user.career_prefs or {}).get("target_roles") or []
    if not role_ids:
        rec = recommend(v.content, user.career_prefs or {})
        role_ids = [r["role_id"] for r in rec.get("recommendations", [])[:2]]
    unknown = [r for r in role_ids if r not in get_taxonomy().roles]
    if unknown:
        raise err(422, "unknown_role", f"Unknown roles: {', '.join(unknown)}")
    return {"roles": skill_gap(v.content, role_ids[:4]), "taxonomy_version": get_taxonomy().version}


@router.get("/versions/{a_id}/compare/{b_id}")
def compare(a_id: str, b_id: str, target_role: str | None = Query(None, max_length=64), user: User = Depends(verified_user),
            db: Session = Depends(get_db)):
    """Compare two versions (any of the user's resumes): content diff + analysis deltas."""
    if target_role and target_role not in get_taxonomy().roles:
        raise err(422, "unknown_role", "Unknown role.")
    a = get_owned(db, ResumeVersion, a_id, user)
    b = get_owned(db, ResumeVersion, b_id, user)
    aa, ab = _analysis(db, a, target_role), _analysis(db, b, target_role)
    cats = []
    for ca, cb in zip(aa["categories"], ab["categories"], strict=True):
        cats.append({"id": ca["id"], "name": ca["name"], "a": ca["score"], "b": cb["score"],
                     "delta": None if ca["score"] is None or cb["score"] is None else cb["score"] - ca["score"]})
    return {
        "a": {"id": a.id, "number": a.number, "label": a.label, "resume_id": a.resume_id},
        "b": {"id": b.id, "number": b.number, "label": b.label, "resume_id": b.resume_id},
        "overall": {"a": aa["overall"], "b": ab["overall"]},
        "categories": cats,
        "changes": content_diff(a.content, b.content),
        "rubric_version": RUBRIC_VERSION,
    }
