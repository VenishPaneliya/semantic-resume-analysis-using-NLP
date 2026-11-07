"""Restricted operational dashboard. Exposes aggregates and metadata only — never resume
or job-description content."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.deps import admin_user
from app.config import get_settings
from app.db import get_db
from app.models import AuditLog, ProcessingJob, Resume, UsageEvent, User, utcnow
from app.services.jobs import recover_stale_jobs, update_queue_gauge
from app.services.llm.providers import get_provider
from app.services.ml.embeddings import get_embedder
from app.services.taxonomy import get_taxonomy
from app.versions import JD_MATCHER_VERSION, PROMPT_VERSION, RECOMMENDER_VERSION, RUBRIC_VERSION

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/overview")
def overview(_: User = Depends(admin_user), db: Session = Depends(get_db)):
    now = utcnow()
    week = now - timedelta(days=7)
    jobs = update_queue_gauge(db)
    failures = db.execute(select(ProcessingJob.kind, ProcessingJob.error_code, func.count()).where(
        ProcessingJob.status == "failed", ProcessingJob.updated_at >= week).group_by(ProcessingJob.kind, ProcessingJob.error_code)).all()
    llm = db.execute(select(UsageEvent.provider, func.count(), func.coalesce(func.sum(UsageEvent.cost_usd), 0.0),
                            func.coalesce(func.avg(UsageEvent.latency_ms), 0.0),
                            func.sum(case((UsageEvent.success.is_(False), 1), else_=0)))
                     .where(UsageEvent.kind == "llm", UsageEvent.created_at >= week).group_by(UsageEvent.provider)).all()
    durations = db.execute(select(ProcessingJob.kind, ProcessingJob.started_at, ProcessingJob.finished_at)
                           .where(ProcessingJob.status == "succeeded", ProcessingJob.finished_at >= week)).all()
    lat: dict[str, list[float]] = {}
    for kind, st, fin in durations:
        if st and fin:
            lat.setdefault(kind, []).append((fin - st).total_seconds())
    return {
        "users": {"total": db.scalar(select(func.count(User.id))), "verified": db.scalar(select(func.count(User.id)).where(User.email_verified_at.is_not(None))),
                  "new_7d": db.scalar(select(func.count(User.id)).where(User.created_at >= week))},
        "resumes": {"total": db.scalar(select(func.count(Resume.id))),
                    "by_status": dict(db.execute(select(Resume.status, func.count()).group_by(Resume.status)).all())},
        "jobs": {"by_status": jobs, "failures_7d": [{"kind": k, "code": c, "count": n} for k, c, n in failures],
                 "avg_seconds_7d": {k: round(sum(v) / len(v), 2) for k, v in lat.items()}},
        "llm_7d": [{"provider": p, "calls": n, "cost_usd": round(float(cost), 4), "avg_latency_ms": round(float(avg)), "failures": int(f or 0)}
                   for p, n, cost, avg, f in llm],
        "versions": {"rubric": RUBRIC_VERSION, "recommender": RECOMMENDER_VERSION, "jd_matcher": JD_MATCHER_VERSION,
                     "prompts": PROMPT_VERSION, "taxonomy": get_taxonomy().version, "embedding_model": get_embedder().name,
                     "llm_provider": get_provider().name, "llm_model": get_provider().model},
        "config": {"storage": get_settings().storage_backend, "ocr_enabled": get_settings().ocr_enabled,
                   "eager_tasks": get_settings().task_always_eager},
    }


@router.get("/jobs")
def failed_jobs(status: str = Query("failed"), _: User = Depends(admin_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(ProcessingJob).where(ProcessingJob.status == status).order_by(ProcessingJob.updated_at.desc()).limit(100))
    return [{"id": j.id, "kind": j.kind, "status": j.status, "attempts": j.attempts, "error_code": j.error_code,
             "updated_at": j.updated_at.isoformat()} for j in rows]


@router.post("/jobs/recover")
def recover(_: User = Depends(admin_user), db: Session = Depends(get_db)):
    return {"redispatched": recover_stale_jobs(db)}


@router.get("/audit")
def audit_log(_: User = Depends(admin_user), db: Session = Depends(get_db), limit: int = Query(100, le=500)):
    rows = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit))
    return [{"action": a.action, "user_id": a.user_id, "target_type": a.target_type, "target_id": a.target_id, "meta": a.meta,
             "created_at": a.created_at.isoformat()} for a in rows]
