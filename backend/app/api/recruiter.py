"""Recruiter (HR staff) API: openings, ranked pipelines with filters, side-by-side comparison,
private notes, pipeline stages, and consent-attested bulk upload."""

from __future__ import annotations

import json
import time
from collections import Counter
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import admin_user, err, recruiter_user
from app.api.openings import opening_out
from app.config import get_settings
from app.db import get_db
from app.models import ApplicationNote, DemographicSelfId, JobOpening, OpeningApplication, User, utcnow
from app.services.audit import audit
from app.services.ml.leaderboard import tier_for
from app.services.openings import (
    ADVANCED_STAGES,
    STAGES,
    application_content,
    candidate_facts,
    extract_opening,
    parse_uploaded_resume,
    rescore_opening,
    score_application,
    upload_expiry,
)
from app.services.parsing.parsers import ParseError
from app.services.taxonomy import get_taxonomy
from app.services.upload_validation import UploadRejected, validate_upload

router = APIRouter(prefix="/api/recruiter", tags=["recruiter"])

Arrangement = Literal["onsite", "hybrid", "remote"]
EmploymentType = Literal["full_time", "part_time", "contract", "internship"]
Stage = Literal["submitted", "shortlisted", "interview", "offer", "hired", "rejected"]
FAIRNESS_NOTE = ("Ranked by a compatibility indicator built from skills, requirements and wording. It does not use names, "
                 "contact details, employers, schools or protected attributes. Use it to prioritise reading, not to reject "
                 "people automatically.")


# ---------------------------------------------------------------- openings


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


def _opening(db: Session, opening_id: str) -> JobOpening:
    o = db.get(JobOpening, opening_id)
    if not o:
        raise err(404, "not_found", "Opening not found.")
    return o


def _app(db: Session, application_id: str) -> OpeningApplication:
    a = db.get(OpeningApplication, application_id)
    if not a:
        raise err(404, "not_found", "Candidate not found.")
    return a


CANDIDATE_PAGE_DEFAULT = 100
CANDIDATE_PAGE_MAX = 500


def _pipeline(db: Session, opening_id: str) -> list[OpeningApplication]:
    return list(db.scalars(select(OpeningApplication).where(OpeningApplication.opening_id == opening_id)))


@router.get("/openings")
def r_list(user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    out = []
    for o in db.scalars(select(JobOpening).order_by(JobOpening.created_at.desc())):
        apps = _pipeline(db, o.id)
        stages = {s: sum(1 for a in apps if a.stage == s) for s in STAGES}
        out.append({**opening_out(o), "applicants": len(apps), "top_score": max((a.score for a in apps), default=None),
                    "stages": stages})
    return out


@router.post("/openings", status_code=201)
def r_create(body: OpeningIn, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = JobOpening(posted_by=user.id, **body.model_dump())
    extract_opening(o)
    db.add(o)
    db.flush()
    audit(db, "opening.created", user.id, "opening", o.id)
    db.commit()
    from app.services.alerts import queue_opening_alerts

    queue_opening_alerts(db, o)
    return {**opening_out(o, include_description=True), "warnings": o.extracted.get("warnings", [])}


@router.get("/openings/{opening_id}")
def r_get(opening_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = _opening(db, opening_id)
    return {**opening_out(o, include_description=True), "applicants": len(_pipeline(db, o.id))}


@router.patch("/openings/{opening_id}")
def r_update(opening_id: str, body: OpeningPatch, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = _opening(db, opening_id)
    data = body.model_dump(exclude_unset=True)
    reopened = data.get("status") == "open" and o.status != "open"
    for k, val in data.items():
        setattr(o, k, val)
    rescored = 0
    if {"title", "description"} & data.keys():
        extract_opening(o)
        rescored = rescore_opening(db, o)
    audit(db, "opening.updated", user.id, "opening", o.id, fields=sorted(data))
    db.commit()
    if reopened:
        from app.services.alerts import queue_opening_alerts

        queue_opening_alerts(db, o)
    return {**opening_out(o, include_description=True), "rescored_applications": rescored}


@router.delete("/openings/{opening_id}", status_code=204)
def r_delete(opening_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    o = _opening(db, opening_id)
    db.delete(o)
    audit(db, "opening.deleted", user.id, "opening", opening_id)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- pipeline, filters


def _identity(db: Session, a: OpeningApplication) -> tuple[str, str | None]:
    if a.user_id:
        cand = db.get(User, a.user_id)
        if cand:
            return cand.display_name or cand.email.split("@")[0], cand.email
    return a.candidate_name or (a.original_filename or "Uploaded candidate"), a.candidate_email


def _row(db: Session, a: OpeningApplication, rank: int, facts: dict | None) -> dict:
    name, email = _identity(db, a)
    r = a.result or {}
    return {"rank": rank, "application_id": a.id, "name": name, "email": email, "source": a.source,
            "score": a.score, "tier": tier_for(a.score), "stage": a.stage,
            "counts": r.get("counts", {}), "keywords_matched": r.get("keywords", {}).get("present", []),
            "keywords_missing": r.get("keywords", {}).get("absent", []),
            "years": facts["years"] if facts else None,
            "notes": db.scalar(select(func.count(ApplicationNote.id)).where(ApplicationNote.application_id == a.id)) or 0,
            "applied_at": a.created_at.isoformat(), "updated_at": a.updated_at.isoformat(),
            "stage_changed_at": a.stage_changed_at.isoformat() if a.stage_changed_at else None,
            "expires_at": a.expires_at.isoformat() if a.expires_at else None}


@router.get("/openings/{opening_id}/candidates")
def r_candidates(
    opening_id: str,
    must_have: list[str] = Query(default=[], max_length=10, description="Skills that must appear (taxonomy names)"),
    min_years: float | None = Query(default=None, ge=0, le=50),
    min_score: float | None = Query(default=None, ge=0, le=100),
    stage: list[Stage] = Query(default=[]),
    source: Literal["applied", "uploaded"] | None = None,
    limit: int = Query(default=CANDIDATE_PAGE_DEFAULT, ge=1, le=CANDIDATE_PAGE_MAX),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(recruiter_user),
    db: Session = Depends(get_db),
):
    """Ranked pipeline for one opening, with shortlisting filters. Only people who applied (and consented)
    or were uploaded with recruiter-attested consent appear.

    Paginated: `candidates` holds at most `limit` rows starting at `offset` of the filtered, ranked list;
    `matched` is the size of that list, `has_more` says whether another page exists, and `total` is
    everyone in the pipeline (unfiltered). `rank` is always the position in the whole pipeline."""
    o = _opening(db, opening_id)
    tax = get_taxonomy()
    wanted = []
    for s in must_have:
        canon = tax.canonical(s) or (s if s in tax.skills else None)
        if not canon:
            raise err(422, "unknown_skill", f"Unknown skill: {s}")
        wanted.append(canon)
    apps = sorted(_pipeline(db, o.id), key=lambda a: (-a.score, a.created_at, a.id))
    total = len(apps)
    ranked = [(i, a) for i, a in enumerate(apps, 1)
              if (min_score is None or a.score >= min_score) and (not stage or a.stage in stage)
              and (not source or a.source == source)]
    needs_facts = bool(wanted) or min_years is not None

    def facts_for(a: OpeningApplication) -> dict | None:
        content = application_content(db, a)
        return candidate_facts(content) if content else None

    if needs_facts:  # these filters need every candidate's resume facts; otherwise only the page's
        with_facts = [(i, a, facts_for(a)) for i, a in ranked]
        matched = [(i, a, f) for i, a, f in with_facts
                   if (not wanted or (f and set(wanted) <= set(f["skills"])))
                   and (min_years is None or (f and f["years"] >= min_years))]
        page = matched[offset:offset + limit]
    else:
        matched = ranked  # type: ignore[assignment]
        page = [(i, a, facts_for(a)) for i, a in ranked[offset:offset + limit]]
    rows = [_row(db, a, i, f) for i, a, f in page]
    return {"opening": opening_out(o), "candidates": rows, "total": total, "matched": len(matched),
            "limit": limit, "offset": offset, "has_more": offset + len(rows) < len(matched),
            "filters": {"must_have": wanted, "min_years": min_years, "min_score": min_score, "stage": stage, "source": source},
            "stages": list(STAGES), "note": FAIRNESS_NOTE}


@router.get("/openings/{opening_id}/compare")
def r_compare(opening_id: str, ids: list[str] = Query(min_length=2, max_length=4), user: User = Depends(recruiter_user),
              db: Session = Depends(get_db)):
    """Side-by-side: each requirement of the opening with every candidate's status and evidence."""
    o = _opening(db, opening_id)
    apps = []
    for aid in dict.fromkeys(ids):
        a = _app(db, aid)
        if a.opening_id != o.id:
            raise err(404, "not_found", "Candidate not found for this opening.")
        apps.append(a)
    cands = []
    for a in apps:
        name, _ = _identity(db, a)
        content = application_content(db, a)
        cands.append({"application_id": a.id, "name": name, "score": a.score, "tier": tier_for(a.score), "stage": a.stage,
                      "years": candidate_facts(content)["years"] if content else None, "counts": (a.result or {}).get("counts", {})})
    reqs = []
    for i, r in enumerate(o.extracted.get("requirements", [])):
        cells = []
        for a in apps:
            rows = (a.result or {}).get("requirements", [])
            row = rows[i] if i < len(rows) and rows[i].get("text") == r["text"] else next(
                (x for x in rows if x.get("text") == r["text"]), None)
            cells.append({"application_id": a.id, "status": row["status"] if row else "unknown",
                          "explanation": row.get("explanation") if row else None,
                          "evidence": (row.get("evidence") or [])[:1] if row else []})
        reqs.append({"text": r["text"], "importance": r["importance"], "kind": r["kind"], "cells": cells})
    audit(db, "recruiter.compared", user.id, "opening", o.id, count=len(apps))
    db.commit()
    return {"opening": opening_out(o), "candidates": cands, "requirements": reqs, "note": FAIRNESS_NOTE}


@router.get("/applications/{application_id}")
def r_application(application_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    a = _app(db, application_id)
    name, email = _identity(db, a)
    content = application_content(db, a)
    audit(db, "recruiter.viewed_application", user.id, "application", a.id)
    db.commit()
    return {"id": a.id, "opening_id": a.opening_id, "name": name, "email": email, "source": a.source,
            "score": a.score, "tier": tier_for(a.score), "stage": a.stage, "match": a.result, "resume": content,
            "facts": candidate_facts(content) if content else None, "applied_at": a.created_at.isoformat(),
            "expires_at": a.expires_at.isoformat() if a.expires_at else None, "notes": _notes(db, a.id)}


class StageIn(BaseModel):
    stage: Stage


@router.patch("/applications/{application_id}")
def r_stage(application_id: str, body: StageIn, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    a = _app(db, application_id)
    if a.stage != body.stage:
        a.stage, a.stage_changed_at = body.stage, utcnow()
    audit(db, "recruiter.stage_changed", user.id, "application", a.id, stage=body.stage)
    db.commit()
    return {"id": a.id, "stage": a.stage, "stage_changed_at": a.stage_changed_at.isoformat() if a.stage_changed_at else None}


@router.delete("/applications/{application_id}", status_code=204)
def r_remove(application_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    """Remove an uploaded candidate (and their stored resume) before the automatic expiry."""
    a = _app(db, application_id)
    if a.source != "uploaded":
        raise err(409, "applied_candidate", "Candidates who applied themselves can only be moved to 'rejected', not deleted.")
    db.delete(a)
    audit(db, "recruiter.upload_removed", user.id, "application", application_id)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- notes


def _notes(db: Session, application_id: str) -> list[dict]:
    out = []
    for n in db.scalars(select(ApplicationNote).where(ApplicationNote.application_id == application_id)
                        .order_by(ApplicationNote.created_at)):
        author = db.get(User, n.author_id) if n.author_id else None
        out.append({"id": n.id, "text": n.text, "author": (author.display_name or author.email) if author else "Former staff",
                    "author_id": n.author_id, "created_at": n.created_at.isoformat()})
    return out


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@router.get("/applications/{application_id}/notes")
def list_notes(application_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    return _notes(db, _app(db, application_id).id)


@router.post("/applications/{application_id}/notes", status_code=201)
def add_note(application_id: str, body: NoteIn, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    a = _app(db, application_id)
    n = ApplicationNote(application_id=a.id, author_id=user.id, text=body.text.strip())
    db.add(n)
    db.flush()
    audit(db, "recruiter.note_added", user.id, "application", a.id)
    db.commit()
    return next(x for x in _notes(db, a.id) if x["id"] == n.id)


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: str, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    n = db.get(ApplicationNote, note_id)
    if not n:
        raise err(404, "not_found", "Note not found.")
    if n.author_id != user.id and user.role != "admin":
        raise err(403, "forbidden", "You can only delete your own notes.")
    db.delete(n)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- bulk upload


@router.post("/openings/{opening_id}/bulk-upload", status_code=201)
def bulk_upload(
    opening_id: str,
    files: list[UploadFile] = File(...),
    consent_attested: bool = Form(...),
    user: User = Depends(recruiter_user),
    db: Session = Depends(get_db),
):
    """Add resumes of people who did not sign up themselves. The recruiter must attest that each person
    agreed to be considered. Files are parsed in the sandbox; only extracted content is kept (encrypted),
    and the candidate is deleted automatically after BULK_UPLOAD_RETENTION_DAYS."""
    s = get_settings()
    if not consent_attested:
        raise err(422, "consent_required", "Confirm that these candidates agreed to be considered for this opening.")
    if len(files) > s.bulk_upload_max_files:
        raise err(422, "too_many_files", f"Upload at most {s.bulk_upload_max_files} files at a time.")
    o = _opening(db, opening_id)
    now = utcnow()
    added, failed = [], []
    deadline = time.monotonic() + s.bulk_upload_time_budget_seconds
    for f in files:
        name = f.filename or "resume"
        remaining = deadline - time.monotonic()
        if remaining < 1:
            failed.append({"file": name, "code": "time_budget_exceeded",
                           "message": "Not processed: this upload took too long. Upload this file again."})
            continue
        data = f.file.read(s.max_upload_bytes + 1)
        try:
            # cheap byte-level checks here; the file is opened only by the sandboxed parser
            v = validate_upload(name, f.content_type, data)
            content, contact = parse_uploaded_resume(v.kind, data, timeout=max(1, min(s.parse_timeout_seconds, int(remaining))))
        except UploadRejected as exc:
            failed.append({"file": name, "code": exc.code, "message": exc.message})
            continue
        except ParseError as exc:
            failed.append({"file": name, "code": exc.code, "message": exc.message})
            continue
        a = OpeningApplication(opening_id=o.id, source="uploaded", candidate_name=contact["name"], candidate_email=contact["email"],
                               content_enc=json.dumps(content), original_filename=name[:255], uploaded_by=user.id,
                               consent_attested_at=now, expires_at=upload_expiry(), stage="submitted", score=0.0,
                               result={}, matcher_version="")
        score_application(a, content, o)
        db.add(a)
        db.flush()
        added.append({"application_id": a.id, "file": name, "name": contact["name"] or name, "score": a.score,
                      "tier": tier_for(a.score)})
    audit(db, "recruiter.bulk_upload", user.id, "opening", o.id, added=len(added), failed=len(failed))
    db.commit()
    return {"added": added, "failed": failed, "retention_days": s.bulk_upload_retention_days,
            "note": "Uploaded candidates are visible only to HR staff and are deleted automatically after "
                    f"{s.bulk_upload_retention_days} days."}


# ---------------------------------------------------------------- analytics


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) // 2
    return round(s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2, 1)


@router.get("/analytics")
def analytics(include_demo: bool = False, user: User = Depends(recruiter_user), db: Session = Depends(get_db)):
    """Firm-level pipeline analytics. Aggregates only; no candidate identities."""
    now = utcnow()
    q = select(JobOpening)
    if not include_demo:
        q = q.where(JobOpening.is_demo.is_(False))
    openings = list(db.scalars(q))
    missing: Counter[str] = Counter()
    per_opening, all_apps = [], []
    for o in openings:
        apps = _pipeline(db, o.id)
        all_apps += apps
        for a in apps:
            missing.update(set((a.result or {}).get("keywords", {}).get("absent", [])))
        strong = sum(1 for a in apps if a.score >= 60)
        days_to_advance = [(a.stage_changed_at - a.created_at).total_seconds() / 86400 for a in apps
                           if a.stage in ADVANCED_STAGES and a.stage_changed_at]
        age_days = (now - o.created_at).days
        per_opening.append({
            **opening_out(o), "applicants": len(apps), "strong_matches": strong,
            "median_score": _median([a.score for a in apps]),
            "advanced": sum(1 for a in apps if a.stage in ADVANCED_STAGES),
            "median_days_to_advance": _median(days_to_advance), "age_days": age_days,
            "hard_to_fill": o.status == "open" and age_days >= 14 and strong < 3,
        })
    n = len(all_apps)
    return {
        "totals": {"openings_open": sum(1 for o in openings if o.status == "open"),
                   "openings_closed": sum(1 for o in openings if o.status == "closed"),
                   "candidates": n, "applied": sum(1 for a in all_apps if a.source == "applied"),
                   "uploaded": sum(1 for a in all_apps if a.source == "uploaded"),
                   "stages": {s: sum(1 for a in all_apps if a.stage == s) for s in STAGES},
                   "median_score": _median([a.score for a in all_apps])},
        "most_missing_skills": [{"skill": s, "candidates": c, "share": round(c / n, 3)} for s, c in missing.most_common(10)] if n else [],
        "openings": sorted(per_opening, key=lambda r: (not r["hard_to_fill"], -r["applicants"])),
        "include_demo": include_demo,
        "notes": ["'Strong match' means a compatibility indicator of 60 or more.",
                  "'Hard to fill' = open for 14+ days with fewer than 3 strong matches.",
                  "Most-missing skills show where candidates may need training, and where requirements may be unusually strict."],
    }


# ---------------------------------------------------------------- fairness monitoring

FAIRNESS_MIN_GROUP = 10
FAIRNESS_MIN_GROUPS_SHOWN = 2


def fairness_cutoff() -> datetime:
    """The report is a snapshot as of the start of the current UTC day.

    A live report would let someone move one candidate's stage, reload, and see which group's rate
    changed, revealing that person's self-identification. With a daily snapshot, changes made today
    don't show until tomorrow, and every view is audited."""
    now = utcnow()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@router.get("/fairness")
def fairness(opening_id: str | None = None, user: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Group outcomes from VOLUNTARY self-identification, for admins only.

    Privacy rules: data as of the start of today (see fairness_cutoff); a dimension is shown only when
    at least FAIRNESS_MIN_GROUPS_SHOWN groups each have FAIRNESS_MIN_GROUP or more people (one group
    alone would reveal everyone's answer); no counts of hidden or self-identified people are returned.
    Self-ID is never used for ranking; this report exists only to detect unequal outcomes."""
    cutoff = fairness_cutoff()
    q = select(OpeningApplication).where(OpeningApplication.source == "applied", OpeningApplication.created_at < cutoff)
    if opening_id:
        _opening(db, opening_id)
        q = q.where(OpeningApplication.opening_id == opening_id)
    apps = list(db.scalars(q))
    ids = {a.user_id for a in apps if a.user_id}
    selfid = {r.user_id: r for r in db.scalars(select(DemographicSelfId).where(DemographicSelfId.user_id.in_(ids)))} if ids else {}

    def advanced(a: OpeningApplication) -> bool:
        # stage decisions made today are not counted yet
        return a.stage in ADVANCED_STAGES and (a.stage_changed_at is None or a.stage_changed_at < cutoff)

    dims = {}
    for dim in ("gender", "age_band"):
        groups: dict[str, list[OpeningApplication]] = {}
        for a in apps:
            r = selfid.get(a.user_id)
            val = getattr(r, dim) if r else None
            if val and val != "prefer_not":
                groups.setdefault(val, []).append(a)
        shown = []
        for g, rows in sorted(groups.items()):
            if len(rows) < FAIRNESS_MIN_GROUP:
                continue
            shown.append({"group": g, "n": len(rows), "mean_score": round(sum(a.score for a in rows) / len(rows), 1),
                          "strong_rate": round(sum(1 for a in rows if a.score >= 60) / len(rows), 3),
                          "selection_rate": round(sum(1 for a in rows if advanced(a)) / len(rows), 3),
                          "flags": []})
        if len(shown) < FAIRNESS_MIN_GROUPS_SHOWN:
            shown = []
        for key in ("strong_rate", "selection_rate"):
            top = max((g[key] for g in shown), default=0)
            for g in shown:
                ratio = round(g[key] / top, 3) if top else None
                g[f"{key}_impact_ratio"] = ratio
                if ratio is not None and ratio < 0.8:
                    g["flags"].append(f"{key.replace('_', ' ')} is below 80% of the highest group (four-fifths rule)")
        dims[dim] = {"groups": shown}
    audit(db, "admin.fairness_viewed", user.id, "opening", opening_id)
    db.commit()
    return {"opening_id": opening_id, "applicants": len(apps), "as_of": cutoff.isoformat(),
            "min_group_size": FAIRNESS_MIN_GROUP, "min_groups_shown": FAIRNESS_MIN_GROUPS_SHOWN, "dimensions": dims,
            "notes": ["Based only on candidates who chose to self-identify; it may not represent everyone.",
                      "Data as of the start of today (UTC); changes made today appear tomorrow.",
                      f"A breakdown is shown only when at least {FAIRNESS_MIN_GROUPS_SHOWN} groups each have "
                      f"{FAIRNESS_MIN_GROUP} or more people, so no individual's answer can be inferred.",
                      "A flag is a prompt to investigate (requirements, wording, sourcing), not proof of bias.",
                      "Self-identification is never used for ranking, matching or tips."]}
