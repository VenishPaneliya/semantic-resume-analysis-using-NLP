"""Opaque server-side sessions in HTTP-only cookies + double-submit CSRF token."""

from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import UserSession, utcnow
from app.security.crypto import sha256_hex


def create_session(db: Session, user_id: str, user_agent: str | None) -> tuple[str, UserSession]:
    token = secrets.token_urlsafe(32)
    s = get_settings()
    sess = UserSession(
        user_id=user_id,
        token_hash=sha256_hex(token),
        expires_at=utcnow() + timedelta(hours=s.session_ttl_hours),
        user_agent=(user_agent or "")[:255],
    )
    db.add(sess)
    db.flush()
    return token, sess


def lookup_session(db: Session, token: str | None) -> UserSession | None:
    if not token:
        return None
    sess = db.scalar(select(UserSession).where(UserSession.token_hash == sha256_hex(token)))
    if not sess or sess.revoked_at is not None or sess.expires_at <= utcnow():
        return None
    return sess


def revoke_all_sessions(db: Session, user_id: str, except_id: str | None = None) -> None:
    for sess in db.scalars(select(UserSession).where(UserSession.user_id == user_id)):
        if sess.id != except_id and sess.revoked_at is None:
            sess.revoked_at = utcnow()


def set_session_cookies(response: Response, token: str) -> str:
    s = get_settings()
    csrf = secrets.token_urlsafe(24)
    max_age = s.session_ttl_hours * 3600
    response.set_cookie(
        s.session_cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=s.cookie_secure,
        samesite="lax",
        domain=s.cookie_domain,
        path="/",
    )
    # readable by JS on purpose (double-submit pattern); not a credential on its own
    response.set_cookie(
        s.csrf_cookie_name,
        csrf,
        max_age=max_age,
        httponly=False,
        secure=s.cookie_secure,
        samesite="lax",
        domain=s.cookie_domain,
        path="/",
    )
    return csrf


def clear_session_cookies(response: Response) -> None:
    s = get_settings()
    for name in (s.session_cookie_name, s.csrf_cookie_name):
        response.delete_cookie(name, domain=s.cookie_domain, path="/")
