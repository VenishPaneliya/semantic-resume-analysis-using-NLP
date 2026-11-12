"""Prometheus metrics: multiprocess aggregation (uvicorn workers, Celery pool children) and the worker exporter."""

from __future__ import annotations

import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from app.config import get_settings

BACKEND = Path(__file__).resolve().parents[1]

_INCREMENT = (
    "from app.observability import HTTP_REQUESTS, QUEUE_DEPTH\n"
    "HTTP_REQUESTS.labels('GET', '/api/x', '200').inc()\n"
    "QUEUE_DEPTH.labels('queued').set(int(__import__('sys').argv[1]))\n"
)
_RENDER = "from app.observability import render_metrics\nprint(render_metrics()[0].decode())\n"


def _run(code: str, env: dict, *args: str) -> str:
    out = subprocess.run(  # noqa: S603 - fixed code, this interpreter
        [sys.executable, "-c", code, *args], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120
    )
    assert out.returncode == 0, out.stderr
    return out.stdout


def test_multiprocess_mode_sums_counters_across_processes(tmp_path):
    env = {**os.environ, "PROMETHEUS_MULTIPROC_DIR": str(tmp_path / "prom")}
    # two separate processes, like two uvicorn workers or two Celery pool children
    _run(_INCREMENT, env, "3")
    _run(_INCREMENT, env, "7")
    text = _run(_RENDER, env)
    assert 'ri_http_requests_total{method="GET",route="/api/x",status="200"} 2.0' in text
    # the gauge reports the latest value, not a per-process series or a sum
    assert 'ri_queue_depth{status="queued"} 7.0' in text
    assert "pid=" not in text


def test_api_metrics_requires_token_when_set(app, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("METRICS_TOKEN", "scrape-token-123")
    get_settings.cache_clear()
    client = TestClient(app)
    try:
        assert client.get("/api/metrics").status_code == 401
        assert client.get("/api/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 401
        ok = client.get("/api/metrics", headers={"Authorization": "Bearer scrape-token-123"})
        assert ok.status_code == 200 and "ri_queue_depth" in ok.text
    finally:
        get_settings.cache_clear()


@pytest.fixture
def worker_exporter(monkeypatch):
    from app.observability import start_worker_metrics_server

    monkeypatch.setenv("METRICS_TOKEN", "scrape-token-123")
    get_settings.cache_clear()
    assert start_worker_metrics_server(port=0) is None  # 0 = exporter off
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = start_worker_metrics_server(port=port, host="127.0.0.1")
    assert server is not None
    yield f"http://127.0.0.1:{port}"
    server.shutdown()
    server.server_close()
    get_settings.cache_clear()


def _get(url: str, token: str | None = None) -> tuple[int, str]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(url, headers=headers)  # noqa: S310 - local test server
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - local test server
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, ""


def test_worker_exporter_serves_metrics_with_the_same_token(worker_exporter):
    from app.observability import JOB_FAILURES

    JOB_FAILURES.labels("parse", "test_code").inc()
    assert _get(f"{worker_exporter}/metrics")[0] == 401
    assert _get(f"{worker_exporter}/metrics", "wrong")[0] == 401
    assert _get(f"{worker_exporter}/other", "scrape-token-123")[0] == 404
    status, body = _get(f"{worker_exporter}/metrics", "scrape-token-123")
    assert status == 200
    assert 'ri_job_failures_total{code="test_code",kind="parse"}' in body
