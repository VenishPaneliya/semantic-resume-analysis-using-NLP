from __future__ import annotations

import time
import uuid

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

import app.services.pipeline  # noqa: F401 - registers job handlers
from app.api import (
    account,
    account_extra,
    admin,
    applications,
    auth,
    career,
    engagement,
    exports,
    health,
    jobdesc,
    openings,
    processing,
    recruiter,
    resumes,
    suggestions,
    versions,
)
from app.api.deps import client_ip, csrf_ok
from app.config import get_settings
from app.observability import HTTP_LATENCY, HTTP_REQUESTS, configure_logging, get_logger
from app.security.ratelimit import enforce
from app.services.llm.providers import LLMUnavailable
from app.services.upload_validation import UploadRejected

log = get_logger("http")

TAGS = [
    {"name": "auth", "description": "Registration, sessions, email verification, password reset, Google OAuth."},
    {"name": "account", "description": "Settings, AI consent, data export and account deletion."},
    {"name": "resumes", "description": "Upload, extraction review and resume variants."},
    {"name": "versions", "description": "Version history, analysis, recommendations, skill gaps."},
    {"name": "job-descriptions", "description": "Job description extraction and matching."},
    {"name": "suggestions", "description": "AI edit suggestions requiring explicit acceptance."},
    {"name": "exports", "description": "PDF/DOCX generation."},
    {"name": "career", "description": "Roadmaps, interview questions, cover letters, integrations."},
    {"name": "applications", "description": "Manual job application tracker."},
    {"name": "leaderboard", "description": "Role and opening leaderboards, standing among applicants, relevance-gated tips."},
    {"name": "recruiter", "description": "HR staff: post openings and review ranked applicants."},
    {"name": "engagement", "description": "What-if scoring, learning plan, resume history, mock interviews."},
    {"name": "admin", "description": "Restricted operational dashboard."},
]


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging()
    app = FastAPI(
        title="Resume Intelligence API",
        version="0.1.0",
        description="AI Resume Intelligence and Career Assistant. All scores are advisory indicators, not ATS scores or hiring probabilities.",
        # the interactive docs and schema are for development; in production the contract is docs/openapi.json
        openapi_url=None if s.env == "production" else "/api/openapi.json",
        docs_url=None if s.env == "production" else "/api/docs",
        redoc_url=None,
        openapi_tags=TAGS,
    )
    if s.google_oauth_enabled:
        # Authlib keeps the OAuth state/nonce in a short-lived signed cookie
        from starlette.middleware.sessions import SessionMiddleware

        app.add_middleware(SessionMiddleware, secret_key=s.secret_key, session_cookie="ri_oauth", max_age=600,
                           same_site="lax", https_only=s.cookie_secure)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["content-type", "x-csrf-token"],
    )

    @app.middleware("http")
    async def core(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=rid)
        start = time.perf_counter()
        if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/health"):
            try:
                ip = client_ip(request)
                # credential-bearing auth POSTs get their own strict bucket; reads such as /auth/me do not count
                is_auth_post = request.url.path.startswith("/api/auth/") and request.method == "POST"
                cfg = get_settings()  # read per request, not the copy captured at startup
                limit = cfg.login_rate_per_minute if is_auth_post else cfg.api_rate_per_minute * 2
                enforce(f"ip:{ip}:{'auth' if is_auth_post else 'api'}", limit)
            except Exception as exc:  # HTTPException from enforce
                return JSONResponse(status_code=429, content={"detail": exc.detail}, headers={"Retry-After": "60"})  # type: ignore[attr-defined]
            if not csrf_ok(request):
                return JSONResponse(status_code=403, content={"detail": {"code": "csrf_failed", "message": "Security token missing or invalid. Refresh the page and try again."}})
        response = await call_next(request)
        elapsed = time.perf_counter() - start
        route = request.scope.get("route")
        path = getattr(route, "path", "unmatched")
        HTTP_REQUESTS.labels(request.method, path, str(response.status_code)).inc()
        HTTP_LATENCY.labels(request.method, path).observe(elapsed)
        response.headers["x-request-id"] = rid
        response.headers["x-content-type-options"] = "nosniff"
        response.headers["referrer-policy"] = "strict-origin-when-cross-origin"
        response.headers["x-frame-options"] = "DENY"
        response.headers["permissions-policy"] = "camera=(), microphone=(), geolocation=()"
        if not request.url.path.startswith("/api/docs"):
            response.headers["content-security-policy"] = "default-src 'none'; frame-ancestors 'none'"
        response.headers["cache-control"] = response.headers.get("cache-control", "no-store")
        if s.cookie_secure:
            response.headers["strict-transport-security"] = "max-age=31536000; includeSubDomains"
        if path != "/api/health/live":
            log.info("request", method=request.method, path=path, status=response.status_code, ms=round(elapsed * 1000, 1))
        return response

    @app.exception_handler(UploadRejected)
    async def _upload(_, exc: UploadRejected):
        return JSONResponse(status_code=exc.status, content={"detail": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(LLMUnavailable)
    async def _llm(_, exc: LLMUnavailable):
        code = {"ai_consent_required": 403, "ai_daily_limit": 429, "ai_monthly_limit": 429, "ai_disabled": 503}.get(exc.code, 503)
        return JSONResponse(status_code=code, content={"detail": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(IntegrityError)
    async def _conflict(request: Request, exc: IntegrityError):
        # two requests raced to create the same thing (e.g. a double-clicked Apply or Save); the
        # request's session is closed by get_db, which rolls the failed transaction back
        log.info("integrity_conflict", path=request.url.path, error=type(exc.orig).__name__ if exc.orig else None)
        return JSONResponse(status_code=409, content={"detail": {
            "code": "conflict", "message": "This was just changed by another request. Reload and try again."}})

    @app.exception_handler(RequestValidationError)
    async def _val(_, exc: RequestValidationError):
        errors = [{"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()][:20]
        return JSONResponse(status_code=422, content={"detail": {"code": "validation_error", "message": "Some fields are invalid.", "errors": errors}})

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # pragma: no cover - defensive
        log.exception("unhandled", path=request.url.path, error=type(exc).__name__)
        return JSONResponse(status_code=500, content={"detail": {"code": "internal_error", "message": "Something went wrong. Please try again."}})

    if s.env != "test" and s.embedding_backend != "tfidf":
        # load the embedding model in the background at startup, so the first user request doesn't
        # pay the 10–30 s model load (and hit proxy timeouts)
        import threading

        def _warm() -> None:
            try:
                from app.services.ml.embeddings import get_embedder

                get_embedder().encode(["warm up"])
                log.info("embeddings.warmed")
            except Exception as exc:  # noqa: BLE001 - warm-up must never break startup
                log.warning("embeddings.warmup_failed", error=type(exc).__name__)

        threading.Thread(target=_warm, name="embedding-warmup", daemon=True).start()

    for r in (health, auth, account, resumes, versions, jobdesc, suggestions, exports, career, applications, openings, recruiter, engagement, account_extra, processing, admin):
        app.include_router(r.router)
    return app


app = create_app()
