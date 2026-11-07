"""Structured logging, Prometheus metrics and optional Sentry."""

from __future__ import annotations

import logging
import sys
import time

import structlog
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

from app.config import get_settings

REGISTRY = CollectorRegistry(auto_describe=True)

HTTP_REQUESTS = Counter(
    "ri_http_requests_total", "HTTP requests", ["method", "route", "status"], registry=REGISTRY
)
HTTP_LATENCY = Histogram(
    "ri_http_request_seconds", "HTTP latency", ["method", "route"], registry=REGISTRY,
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10),
)
JOB_DURATION = Histogram(
    "ri_job_seconds", "Background job duration", ["kind", "status"], registry=REGISTRY,
    buckets=(0.1, 0.5, 1, 2, 5, 10, 30, 60, 120),
)
JOB_FAILURES = Counter("ri_job_failures_total", "Job failures", ["kind", "code"], registry=REGISTRY)
QUEUE_DEPTH = Gauge("ri_queue_depth", "Jobs waiting by status", ["status"], registry=REGISTRY)
LLM_CALLS = Counter("ri_llm_calls_total", "LLM calls", ["provider", "operation", "outcome"], registry=REGISTRY)
LLM_COST = Counter("ri_llm_cost_usd_total", "Estimated LLM cost in USD", ["provider"], registry=REGISTRY)
LLM_LATENCY = Histogram(
    "ri_llm_seconds", "LLM latency", ["provider", "operation"], registry=REGISTRY,
    buckets=(0.5, 1, 2, 5, 10, 20, 40, 80),
)


def _drop_sensitive(_, __, event_dict):
    # defensive: never log these keys even if a caller passes them
    for k in ("password", "token", "raw_text", "content", "resume_text", "jd_text"):
        if k in event_dict:
            event_dict[k] = "[redacted]"
    return event_dict


def configure_logging() -> None:
    s = get_settings()
    level = getattr(logging, s.log_level.upper(), logging.INFO)
    logging.basicConfig(stream=sys.stdout, level=level, format="%(message)s")
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _drop_sensitive,
        structlog.processors.JSONRenderer() if s.log_json else structlog.dev.ConsoleRenderer(),
    ]
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )
    if s.sentry_dsn:  # pragma: no cover - requires DSN
        import sentry_sdk

        sentry_sdk.init(dsn=s.sentry_dsn, environment=s.env, send_default_pii=False, traces_sample_rate=0.05)


def get_logger(name: str = "app"):
    return structlog.get_logger(name)


class Timer:
    def __enter__(self):
        self.start = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.elapsed = time.perf_counter() - self.start
        return False
