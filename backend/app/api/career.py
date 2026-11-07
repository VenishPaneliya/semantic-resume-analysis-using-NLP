from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.db import get_db
from app.models import CareerArtifact, JobDescription, ResumeVersion, User
from app.schemas.resume import ResumeContent
from app.services.career import job_listings_status, resource_provider, roadmap, template_interview_questions
from app.services.llm.grounding import verify
from app.services.llm.providers import LLMUnavailable
from app.services.llm.service import generate, resume_context_for
from app.services.ml.jd import match
from app.services.ml.recommender import recommend
from app.services.taxonomy import get_taxonomy

router = APIRouter(prefix="/api/career", tags=["career"])


def _artifact_out(a: CareerArtifact) -> dict:
    return {"id": a.id, "kind": a.kind, "version_id": a.version_id, "jd_id": a.jd_id, "content": a.content, "provider": a.provider,
            "model": a.model, "is_fixture": a.provider == "fixture", "created_at": a.created_at.isoformat()}


@router.get("/roadmap/{version_id}")
def get_roadmap(version_id: str, roles: list[str] = Query(default=[]), user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    c = ResumeContent.model_validate(v.content)
    role_ids = roles or (user.career_prefs or {}).get("target_roles") or [r["role_id"] for r in recommend(c).get("recommendations", [])[:1]]
    if not role_ids:
        return {"status": "insufficient_evidence", "message": "Choose a target role in Settings, or add more detail so roles can be suggested.", "steps": []}
    bad = [r for r in role_ids if r not in get_taxonomy().roles]
    if bad:
        raise err(422, "unknown_role", f"Unknown roles: {', '.join(bad)}")
    return {"status": "ok", **roadmap(c, role_ids[:3])}


@router.get("/resources")
def resources(skill: str = Query(max_length=80), user: User = Depends(verified_user)):
    return resource_provider().lookup(skill)


@router.get("/job-listings")
def job_listings(user: User = Depends(verified_user)):
    return job_listings_status()


class GenIn(BaseModel):
    version_id: str
    jd_id: str | None = None
    role_id: str | None = Field(default=None, max_length=64)


@router.post("/interview-questions", status_code=201)
def interview_questions(body: GenIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, body.version_id, user)
    c = ResumeContent.model_validate(v.content)
    jd = get_owned(db, JobDescription, body.jd_id, user) if body.jd_id else None
    gaps = match(c, jd.extracted)["keywords"]["absent"] if jd else []
    items = [{"id": p, "text": t} for p, _, t in c.all_bullets()[:12]]
    provider, model, note = "template", "template-v1", None
    try:
        parsed, res = generate(db, user, "interview_questions", {"items": items, "gaps": gaps[:6]},
                               {"resume": resume_context_for(c), "jd": jd.raw_text if jd else None}, content=c)
        qs = [q.model_dump() for q in parsed.questions]  # type: ignore[attr-defined]
        provider, model = res.provider, res.model
    except LLMUnavailable as exc:
        qs = template_interview_questions(c, gaps)
        note = f"AI unavailable ({exc.code}); showing template-based questions from your resume."
    a = CareerArtifact(user_id=user.id, version_id=v.id, jd_id=jd.id if jd else None, kind="interview_questions",
                       content={"questions": qs, "note": note}, provider=provider, model=model)
    db.add(a)
    db.commit()
    return _artifact_out(a)


@router.post("/cover-letter", status_code=201)
def cover_letter(body: GenIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Cover letter from confirmed facts only. Unsupported claims are reported and the
    letter is marked as needing review; placeholders mark facts the user must supply."""
    v = get_owned(db, ResumeVersion, body.version_id, user)
    c = ResumeContent.model_validate(v.content)
    jd = get_owned(db, JobDescription, body.jd_id, user) if body.jd_id else None
    role = get_taxonomy().roles.get(body.role_id or "") if body.role_id else None
    from app.api.suggestions import _facts

    target = {"title": jd.title if jd else role.title if role else None, "company": jd.company if jd else None}
    parsed, res = generate(db, user, "cover_letter", {"facts": _facts(c), "target": target},
                           {"resume": resume_context_for(c), "jd": jd.raw_text if jd else None}, content=c)
    paragraphs = list(parsed.paragraphs)  # type: ignore[attr-defined]
    allowed = [x for x in [target.get("title"), target.get("company")] if x]
    if jd:
        allowed.append(jd.raw_text)  # the employer's own terms may be referenced, not claimed as skills
    g = verify("\n".join(paragraphs), c, extra_facts=[t for t in allowed if t != (jd.raw_text if jd else None)],
               source_text=f"{target.get('title') or ''} {target.get('company') or ''}")
    name = c.contact.name
    if name:
        paragraphs = [p.replace("[CANDIDATE_NAME]", name) for p in paragraphs]
    a = CareerArtifact(user_id=user.id, version_id=v.id, jd_id=jd.id if jd else None, kind="cover_letter",
                       content={"paragraphs": paragraphs, "questions": list(parsed.questions), "grounding": g,  # type: ignore[attr-defined]
                                "status": "needs_review" if g["unsupported"] else "grounded"},
                       provider=res.provider, model=res.model)
    db.add(a)
    db.commit()
    return _artifact_out(a)


@router.get("/artifacts")
def artifacts(kind: str | None = Query(None), user: User = Depends(verified_user), db: Session = Depends(get_db)):
    q = select(CareerArtifact).where(CareerArtifact.user_id == user.id)
    if kind:
        q = q.where(CareerArtifact.kind == kind)
    return [_artifact_out(a) for a in db.scalars(q.order_by(CareerArtifact.created_at.desc()).limit(50))]
