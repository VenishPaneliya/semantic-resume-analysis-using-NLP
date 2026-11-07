from __future__ import annotations

import app.services.pipeline  # noqa: F401 - registers job handlers
from app.db import SessionLocal
from app.services.jobs import recover_stale_jobs, run_job, update_queue_gauge
from app.worker.celery_app import celery_app


@celery_app.task(name="ri.run_job")
def run_job_task(job_id: str) -> str:
    return run_job(job_id)


@celery_app.task(name="ri.recover_stale_jobs")
def recover_task() -> int:
    db = SessionLocal()
    try:
        return recover_stale_jobs(db)
    finally:
        db.close()


@celery_app.task(name="ri.queue_depth")
def queue_depth_task() -> dict:
    db = SessionLocal()
    try:
        return update_queue_gauge(db)
    finally:
        db.close()


@celery_app.task(name="ri.retention_sweep")
def retention_task() -> dict:
    from app.services.pipeline import retention_sweep

    db = SessionLocal()
    try:
        return retention_sweep(db)
    finally:
        db.close()
