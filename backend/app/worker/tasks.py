from __future__ import annotations

from celery.exceptions import SoftTimeLimitExceeded

import app.services.pipeline  # noqa: F401 - registers job handlers
from app.db import SessionLocal
from app.observability import get_logger
from app.services.jobs import recover_stale_jobs, run_job, update_queue_gauge
from app.worker.celery_app import celery_app

log = get_logger("worker")

# Per-task time limits (seconds): (soft, hard). The soft limit raises SoftTimeLimitExceeded inside the
# task so it can stop cleanly; the hard limit kills the pool process. `run_job` keeps the global
# limits from celery_app (parse timeout + 30 / + 60), sized for one sandboxed parse or one export.
LIMITS = {
    "recover": (60, 90),
    "queue_depth": (20, 30),
    "retention": (55 * 60, 60 * 60),  # nightly; commits in batches, so a stop keeps finished work
    "opening_alerts": (10 * 60, 11 * 60),  # scans opted-in users for one opening
    "refresh_openings": (20 * 60, 22 * 60),  # rescoring is bounded per run (500 openings / applications)
}


@celery_app.task(name="ri.run_job")
def run_job_task(job_id: str) -> str:
    return run_job(job_id)


@celery_app.task(name="ri.recover_stale_jobs", soft_time_limit=LIMITS["recover"][0], time_limit=LIMITS["recover"][1])
def recover_task() -> int:
    db = SessionLocal()
    try:
        return recover_stale_jobs(db)
    finally:
        db.close()


@celery_app.task(name="ri.queue_depth", soft_time_limit=LIMITS["queue_depth"][0], time_limit=LIMITS["queue_depth"][1])
def queue_depth_task() -> dict:
    db = SessionLocal()
    try:
        return update_queue_gauge(db)
    finally:
        db.close()


@celery_app.task(name="ri.retention_sweep", soft_time_limit=LIMITS["retention"][0], time_limit=LIMITS["retention"][1])
def retention_task() -> dict:
    from app.services.pipeline import retention_sweep

    db = SessionLocal()
    try:
        return retention_sweep(db)
    except SoftTimeLimitExceeded:
        # batches already committed stay deleted; tomorrow's run continues with the rest
        db.rollback()
        log.warning("retention.time_limit", soft_limit_s=LIMITS["retention"][0])
        return {"stopped": "time_limit"}
    finally:
        db.close()


@celery_app.task(name="ri.opening_alerts", soft_time_limit=LIMITS["opening_alerts"][0],
                 time_limit=LIMITS["opening_alerts"][1])
def opening_alerts_task(opening_id: str) -> dict:
    from app.services.alerts import send_opening_alerts

    db = SessionLocal()
    try:
        return send_opening_alerts(db, opening_id)
    finally:
        db.close()


@celery_app.task(name="ri.refresh_stale_openings", soft_time_limit=LIMITS["refresh_openings"][0],
                 time_limit=LIMITS["refresh_openings"][1])
def refresh_stale_openings_task() -> dict:
    """Re-read openings and rescore applications scored by an older matcher version (nightly)."""
    from app.services.openings import refresh_stale

    db = SessionLocal()
    try:
        out = refresh_stale(db)
        db.commit()
        return out
    except SoftTimeLimitExceeded:
        db.rollback()  # nothing committed this run; tomorrow's run starts again, still bounded
        log.warning("refresh_openings.time_limit", soft_limit_s=LIMITS["refresh_openings"][0])
        return {"stopped": "time_limit"}
    finally:
        db.close()
