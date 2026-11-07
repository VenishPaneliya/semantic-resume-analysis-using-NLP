"""Durable job state machine shared by API and workers.

queued ──claim──▶ running ──▶ succeeded
   ▲                │
   └─ retryable & attempts < max ─┘──▶ failed (terminal; user may retry)

- Idempotency: jobs are unique by `idempotency_key`; enqueueing twice returns the same job.
- Claiming is a conditional UPDATE, so two workers can never run the same job.
- A lease protects against crashed workers: `recover_stale_jobs` re-queues running jobs
  whose lease expired, and failed handlers never roll back previously committed results
  (e.g. a failed LLM step cannot erase a successful parse).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models import ProcessingJob, utcnow
from app.observability import JOB_DURATION, JOB_FAILURES, QUEUE_DEPTH, Timer, get_logger

log = get_logger("jobs")
LEASE = timedelta(minutes=5)

HANDLERS: dict[str, Callable[[Session, ProcessingJob], None]] = {}


class JobError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


def handler(kind: str):
    def deco(fn):
        HANDLERS[kind] = fn
        return fn
    return deco


def enqueue(db: Session, *, user_id: str, kind: str, target_id: str, key: str, max_attempts: int = 3) -> ProcessingJob:
    existing = db.scalar(select(ProcessingJob).where(ProcessingJob.idempotency_key == key))
    if existing:
        return existing
    job = ProcessingJob(user_id=user_id, kind=kind, target_id=target_id, idempotency_key=key, max_attempts=max_attempts)
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(ProcessingJob).where(ProcessingJob.idempotency_key == key))
        assert existing
        return existing
    return job


def dispatch(job_id: str, countdown: int = 0) -> None:
    s = get_settings()
    if s.task_always_eager:
        run_job(job_id)
        return
    from app.worker.celery_app import celery_app  # pragma: no cover - needs broker

    celery_app.send_task("ri.run_job", args=[job_id], countdown=countdown)  # pragma: no cover


def _claim(db: Session, job_id: str) -> ProcessingJob | None:
    now = utcnow()
    res = db.execute(
        update(ProcessingJob)
        .where(ProcessingJob.id == job_id)
        .where(or_(ProcessingJob.status == "queued",
                   (ProcessingJob.status == "running") & (ProcessingJob.lease_expires_at < now)))
        .where(ProcessingJob.attempts < ProcessingJob.max_attempts)
        .values(status="running", attempts=ProcessingJob.attempts + 1, started_at=now,
                lease_expires_at=now + LEASE, error_code=None, error_message=None)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    if res.rowcount != 1:
        return None
    return db.get(ProcessingJob, job_id, populate_existing=True)


def run_job(job_id: str) -> str:
    db = SessionLocal()
    try:
        job = _claim(db, job_id)
        if job is None:
            return "skipped"
        fn = HANDLERS.get(job.kind)
        with Timer() as t:
            try:
                if fn is None:
                    raise JobError("unknown_job", f"No handler for {job.kind}")
                fn(db, job)
                job.status, job.progress, job.stage = "succeeded", 100, "done"
                job.finished_at = utcnow()
                db.commit()
                outcome = "succeeded"
            except Exception as exc:  # noqa: BLE001 - classify every failure
                db.rollback()
                job = db.get(ProcessingJob, job_id, populate_existing=True)
                assert job
                code = getattr(exc, "code", "internal_error")
                msg = getattr(exc, "message", "An unexpected error occurred while processing.")
                retryable = getattr(exc, "retryable", not isinstance(exc, JobError | ValueError))
                JOB_FAILURES.labels(job.kind, code).inc()
                job.error_code, job.error_message = code, msg[:500]
                if retryable and job.attempts < job.max_attempts:
                    job.status = "queued"
                    job.stage = f"retrying ({job.attempts}/{job.max_attempts})"
                    outcome = "retry"
                else:
                    job.status = "failed"
                    job.finished_at = utcnow()
                    outcome = "failed"
                    _on_terminal_failure(db, job)
                db.commit()
                log.warning("job.failed", job_id=job.id, kind=job.kind, code=code, attempt=job.attempts, outcome=outcome)
                if outcome == "retry":
                    dispatch(job.id, countdown=min(60, 2 ** job.attempts * 5))
        JOB_DURATION.labels(job.kind, outcome).observe(t.elapsed)
        return outcome
    finally:
        db.close()


def _on_terminal_failure(db: Session, job: ProcessingJob) -> None:
    from app.models import Export, Resume

    if job.kind == "parse_resume":
        r = db.get(Resume, job.target_id)
        if r and r.status in ("uploaded", "processing"):
            r.status, r.error_code, r.error_message = "failed", job.error_code, job.error_message
    elif job.kind == "export":
        e = db.get(Export, job.target_id)
        if e:
            e.status, e.error_message = "failed", job.error_message


def retry_failed(db: Session, job: ProcessingJob) -> ProcessingJob:
    if job.status != "failed":
        return job
    job.status, job.attempts, job.error_code, job.error_message, job.finished_at = "queued", 0, None, None, None
    if job.kind == "parse_resume":
        from app.models import Resume

        r = db.get(Resume, job.target_id)
        if r:
            r.status, r.error_code, r.error_message = "processing", None, None
    db.commit()
    dispatch(job.id)
    return job


def recover_stale_jobs(db: Session, older_than: timedelta = timedelta(minutes=10)) -> int:
    """Re-dispatch jobs whose worker died (expired lease) or whose message was lost."""
    now = utcnow()
    stale = list(db.scalars(select(ProcessingJob).where(
        or_((ProcessingJob.status == "running") & (ProcessingJob.lease_expires_at < now),
            (ProcessingJob.status == "queued") & (ProcessingJob.updated_at < now - older_than))
    )))
    n = 0
    for job in stale:
        if job.attempts >= job.max_attempts:
            job.status, job.error_code, job.error_message, job.finished_at = "failed", "worker_lost", "Processing was interrupted repeatedly.", now
            _on_terminal_failure(db, job)
        else:
            n += 1
    db.commit()
    for job in stale:
        if job.status != "failed":
            dispatch(job.id)
    return n


def update_queue_gauge(db: Session) -> dict:
    from sqlalchemy import func

    rows = dict(db.execute(select(ProcessingJob.status, func.count()).group_by(ProcessingJob.status)).all())
    for st in ("queued", "running", "failed", "succeeded"):
        QUEUE_DEPTH.labels(st).set(rows.get(st, 0))
    return rows
