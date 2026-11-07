"""Leaderboards (A, B), standing among applicants (C), relevance-gated tips (D), and the
recruiter side of job openings."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, recruiter_user, verified_user
from app.db import get_db
from app.models import JobOpening, OpeningApplication, ResumeVersion, User
from app.services.audit import audit
from app.services.ml.jd import extract_jd, match
from app.services.ml.leaderboard import (
    fit_for_opening,
    fit_for_role,
    infer_role,
    opening_row,
    role_leaderboard,
    standing,
    tailoring_tips,
    tier_for,
)
from app.services.taxonomy import get_taxonomy
from app.versions import JD_MATCHER_VERSION, LEADERBOARD_VERSION

router = APIRouter(prefix="/api", tags=["leaderboard"])
MAX_OPENINGS_RANKED = 200

Arrangement = Literal["onsite", "hybrid", "remote"]
EmploymentType = Literal["full_time", "part_time", "contract", "internship"]


# ---------------------------------------------------------------- helpers


def opening_out(o: JobOpening, *, include_description: bool = False) -> dict:
    d = {"id": o.id, "title": o.title, "company": o.company, "location": o.location,
         "work_arrangement": o.work_arrangement, "employment_type": o.employment_type, "status": o.status,
         "role_id": o.role_id, "role_title": get_taxonomy().roles[o.role_id].title if o.role_id in get_taxonomy().roles else None,
         "is_demo": o.is_demo, "skills": o.extracted.get("skills", [])[:20],
         "years_required": o.extracted.get("years_required"), "created_at": o.created_at.isoformat(),
         "updated_at": o.updated_at.isoformat()}
    if include_description:
        d["description"] = o.description
        d["requirements"] = [{"text": r["text"], "importance": r["importance"], "kind": r["kind"]}
                             for r in o.extracted.get("requirements", [])]
        d["responsibilities"] = o.extracted.get("responsibilities", [])
    return d


def _open_opening(db: Session, opening_id: str) -> JobOpening:
    o = db.get(JobOpening, opening_id)
    if not o or o.status != "open":
        raise err(404, "not_found", "This opening is not available.")
    return o


def _scores(db: Session, opening_id: str) -> list[float]:
    return [float(s) for s in db.scalars(select(OpeningApplication.score).where(OpeningApplication.opening_id == opening_id))]


def _my_application(db: Session, opening_id: str, user: User) -> OpeningApplication | None:
    return db.scalar(select(OpeningApplication).where(OpeningApplication.opening_id == opening_id,
                                                      OpeningApplication.user_id == user.id))


def _application_out(db: Session, a: OpeningApplication) -> dict:
    return {"id": a.id, "version_id": a.version_id, "score": a.score, "tier": tier_for(a.score), "stage": a.stage,
            "applied_at": a.created_at.isoformat(), "updated_at": a.updated_at.isoformat(),
            "standing": standing(a.score, _scores(db, a.opening_id))}


# ---------------------------------------------------------------- A. roles for me


@router.get("/versions/{version_id}/leaderboard/roles")
def roles_for_me(version_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    return role_leaderboard(v.content, user.career_prefs or {})


# ---------------------------------------------------------------- B. openings for me


@router.get("/versions/{version_id}/leaderboard/openings")
def openings_for_me(version_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    openings = list(db.scalars(select(JobOpening).where(JobOpening.status == "open")
                               .order_by(JobOpening.created_at.desc()).limit(MAX_OPENINGS_RANKED)))
    mine = {a.opening_id: a for a in db.scalars(select(OpeningApplication).where(OpeningApplication.user_id == user.id))}
    rows = []
    for o in openings:
        row = {**opening_out(o), **opening_row(match(v.content, o.extracted))}
        a = mine.get(o.id)
        row["application"] = None if not a else {"score": a.score, "stage": a.stage, "version_id": a.version_id}
        rows.append(row)
    rows.sort(key=lambda r: (-(r["score"] if r["score"] is not None else -1), r["title"]))
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return {"leaderboard_version": LEADERBOARD_VERSION, "matcher_version": JD_MATCHER_VERSION, "rows": rows,
            "status": "ok" if rows else "no_openings",
            "message": None if rows else "No openings have been posted yet. Check back soon.",
            "disclaimer": "Compatibility indicators, not hiring probabilities. Openings are posted by the HR team."}


# ---------------------------------------------------------------- D. tips (relevance-gated)


@router.get("/versions/{version_id}/tips")
def tips(version_id: str, role_id: str | None = Query(None, max_length=64), opening_id: str | None = Query(None, max_length=36),
         user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    if bool(role_id) == bool(opening_id):
        raise err(422, "missing_target", "Choose exactly one role or opening.")
    if role_id:
        if role_id not in get_taxonomy().roles:
            raise err(422, "unknown_role", "Unknown role.")
        score, cov = fit_for_role(v.content, role_id)
        return tailoring_tips(v.content, score, core_coverage=cov, role_id=role_id)
    o = _open_opening(db, opening_id)  # type: ignore[arg-type]
    score, cov, _m = fit_for_opening(v.content, o.extracted)
    return tailoring_tips(v.content, score, core_coverage=cov, opening={"id": o.id, "title": o.title, "extracted": o.extracted})


# ---------------------------------------------------------------- openings (candidate side)


@router.get("/openings")
def list_openings(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(JobOpening).where(JobOpening.status == "open").order_by(JobOpening.created_at.desc()).limit(MAX_OPENINGS_RANKED))
    return [opening_out(o) for o in rows]


@router.get("/openings/{opening_id}")
def get_opening(opening_id: str, version_id: str | None = Query(None, max_length=36), user: User = Depends(verified_user),
                db: Session = Depends(get_db)):
    o = _open_opening(db, opening_id)
    out = {**opening_out(o, include_description=True), "application": None, "match": None}
    a = _my_application(db, o.id, user)
    if a:
        out["application"] = _application_out(db, a)
    vid = version_id or (a.version_id if a else None)
    if vid:
        v = get_owned(db, ResumeVersion, vid, user)
        m = match(v.content, o.extracted)
        out["match"] = {**m, "version_id": v.id, "tier": tier_for(m["overall"])}
    return out


class ApplyIn(BaseModel):
    version_id: str = Field(max_length=36)
    share_consent: bool = Field(description="Candidate agrees that the HR team can see this resume version and score.")


@router.post("/openings/{opening_id}/apply", status_code=201)
def apply(opening_id: str, body: ApplyIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    if not body.share_consent:
        raise err(422, "consent_required", "To apply, agree to share this resume with the HR team for this opening.")
    o = _open_opening(db, opening_id)
    v = get_owned(db, ResumeVersion, body.version_id, user)
    m = match(v.content, o.extracted)
    score = float(m["overall"] or 0)
    a = _my_application(db, o.id, user)
    if a:
        a.version_id, a.score, a.result, a.matcher_version = v.id, score, m, JD_MATCHER_VERSION
        action = "opening.reapplied"
    else:
        a = OpeningApplication(opening_id=o.id, user_id=user.id, version_id=v.id, score=score, result=m,
                               matcher_version=JD_MATCHER_VERSION)
        db.add(a)
        action = "opening.applied"
    db.flush()
    audit(db, action, user.id, "opening", o.id)
    db.commit()
    return _application_out(db, a)


@router.delete("/openings/{opening_id}/apply", status_code=204)
def withdraw(opening_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = _my_application(db, opening_id, user)
    if not a:
        raise err(404, "not_found", "You haven't applied to this opening.")
    db.delete(a)
    audit(db, "opening.withdrawn", user.id, "opening", opening_id)
    db.commit()
    return Response(status_code=204)


@router.get("/openings/{opening_id}/standing")
def my_standing(opening_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    o = _open_opening(db, opening_id)
    a = _my_application(db, o.id, user)
    if not a:
        raise err(404, "not_applied", "Apply to this opening to see where you stand.")
    return _application_out(db, a)


@router.get("/me/opening-applications")
def my_applications(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    out = []
    for a in db.scalars(select(OpeningApplication).where(OpeningApplication.user_id == user.id)
                        .order_by(OpeningApplication.created_at.desc())):
        o = db.get(JobOpening, a.opening_id)
        assert o
        out.append({"opening": opening_out(o), **_application_out(db, a)})
    return out


# ---------------------------------------------------------------- recruiter side


class OpeningIn(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    company: str = Field(min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    work_arrangement: Arrangement | None = None
    employment_type: EmploymentType | None = None
    description: str = Field(min_length=80, max_length=30000)


class OpeningPatch(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=200)
    company: str | None = Field(default=None, min_length=1, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    work_arrangement: Arrangement | None = None
    employment_type: EmploymentType | None = None
    description: str | None = Field(default=None, min_length=80, max_length=30000)
    status: Literal["open", "closed"] | None = None


def _extract(o: JobOpening) -> None:
    ex = extract_jd(f"{o.title}\n{o.description}")
    ex["title"] = o.title
    o.extracted = ex
    o.role_id = infer_role(ex)


def _rescore(db: Session, o: JobOpening) -> int:
    n = 0
    for a in db.scalars(select(OpeningApplication).where(OpeningApplication.opening_id == o.id)):
        v = db.get(ResumeVersion, a.version_id)
        if v:
            m = match(v.content, o.extracted)
            a.score, a.result, a.matcher_version = float(m["overall"] or 0), m, JD_MATCHER_VERSION
            n += 1
    return n


def _recruiter_opening(db: Session, opening_id: str) -> JobOpening:
    o = db.get(JobOpening, opening_id)
    if not o:
        raise err(404, "not_found", "Opening not found.")
    return o


@router.get("/recruiter/openings", tags=["recruiter"])
def r_list(user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    out = []
    for o in db.scalars(select(JobOpening).order_by(JobOpening.created_at.desc())):
        scores = _scores(db, o.id)
        out.append({**opening_out(o), "applicants": len(scores), "top_score": max(scores) if scores else None})
    return out


@router.post("/recruiter/openings", status_code=201, tags=["recruiter"])
def r_create(body: OpeningIn, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = JobOpening(posted_by=user.id, **body.model_dump())
    _extract(o)
    db.add(o)
    db.flush()
    audit(db, "opening.created", user.id, "opening", o.id)
    db.commit()
    return {**opening_out(o, include_description=True), "warnings": o.extracted.get("warnings", [])}


@router.get("/recruiter/openings/{opening_id}", tags=["recruiter"])
def r_get(opening_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = _recruiter_opening(db, opening_id)
    return {**opening_out(o, include_description=True), "applicants": len(_scores(db, o.id))}


@router.patch("/recruiter/openings/{opening_id}", tags=["recruiter"])
def r_update(opening_id: str, body: OpeningPatch, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = _recruiter_opening(db, opening_id)
    data = body.model_dump(exclude_unset=True)
    for k, val in data.items():
        setattr(o, k, val)
    rescored = 0
    if {"title", "description"} & data.keys():
        _extract(o)
        rescored = _rescore(db, o)
    audit(db, "opening.updated", user.id, "opening", o.id, fields=sorted(data))
    db.commit()
    return {**opening_out(o, include_description=True), "rescored_applications": rescored}


@router.delete("/recruiter/openings/{opening_id}", status_code=204, tags=["recruiter"])
def r_delete(opening_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = _recruiter_opening(db, opening_id)
    db.delete(o)
    audit(db, "opening.deleted", user.id, "opening", opening_id)
    db.commit()
    return Response(status_code=204)


@router.get("/recruiter/openings/{opening_id}/candidates", tags=["recruiter"])
def r_candidates(opening_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    """Applicants ranked by compatibility. Only people who applied (and consented to share) appear."""
    o = _recruiter_opening(db, opening_id)
    apps = list(db.scalars(select(OpeningApplication).where(OpeningApplication.opening_id == o.id)))
    apps.sort(key=lambda a: (-a.score, a.created_at))
    rows = []
    for i, a in enumerate(apps, 1):
        cand = db.get(User, a.user_id)
        assert cand
        r = a.result or {}
        rows.append({"rank": i, "application_id": a.id, "name": cand.display_name or cand.email.split("@")[0],
                     "email": cand.email, "score": a.score, "tier": tier_for(a.score), "stage": a.stage,
                     "counts": r.get("counts", {}), "keywords_matched": r.get("keywords", {}).get("present", []),
                     "keywords_missing": r.get("keywords", {}).get("absent", []),
                     "applied_at": a.created_at.isoformat(), "updated_at": a.updated_at.isoformat()})
    return {"opening": opening_out(o), "candidates": rows,
            "note": "Ranked by a compatibility indicator built from skills, requirements and wording. It does not use "
                    "names, contact details, employers, schools or protected attributes. Use it to prioritise reading, "
                    "not to reject people automatically."}


@router.get("/recruiter/applications/{application_id}", tags=["recruiter"])
def r_application(application_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    a = db.get(OpeningApplication, application_id)
    if not a:
        raise err(404, "not_found", "Application not found.")
    cand = db.get(User, a.user_id)
    v = db.get(ResumeVersion, a.version_id)
    assert cand and v
    audit(db, "recruiter.viewed_application", user.id, "application", a.id)
    db.commit()
    return {"id": a.id, "opening_id": a.opening_id, "name": cand.display_name or cand.email.split("@")[0], "email": cand.email,
            "score": a.score, "tier": tier_for(a.score), "stage": a.stage, "match": a.result, "resume": v.content,
            "applied_at": a.created_at.isoformat()}


class StageIn(BaseModel):
    stage: Literal["submitted", "shortlisted", "rejected"]


@router.patch("/recruiter/applications/{application_id}", tags=["recruiter"])
def r_stage(application_id: str, body: StageIn, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    a = db.get(OpeningApplication, application_id)
    if not a:
        raise err(404, "not_found", "Application not found.")
    a.stage = body.stage
    audit(db, "recruiter.stage_changed", user.id, "application", a.id, stage=body.stage)
    db.commit()
    return {"id": a.id, "stage": a.stage}
