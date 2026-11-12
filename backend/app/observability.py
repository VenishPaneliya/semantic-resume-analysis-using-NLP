"""Structured logging, Prometheus metrics and optional Sentry.

Metrics run in prometheus_client's multiprocess mode when PROMETHEUS_MULTIPROC_DIR is set (the Docker
image sets it): every process (each uvicorn worker, each Celery pool child) writes its values to files in
that directory, and an exposition merges them, so one scrape returns the totals for the whole container.
Without the variable (tests, `uvicorn --reload`) metrics stay in this process's memory.
"""

from __future__ import annotations

import hmac
import logging
import os
import socketserver
import sys
import threading
import time
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

import structlog
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

from app.config import get_settings

MULTIPROC_DIR = os.environ.get("PROMETHEUS_MULTIPROC_DIR") or os.environ.get("prometheus_multiproc_dir")
if MULTIPROC_DIR:
    # values are mmap files in this directory, opened when the metrics below are created
    os.makedirs(MULTIPROC_DIR, exist_ok=True)

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
# set from a database count by whichever process ran it last; in multiprocess mode report that latest value
QUEUE_DEPTH = Gauge(
    "ri_queue_depth", "Jobs waiting by status", ["status"], registry=REGISTRY, multiprocess_mode="mostrecent"
)
LLM_CALLS = Counter("ri_llm_calls_total", "LLM calls", ["provider", "operation", "outcome"], registry=REGISTRY)
LLM_COST = Counter("ri_llm_cost_usd_total", "Estimated LLM cost in USD", ["provider"], registry=REGISTRY)
LLM_LATENCY = Histogram(
    "ri_llm_seconds", "LLM latency", ["provider", "operation"], registry=REGISTRY,
    buckets=(0.5, 1, 2, 5, 10, 20, 40, 80),
)


def exposition_registry() -> CollectorRegistry:
    """The registry to serialise for a scrape: all processes' values in multiprocess mode, else this process's."""
    if not MULTIPROC_DIR:
        return REGISTRY
    from prometheus_client.multiprocess import MultiProcessCollector

    registry = CollectorRegistry()
    MultiProcessCollector(registry, path=MULTIPROC_DIR)
    return registry


def render_metrics() -> tuple[bytes, str]:
    return generate_latest(exposition_registry()), CONTENT_TYPE_LATEST


def metrics_authorized(authorization: str | None) -> bool:
    """Bearer METRICS_TOKEN check shared by the API endpoint and the worker exporter (open when no token is set)."""
    token = get_settings().metrics_token
    if not token:
        return True
    return hmac.compare_digest((authorization or "").encode(), f"Bearer {token}".encode())


def metrics_wsgi_app(environ, start_response):
    """Worker metrics exporter: GET /metrics with the same bearer token as the API's /api/metrics."""
    if not get_settings().metrics_enabled or environ.get("PATH_INFO", "") not in ("/metrics", "/metrics/"):
        start_response("404 Not Found", [("Content-Type", "text/plain")])
        return [b"not found"]
    if not metrics_authorized(environ.get("HTTP_AUTHORIZATION")):
        start_response("401 Unauthorized", [("Content-Type", "text/plain"), ("WWW-Authenticate", "Bearer")])
        return [b"unauthorized"]
    body, content_type = render_metrics()
    start_response("200 OK", [("Content-Type", content_type), ("Content-Length", str(len(body)))])
    return [body]


class _ThreadingWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    daemon_threads = True


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - scrapes would flood the worker log
        pass


def start_worker_metrics_server(port: int | None = None, host: str = "0.0.0.0") -> WSGIServer | None:  # noqa: S104
    """Serve worker metrics on WORKER_METRICS_PORT from a daemon thread (0 = off). Call in the Celery main
    process before the pool forks; pool children write to PROMETHEUS_MULTIPROC_DIR, which this server reads."""
    s = get_settings()
    port = s.worker_metrics_port if port is None else port
    if not port or not s.metrics_enabled:
        return None
    if not MULTIPROC_DIR:
        get_logger("metrics").warning("worker_metrics_single_process", hint="set PROMETHEUS_MULTIPROC_DIR")
    server = make_server(host, port, metrics_wsgi_app, _ThreadingWSGIServer, handler_class=_QuietHandler)
    threading.Thread(target=server.serve_forever, name="metrics-exporter", daemon=True).start()
    get_logger("metrics").info("worker_metrics_listening", port=server.server_port)
    return server


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
