from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.observability import metrics_authorized, render_metrics
from app.services.jobs import update_queue_gauge

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health/live")
def live() -> dict:
    return {"status": "ok"}


@router.get("/health/ready")
def ready(response: Response, db: Session = Depends(get_db)) -> dict:
    s = get_settings()
    checks: dict[str, str] = {}
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "error"
    if not s.task_always_eager:  # pragma: no cover - needs redis
        try:
            import redis

            redis.Redis.from_url(s.redis_url, socket_timeout=2).ping()
            checks["redis"] = "ok"
        except Exception:
            checks["redis"] = "error"
    try:
        from app.services.storage import get_storage

        get_storage().exists("healthcheck/probe")
        checks["storage"] = "ok"
    except Exception:
        checks["storage"] = "error"
    checks["llm_provider"] = s.llm_provider
    ok = all(v == "ok" for k, v in checks.items() if k != "llm_provider")
    if not ok:
        response.status_code = 503
    return {"status": "ok" if ok else "degraded", "checks": checks}


@router.get("/metrics", include_in_schema=False)
def metrics(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> Response:
    s = get_settings()
    if not s.metrics_enabled:
        raise HTTPException(404)
    if not metrics_authorized(authorization):
        raise HTTPException(401)
    update_queue_gauge(db)
    # all uvicorn workers' values when PROMETHEUS_MULTIPROC_DIR is set (see app.observability)
    body, content_type = render_metrics()
    return Response(body, media_type=content_type)
