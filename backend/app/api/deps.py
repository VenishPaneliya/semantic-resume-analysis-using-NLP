from __future__ import annotations

import hmac
from typing import TypeVar

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User, UserSession, utcnow
from app.security.ratelimit import enforce
from app.security.sessions import lookup_session

T = TypeVar("T")


def err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def client_ip(request: Request) -> str:
    s = get_settings()
    if s.trusted_proxies > 0:
        fwd = request.headers.get("x-forwarded-for", "")
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if len(parts) >= s.trusted_proxies:
            return parts[-s.trusted_proxies]
    return request.client.host if request.client else "unknown"


def current_session(request: Request, db: Session = Depends(get_db)) -> UserSession:
    s = get_settings()
    sess = lookup_session(db, request.cookies.get(s.session_cookie_name))
    if not sess or not sess.user or not sess.user.is_active:
        raise err(status.HTTP_401_UNAUTHORIZED, "not_authenticated", "Please sign in.")
    now = utcnow()
    if (now - sess.last_seen_at).total_seconds() > 300:
        sess.last_seen_at = now
        db.commit()
    request.state.user_id = sess.user_id
    return sess


def current_user(sess: UserSession = Depends(current_session)) -> User:
    enforce(f"api:{sess.user_id}", get_settings().api_rate_per_minute)
    return sess.user


def verified_user(user: User = Depends(current_user)) -> User:
    if not user.email_verified_at:
        raise err(status.HTTP_403_FORBIDDEN, "email_not_verified", "Please verify your email address first.")
    return user


def admin_user(user: User = Depends(verified_user)) -> User:
    if user.role != "admin":
        raise err(status.HTTP_403_FORBIDDEN, "forbidden", "Administrator access required.")
    return user


def recruiter_user(user: User = Depends(verified_user)) -> User:
    """HR staff who post openings and review applicants. Admins are recruiters too."""
    if user.role not in ("recruiter", "admin"):
        raise err(status.HTTP_403_FORBIDDEN, "forbidden", "Recruiter access required.")
    return user


def get_owned(db: Session, model: type[T], obj_id: str, user: User) -> T:
    """Fetch a row owned by `user`. Returns 404 (not 403) for other users' rows so the
    existence of foreign IDs is never revealed."""
    obj = db.get(model, obj_id)
    if obj is None or getattr(obj, "user_id", None) != user.id:
        raise err(status.HTTP_404_NOT_FOUND, "not_found", f"{model.__name__} not found.")
    return obj


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT = {"/api/auth/login", "/api/auth/register", "/api/auth/forgot-password", "/api/auth/reset-password",
               "/api/auth/verify-email", "/api/auth/google/callback"}


def csrf_ok(request: Request) -> bool:
    """Double-submit check for cookie-authenticated unsafe requests."""
    if request.method in SAFE_METHODS or request.url.path in CSRF_EXEMPT:
        return True
    s = get_settings()
    if s.session_cookie_name not in request.cookies:
        return True  # unauthenticated: nothing to forge
    cookie = request.cookies.get(s.csrf_cookie_name, "")
    header = request.headers.get("x-csrf-token", "")
    return bool(cookie) and hmac.compare_digest(cookie, header)
