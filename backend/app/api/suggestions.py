from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.db import get_db
from app.models import AISuggestion, JobDescription, JobOpening, Resume, ResumeVersion, User
from app.schemas.resume import ResumeContent
from app.security.crypto import sha256_hex
from app.services.analysis.experience import build_timeline
from app.services.audit import audit
from app.services.editor import (
    TargetError,
    apply_items,
    create_version,
    latest_version,
    target_items,
    word_diff,
)
from app.services.llm.grounding import verify
from app.services.llm.providers import get_provider
from app.services.llm.service import generate, resume_context_for
from app.services.ml.features import resume_skill_evidence
from app.services.ml.leaderboard import eligibility, fit_for_opening, fit_for_role
from app.services.taxonomy import get_taxonomy
from app.versions import PROMPT_VERSION

router = APIRouter(prefix="/api", tags=["suggestions"])

Operation = Literal["rewrite_bullet", "improve_summary", "shorten", "grammar", "tailor", "tone"]


class SuggestIn(BaseModel):
    operation: Operation
    target_path: str = Field(max_length=200)
    tone: Literal["confident", "formal", "concise", "friendly"] | None = None
    length: Literal["shorter", "same", "longer"] | None = None
    target_role: str | None = Field(default=None, max_length=64)
    jd_id: str | None = None
    opening_id: str | None = Field(default=None, max_length=36)


class EditedItem(BaseModel):
    target_id: str = Field(max_length=40)
    text: str = Field(max_length=1200)


class AcceptIn(BaseModel):
    confirmed_facts: list[str] = Field(default_factory=list, max_length=20)
    edited_items: list[EditedItem] | None = Field(default=None, max_length=40)


def suggestion_out(s: AISuggestion) -> dict:
    return {
        "id": s.id, "version_id": s.version_id, "operation": s.operation, "target_path": s.target_path, "status": s.status,
        "items": s.items, "explanation": s.explanation, "questions": s.questions, "placeholders": s.placeholders,
        "grounding": s.grounding, "provider": s.provider, "model": s.model, "prompt_version": s.prompt_version,
        "is_fixture": s.provider == "fixture", "label": "AI suggestion — not yet applied",
        "fixture_notice": "Development fixture — not live AI. Output is rule-based." if s.provider == "fixture" else None,
        "applied_version_id": s.applied_version_id, "created_at": s.created_at.isoformat(),
    }


def _facts(c: ResumeContent) -> dict:
    ev = resume_skill_evidence(c)
    latest = c.experience[0] if c.experience else None
    best = max((t for _, _, t in c.all_bullets()), key=lambda t: (any(ch.isdigit() for ch in t), len(t)), default=None)
    return {"latest_title": latest.title if latest else None,
            "top_skills": sorted(ev.demonstrated, key=lambda s: -len(ev.evidence.get(s, [])))[:6],
            "years": build_timeline(c).professional_years or None, "best_bullet": best}


@router.post("/versions/{version_id}/suggestions", status_code=201)
def create_suggestion(version_id: str, body: SuggestIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    content = ResumeContent.model_validate(v.content)
    if body.operation == "improve_summary" and body.target_path != "summary":
        raise err(422, "invalid_target", "improve_summary targets the summary.")
    try:
        items = target_items(content, body.target_path)
    except TargetError as exc:
        raise err(404, "target_not_found", str(exc)) from exc
    if body.operation != "improve_summary" and not any(i["text"].strip() for i in items):
        raise err(422, "empty_target", "There is no text to edit at this location.")

    task: dict = {"items": items, "tone": body.tone, "length": body.length}
    ctx: dict = {"resume": resume_context_for(content)}
    if body.operation == "improve_summary":
        task["facts"] = _facts(content)
    if body.operation == "tailor":
        ev = resume_skill_evidence(content)
        if body.jd_id:
            jd = get_owned(db, JobDescription, body.jd_id, user)
            ctx["jd"] = jd.raw_text
            target_skills = jd.extracted.get("skills", [])
            task["target"] = {"title": jd.title}
            fit, cov, _m = fit_for_opening(content, jd.extracted)
        elif body.opening_id:
            op = db.get(JobOpening, body.opening_id)
            if not op or op.status != "open":
                raise err(404, "not_found", "This opening is not available.")
            ctx["jd"] = op.description
            target_skills = op.extracted.get("skills", [])
            task["target"] = {"title": op.title, "company": op.company}
            fit, cov, _m = fit_for_opening(content, op.extracted)
        elif body.target_role and body.target_role in get_taxonomy().roles:
            role = get_taxonomy().roles[body.target_role]
            target_skills = role.required_skills + role.preferred_skills
            task["target"] = {"title": role.title}
            fit, cov = fit_for_role(content, role.id)
        else:
            raise err(422, "missing_target", "Choose a target role, opening or job description to tailor to.")
        # relevance gate: rewording cannot honestly turn an unrelated profile into a fit
        ok, why = eligibility(fit, cov)
        if not ok:
            raise err(422, "target_not_related",
                      f"“{task['target']['title']}” isn't closely related to this resume ({why}). "
                      "Build the missing skills first. See the learning path for this target.")
        # only skills the resume already evidences may be emphasised
        task["allowed_emphasis_skills"] = sorted(set(target_skills) & ev.all)

    provider = get_provider()
    params = body.model_dump()
    key = sha256_hex(json.dumps([user.id, v.id, v.content_hash, params, PROMPT_VERSION, provider.name, provider.model], sort_keys=True))
    existing = db.scalar(select(AISuggestion).where(AISuggestion.cache_key == key, AISuggestion.user_id == user.id,
                                                    AISuggestion.status.in_(["pending", "needs_facts"])))
    if existing:
        return suggestion_out(existing)

    parsed, res = generate(db, user, body.operation, task, ctx, content=content)
    by_id = {i["id"]: i for i in items}
    out_items = []
    all_unsupported: list[dict] = []
    placeholders: list[str] = []
    for rv in parsed.revised:  # type: ignore[attr-defined]
        orig = by_id.get(rv.target_id)
        if orig is None:
            continue  # ignore ids the model invented
        g = verify(rv.text, content, source_text=orig["text"])
        out_items.append({"target_id": rv.target_id, "before": orig["text"], "after": rv.text,
                          "diff": word_diff(orig["text"], rv.text), "grounding": g})
        all_unsupported += g["unsupported"]
        placeholders += g["placeholders"]
    if not out_items:
        raise err(502, "empty_ai_output", "The AI did not return a usable suggestion. Please try again.")

    questions = list(parsed.questions)  # type: ignore[attr-defined]
    for u in all_unsupported:
        questions.append(f"The suggestion mentions “{u['value']}” ({u['type']}), which is not in your confirmed resume. "
                         "Is it accurate? Confirm it, or edit the text before accepting.")
    s = AISuggestion(
        user_id=user.id, version_id=v.id, operation=body.operation, target_path=body.target_path,
        before_text="\n".join(i["before"] for i in out_items), after_text="\n".join(i["after"] for i in out_items),
        explanation=parsed.explanation, questions=questions[:12], placeholders=placeholders,  # type: ignore[attr-defined]
        grounding={"grounded": not all_unsupported, "unsupported": all_unsupported},
        status="pending" if not all_unsupported else "needs_facts",
        provider=res.provider, model=res.model, prompt_version=PROMPT_VERSION, items=out_items, params=params, cache_key=key,
    )
    db.add(s)
    audit(db, "ai.suggestion_created", user.id, "suggestion", s.id, operation=body.operation, provider=res.provider)
    db.commit()
    return suggestion_out(s)


@router.get("/versions/{version_id}/suggestions")
def list_suggestions(version_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    rows = db.scalars(select(AISuggestion).where(AISuggestion.version_id == v.id).order_by(AISuggestion.created_at.desc()))
    return [suggestion_out(s) for s in rows]


@router.post("/suggestions/{suggestion_id}/accept")
def accept(suggestion_id: str, body: AcceptIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    s = get_owned(db, AISuggestion, suggestion_id, user)
    if s.status not in ("pending", "needs_facts"):
        raise err(409, "not_pending", f"This suggestion is already {s.status}.")
    v = db.get(ResumeVersion, s.version_id)
    assert v
    resume = db.get(Resume, v.resume_id)
    assert resume
    latest = latest_version(db, resume.id)
    assert latest
    latest_content = ResumeContent.model_validate(latest.content)
    edited = {e.target_id: e.text for e in (body.edited_items or [])}
    try:
        current = {i["id"]: i["text"] for i in target_items(latest_content, s.target_path)}
    except TargetError as exc:
        raise err(409, "stale_suggestion", "The text this suggestion targets no longer exists.") from exc

    revised: dict[str, str] = {}
    problems = []
    for item in s.items:
        tid = item["target_id"]
        if current.get(tid) != item["before"]:
            raise err(409, "stale_suggestion", "The original text changed since this suggestion was made. Generate a new one.")
        text = edited.get(tid, item["after"]).strip()
        if not text:
            raise err(422, "empty_text", "Edited text cannot be empty.")
        g = verify(text, latest_content, extra_facts=body.confirmed_facts, source_text=item["before"])
        if g["unsupported"]:
            problems += g["unsupported"]
        revised[tid] = text
    if problems:
        raise err(422, "unsupported_claims", "Some details are not in your confirmed resume: "
                  + ", ".join(f"“{p['value']}”" for p in problems[:8])
                  + ". Confirm each one is true (it will be recorded as your confirmation) or edit the text.")
    new_content = apply_items(latest_content, s.target_path, revised)
    nv = create_version(db, resume, new_content, source="ai_accepted", label=f"Accepted AI: {s.operation.replace('_', ' ')}",
                        parent_id=latest.id)
    s.status = "accepted"
    s.applied_version_id = nv.id
    s.grounding = {**s.grounding, "confirmed_by_user": body.confirmed_facts, "user_edited": bool(edited)}
    for other in db.scalars(select(AISuggestion).where(AISuggestion.version_id == s.version_id, AISuggestion.id != s.id,
                                                      AISuggestion.target_path == s.target_path,
                                                      AISuggestion.status.in_(["pending", "needs_facts"]))):
        other.status = "superseded"
    audit(db, "ai.suggestion_accepted", user.id, "suggestion", s.id, operation=s.operation)
    db.commit()
    return {"suggestion": suggestion_out(s), "version_id": nv.id, "version_number": nv.number}


@router.post("/suggestions/{suggestion_id}/reject")
def reject(suggestion_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    s = get_owned(db, AISuggestion, suggestion_id, user)
    if s.status not in ("pending", "needs_facts"):
        raise err(409, "not_pending", f"This suggestion is already {s.status}.")
    s.status = "rejected"
    db.commit()
    return suggestion_out(s)
