"""Candidate engagement: live what-if scoring, learning plan, resume health over time, mock interviews."""

from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.api.versions import _analysis
from app.db import get_db
from app.models import InterviewSession, JobOpening, LearningItem, Resume, ResumeVersion, User, utcnow
from app.schemas.resume import ResumeContent
from app.security.ratelimit import enforce
from app.services.career import resource_provider, template_interview_questions
from app.services.interview import rule_checks
from app.services.llm.providers import LLMUnavailable
from app.services.llm.service import generate, resume_context_for
from app.services.ml.features import resume_skill_evidence
from app.services.ml.jd import match
from app.services.ml.leaderboard import eligibility, fit_for_opening, role_leaderboard, tier_for
from app.services.taxonomy import get_taxonomy

router = APIRouter(prefix="/api", tags=["engagement"])


def _target(db: Session, role_id: str | None, opening_id: str | None) -> tuple[str, str, str, JobOpening | None]:
    if bool(role_id) == bool(opening_id):
        raise err(422, "missing_target", "Choose exactly one role or opening.")
    if role_id:
        role = get_taxonomy().roles.get(role_id)
        if not role:
            raise err(422, "unknown_role", "Unknown role.")
        return "role", role.id, role.title, None
    o = db.get(JobOpening, opening_id)
    if not o or o.status != "open":
        raise err(404, "not_found", "This opening is not available.")
    return "opening", o.id, o.title, o


def _score(content: dict, kind: str, tid: str, o: JobOpening | None) -> dict:
    if kind == "role":
        row = next((r for r in role_leaderboard(content)["rows"] if r["role_id"] == tid), None)
        score, cov = (row["score"], row["core_coverage"]) if row else (None, None)
        kw = set(row["keywords_matched"]) if row else set()
    else:
        assert o is not None
        score, cov, m = fit_for_opening(content, o.extracted)
        kw = set(m["keywords"]["present"])
    ok, _ = eligibility(score, cov)
    return {"score": score, "tier": tier_for(score), "core_coverage": cov, "tips_available": ok, "_kw": kw}


# ---------------------------------------------------------------- what-if


class WhatIfIn(BaseModel):
    content: ResumeContent
    role_id: str | None = Field(default=None, max_length=64)
    opening_id: str | None = Field(default=None, max_length=36)


@router.post("/versions/{version_id}/what-if")
def what_if(version_id: str, body: WhatIfIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Score unsaved edits against a target without saving anything. Same engine as the leaderboards."""
    enforce(f"whatif:{user.id}", 60)
    v = get_owned(db, ResumeVersion, version_id, user)
    kind, tid, title, o = _target(db, body.role_id, body.opening_id)
    before = _score(v.content, kind, tid, o)
    after = _score(body.content.model_dump(), kind, tid, o)
    kw_before, kw_after = before.pop("_kw"), after.pop("_kw")
    gained, lost = sorted(kw_after - kw_before), sorted(kw_before - kw_after)
    delta = None if before["score"] is None or after["score"] is None else round(after["score"] - before["score"], 1)
    return {"target": {"kind": kind, "id": tid, "title": title}, "before": before, "after": after, "delta": delta,
            "keywords_gained": gained, "keywords_lost": lost,
            "note": "Preview only. Nothing is saved until you save a new version. Only add things that are true."}


# ---------------------------------------------------------------- learning plan


def _latest_content(db: Session, user: User) -> dict | None:
    r = db.scalar(select(Resume).where(Resume.user_id == user.id).order_by(Resume.updated_at.desc()))
    if not r:
        return None
    v = db.scalar(select(ResumeVersion).where(ResumeVersion.resume_id == r.id).order_by(ResumeVersion.number.desc()))
    return v.content if v else None


def _item_out(i: LearningItem, shown: set[str]) -> dict:
    return {"id": i.id, "skill": i.skill, "status": i.status, "target": {"kind": i.target_kind, "id": i.target_id, "title": i.target_title},
            "resources": resource_provider().lookup(i.skill), "evidence_in_resume": i.skill in shown,
            "next_step": (f"Nice. Now add a bullet or project that shows where you used {i.skill}, so it counts on your resume."
                          if i.status == "done" and i.skill not in shown else None),
            "created_at": i.created_at.isoformat(), "completed_at": i.completed_at.isoformat() if i.completed_at else None}


def _shown(db: Session, user: User) -> set[str]:
    c = _latest_content(db, user)
    return resume_skill_evidence(ResumeContent.model_validate(c)).demonstrated if c else set()


@router.get("/learning")
def learning_plan(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    items = list(db.scalars(select(LearningItem).where(LearningItem.user_id == user.id).order_by(LearningItem.created_at)))
    shown = _shown(db, user)
    out = [_item_out(i, shown) for i in items]
    done = sum(1 for i in items if i.status == "done")
    return {"items": out, "progress": {"done": done, "total": len(items),
                                       "percent": round(100 * done / len(items)) if items else 0},
            "resource_provider": resource_provider().name}


class LearningAddIn(BaseModel):
    skills: list[str] = Field(min_length=1, max_length=12)
    target_kind: Literal["role", "opening"] | None = None
    target_id: str | None = Field(default=None, max_length=64)
    target_title: str | None = Field(default=None, max_length=200)


@router.post("/learning", status_code=201)
def learning_add(body: LearningAddIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    tax = get_taxonomy()
    added: list[str] = []
    existing = set(db.scalars(select(LearningItem.skill).where(LearningItem.user_id == user.id)))
    for s in body.skills:
        canon = tax.canonical(s) or (s if s in tax.skills else None)
        if not canon:
            raise err(422, "unknown_skill", f"Unknown skill: {s}")
        if canon in existing or canon in added:
            continue
        item = LearningItem(user_id=user.id, skill=canon, target_kind=body.target_kind, target_id=body.target_id,
                            target_title=body.target_title, status="todo")
        db.add(item)
        added.append(canon)
    db.commit()
    return {"added": added, **learning_plan(user, db)}


class LearningPatch(BaseModel):
    status: Literal["todo", "learning", "done"]


@router.patch("/learning/{item_id}")
def learning_update(item_id: str, body: LearningPatch, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    i = get_owned(db, LearningItem, item_id, user)
    i.status = body.status
    i.completed_at = utcnow() if body.status == "done" else None
    db.commit()
    return _item_out(i, _shown(db, user))


@router.delete("/learning/{item_id}", status_code=204)
def learning_delete(item_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, LearningItem, item_id, user))
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- resume health over time


@router.get("/resumes/{resume_id}/history")
def history(resume_id: str, role_id: str | None = Query(None, max_length=64), user: User = Depends(verified_user),
            db: Session = Depends(get_db)):
    r = get_owned(db, Resume, resume_id, user)
    if role_id and role_id not in get_taxonomy().roles:
        raise err(422, "unknown_role", "Unknown role.")
    versions = list(db.scalars(select(ResumeVersion).where(ResumeVersion.resume_id == r.id)
                               .order_by(ResumeVersion.number.desc()).limit(30)))[::-1]
    points = []
    for v in versions:
        a = _analysis(db, v, None)
        lb = role_leaderboard(v.content)
        top = lb["rows"][0] if lb["rows"] else None
        tgt = next((x for x in lb["rows"] if x["role_id"] == role_id), None) if role_id else None
        points.append({"version_id": v.id, "number": v.number, "label": v.label, "source": v.source,
                       "created_at": v.created_at.isoformat(), "quality": a.get("overall"),
                       "top_role": {"role_id": top["role_id"], "title": top["title"], "score": top["score"]} if top else None,
                       "target_score": tgt["score"] if tgt else None})
    first, last = (points[0], points[-1]) if points else (None, None)

    def d(k):
        return None if not first or first[k] is None or last[k] is None else round(last[k] - first[k], 1)

    return {"resume_id": r.id, "role_id": role_id, "points": points,
            "change": {"quality": d("quality"), "target_score": d("target_score") if role_id else None},
            "note": "Quality is the published rubric score; role scores are compatibility indicators."}


# ---------------------------------------------------------------- mock interviews


class InterviewIn(BaseModel):
    role_id: str | None = Field(default=None, max_length=64)
    opening_id: str | None = Field(default=None, max_length=36)


def _answers(s: InterviewSession) -> dict:
    return json.loads(s.answers_enc) if s.answers_enc else {}


def _session_out(s: InterviewSession) -> dict:
    ans = _answers(s)
    return {"id": s.id, "version_id": s.version_id, "target": {"kind": s.target_kind, "id": s.target_id, "title": s.target_title},
            "questions": [{**q, "answer": ans.get(q["id"])} for q in s.questions],
            "questions_source": s.questions_source, "is_fixture": s.questions_source == "fixture",
            "answered": len(ans), "created_at": s.created_at.isoformat(), "updated_at": s.updated_at.isoformat()}


@router.post("/versions/{version_id}/interviews", status_code=201)
def start_interview(version_id: str, body: InterviewIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    v = get_owned(db, ResumeVersion, version_id, user)
    c = ResumeContent.model_validate(v.content)
    kind = tid = title = None
    gaps: list[str] = []
    jd_text = None
    if body.role_id or body.opening_id:
        kind, tid, title, o = _target(db, body.role_id, body.opening_id)
        if o:
            gaps = match(c, o.extracted)["keywords"]["absent"]
            jd_text = o.description
        else:
            role = get_taxonomy().roles[tid]
            ev = resume_skill_evidence(c)
            gaps = [s for s in role.required_skills if s not in ev.all]
    items = [{"id": p, "text": t} for p, _, t in c.all_bullets()[:12]]
    try:
        parsed, res = generate(db, user, "interview_questions", {"items": items, "gaps": gaps[:6]},
                               {"resume": resume_context_for(c), "jd": jd_text}, content=c)
        qs, source = [q.model_dump() for q in parsed.questions], res.provider  # type: ignore[attr-defined]
    except LLMUnavailable:
        qs, source = template_interview_questions(c, gaps), "template"
    qs = [{"id": f"q{i}", **q} for i, q in enumerate(qs[:8], 1)]
    s = InterviewSession(user_id=user.id, version_id=v.id, target_kind=kind, target_id=tid, target_title=title,
                         questions=qs, questions_source=source)
    db.add(s)
    db.commit()
    return _session_out(s)


@router.get("/interviews")
def list_interviews(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(InterviewSession).where(InterviewSession.user_id == user.id).order_by(InterviewSession.created_at.desc()))
    return [{k: x[k] for k in ("id", "version_id", "target", "answered", "created_at")} | {"questions": len(x["questions"])}
            for x in map(_session_out, rows)]


@router.get("/interviews/{session_id}")
def get_interview(session_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return _session_out(get_owned(db, InterviewSession, session_id, user))


class AnswerIn(BaseModel):
    question_id: str = Field(max_length=10)
    answer: str = Field(min_length=1, max_length=4000)
    ai_feedback: bool = True


@router.post("/interviews/{session_id}/answers")
def answer(session_id: str, body: AnswerIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    s = get_owned(db, InterviewSession, session_id, user)
    q = next((x for x in s.questions if x["id"] == body.question_id), None)
    if not q:
        raise err(404, "not_found", "Question not found.")
    v = db.get(ResumeVersion, s.version_id)
    assert v
    c = ResumeContent.model_validate(v.content)
    checks = rule_checks(q["question"], body.answer, c)
    ai: dict = {"status": "skipped"}
    if body.ai_feedback:
        try:
            parsed, res = generate(db, user, "interview_feedback", {"question": q["question"], "answer": body.answer},
                                   {"resume": resume_context_for(c)}, content=c)
            ai = {"status": "ok", **parsed.model_dump(), "provider": res.provider, "model": res.model,
                  "is_fixture": res.provider == "fixture",
                  "label": "Development fixture — not live AI" if res.provider == "fixture" else "AI coaching"}
        except LLMUnavailable as exc:
            ai = {"status": "unavailable", "code": exc.code, "message": exc.message}
    ans = _answers(s)
    ans[q["id"]] = {"answer": body.answer, "checks": checks, "ai": ai, "at": utcnow().isoformat()}
    s.answers_enc = json.dumps(ans)
    s.updated_at = utcnow()
    db.commit()
    return {"question_id": q["id"], "checks": checks, "ai": ai}


@router.delete("/interviews/{session_id}", status_code=204)
def delete_interview(session_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, InterviewSession, session_id, user))
    db.commit()
    return Response(status_code=204)
