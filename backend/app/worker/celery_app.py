"""Celery application. Workers execute durable jobs by id; job state lives in PostgreSQL,
so a lost broker message or crashed worker is recovered by `recover_stale_jobs`."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_init

from app.config import get_settings

s = get_settings()
celery_app = Celery("resume_intelligence", broker=s.redis_url, backend=None)
celery_app.conf.update(
    task_acks_late=True,                 # message is re-delivered if the worker dies mid-task
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=s.parse_timeout_seconds + 30,
    task_time_limit=s.parse_timeout_seconds + 60,
    worker_max_tasks_per_child=200,      # bound memory growth from document libraries
    worker_max_memory_per_child=600_000, # KiB
    task_default_queue="default",
    broker_connection_retry_on_startup=True,
    beat_schedule={
        "recover-stale-jobs": {"task": "ri.recover_stale_jobs", "schedule": 120.0},
        "queue-depth": {"task": "ri.queue_depth", "schedule": 30.0},
        "retention-sweep": {"task": "ri.retention_sweep", "schedule": crontab(hour=3, minute=15)},
        # after a deploy that changes the matcher, rescore openings and applications overnight
        "refresh-stale-openings": {"task": "ri.refresh_stale_openings", "schedule": crontab(hour=2, minute=30)},
    },
)


@worker_init.connect
def _start_metrics_exporter(**_kwargs) -> None:
    # runs in the worker's main process before the pool forks; off unless WORKER_METRICS_PORT is set
    from app.observability import start_worker_metrics_server

    start_worker_metrics_server()


celery_app.autodiscover_tasks(["app.worker"], related_name="tasks", force=True)

import app.worker.tasks  # noqa: E402,F401  - register tasks
