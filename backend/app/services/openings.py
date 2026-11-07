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
from app.services.parsing.sandbox import parse_isolated
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


def candidate_facts(content: dict) -> dict:
    """Skills and experience used for recruiter filters. Same fairness constraints as ranking:
    derived only from skills, bullets, titles and dates — never names, schools or employers."""
    c = ResumeContent.model_validate(content)
    ev = resume_skill_evidence(c)
    tl = build_timeline(c)
    return {"skills": sorted(ev.all), "demonstrated_skills": sorted(ev.demonstrated), "years": tl.effective_years}


def parse_uploaded_resume(kind: str, data: bytes) -> tuple[dict, dict]:
    """Parse + extract an uploaded file in the sandbox. Returns (content, contact)."""
    parsed = parse_isolated(kind, data)
    result = extract(parsed["text"], parsed["pages"])
    content = result["content"]
    contact = content.get("contact", {}) if isinstance(content, dict) else {}
    return content, {"name": contact.get("name"), "email": contact.get("email")}


def upload_expiry():
    return utcnow() + timedelta(days=get_settings().bulk_upload_retention_days)
