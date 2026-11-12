"""Shared logic for job openings and the candidates in their pipelines."""

from __future__ import annotations

import json
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import JobOpening, OpeningApplication, ResumeVersion, utcnow
from app.schemas.resume import ResumeContent
from app.services.analysis.experience import build_timeline
from app.services.extraction.extractor import extract
from app.services.ml.features import resume_skill_evidence
from app.services.ml.jd import extract_jd, match
from app.services.ml.leaderboard import infer_role
from app.services.parsing.parsers import ParseError
from app.services.parsing.sandbox import parse_isolated
from app.services.upload_validation import check_parsed_limits, refine_parse_error
from app.versions import JD_MATCHER_VERSION

STAGES = ("submitted", "shortlisted", "interview", "offer", "hired", "rejected")
ADVANCED_STAGES = ("shortlisted", "interview", "offer", "hired")  # counted as "selected" in reports


def extract_opening(o: JobOpening) -> None:
    ex = extract_jd(f"{o.title}\n{o.description}")
    ex["title"] = o.title
    o.extracted = ex
    o.role_id = infer_role(ex)


def application_content(db: Session, a: OpeningApplication) -> dict | None:
    """Resume content behind an application: the applied version, or the stored upload."""
    if a.version_id:
        v = db.get(ResumeVersion, a.version_id)
        return v.content if v else None
    return json.loads(a.content_enc) if a.content_enc else None


def score_application(a: OpeningApplication, content: dict, opening: JobOpening) -> None:
    m = match(content, opening.extracted)
    a.score, a.result, a.matcher_version = float(m["overall"] or 0), m, JD_MATCHER_VERSION


def rescore_opening(db: Session, o: JobOpening) -> int:
    n = 0
    for a in db.scalars(select(OpeningApplication).where(OpeningApplication.opening_id == o.id)):
        content = application_content(db, a)
        if content:
            score_application(a, content, o)
            n += 1
    return n


def refresh_stale(db: Session, limit: int = 500) -> dict:
    """Bring openings and applications scored by an older matcher up to date: re-read each stale opening's
    description and rescore its pipeline, then rescore any other application with an older matcher version.
    Bounded per call; the caller commits."""
    openings = applications = 0
    for o in db.scalars(select(JobOpening)).all():
        if openings >= limit:
            break
        if (o.extracted or {}).get("matcher_version") != JD_MATCHER_VERSION:
            extract_opening(o)
            applications += rescore_opening(db, o)
            openings += 1
    db.flush()  # the sessions don't autoflush; without this the query below sees the old versions
    stale = select(OpeningApplication).where(OpeningApplication.matcher_version != JD_MATCHER_VERSION).limit(limit)
    for a in db.scalars(stale).all():
        o = db.get(JobOpening, a.opening_id)
        content = application_content(db, a)
        if o and content:
            score_application(a, content, o)
            applications += 1
    return {"openings": openings, "applications": applications}


def candidate_facts(content: dict) -> dict:
    """Skills and experience used for recruiter filters. Same fairness constraints as ranking:
    derived only from skills, bullets, titles and dates — never names, schools or employers."""
    c = ResumeContent.model_validate(content)
    ev = resume_skill_evidence(c)
    tl = build_timeline(c)
    return {"skills": sorted(ev.all), "demonstrated_skills": sorted(ev.demonstrated), "years": tl.effective_years}


def parse_uploaded_resume(kind: str, data: bytes, *, timeout: int | None = None) -> tuple[dict, dict]:
    """Parse + extract an uploaded file in the sandbox. Returns (content, contact). Raises ParseError, or
    UploadRejected when the parsed document breaks an upload limit (e.g. too many pages)."""
    try:
        parsed = parse_isolated(kind, data, timeout=timeout)
    except ParseError as exc:
        raise refine_parse_error(kind, data, exc) from exc
    check_parsed_limits(parsed)
    result = extract(parsed["text"], parsed["pages"])
    content = result["content"]
    contact = content.get("contact", {}) if isinstance(content, dict) else {}
    return content, {"name": contact.get("name"), "email": contact.get("email")}


def upload_expiry():
    return utcnow() + timedelta(days=get_settings().bulk_upload_retention_days)
