"""Leaderboards (A, B), standing among applicants (C), relevance-gated tips (D), and the
recruiter side of job openings."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.db import get_db
from app.models import JobOpening, OpeningApplication, ResumeVersion, User
from app.services.audit import audit
from app.services.ml.jd import match
from app.services.ml.leaderboard import (
    TIERS,
    TIPS_MIN,
    fit_for_opening,
    fit_for_role,
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
    # only people who applied themselves count; recruiter bulk uploads never affect a candidate's standing
    return [float(s) for s in db.scalars(select(OpeningApplication.score).where(OpeningApplication.opening_id == opening_id,
                                                                                OpeningApplication.source == "applied"))]


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
            "tiers": [{"min": lo, "id": i, "label": lb} for lo, i, lb in TIERS], "tips_min_score": TIPS_MIN,
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
    o = db.get(JobOpening, opening_id)
    a = _my_application(db, o.id, user) if o else None
    if not o or (o.status != "open" and not a):
        # closed openings stay visible only to people who applied, so they can follow their stage
        raise err(404, "not_found", "This opening is not available.")
    out = {**opening_out(o, include_description=True), "application": None, "match": None}
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


