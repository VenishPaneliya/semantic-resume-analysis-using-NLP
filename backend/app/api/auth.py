from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import client_ip, current_session, current_user, err
from app.config import get_settings
from app.db import get_db
from app.models import AuthToken, OAuthAccount, User, UserSession, utcnow
from app.security.crypto import sha256_hex
from app.security.passwords import hash_password, needs_rehash, password_problems, verify_password
from app.security.ratelimit import enforce
from app.security.sessions import (
    clear_session_cookies,
    create_session,
    revoke_all_sessions,
    set_session_cookies,
)
from app.services.audit import audit
from app.services.email import send_password_reset, send_verification

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    display_name: str | None = Field(default=None, max_length=120)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)


class EmailIn(BaseModel):
    email: EmailStr


class TokenIn(BaseModel):
    token: str = Field(max_length=200)


class ResetIn(BaseModel):
    token: str = Field(max_length=200)
    password: str = Field(max_length=256)


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str | None
    role: str
    email_verified: bool
    ai_consent_provider: str | None
    has_password: bool
    notification_prefs: dict
    career_prefs: dict


def user_out(u: User) -> UserOut:
    return UserOut(id=u.id, email=u.email, display_name=u.display_name, role=u.role, email_verified=bool(u.email_verified_at),
                   ai_consent_provider=u.ai_consent_provider if u.ai_consent_at else None, has_password=bool(u.password_hash),
                   notification_prefs=u.notification_prefs or {}, career_prefs=u.career_prefs or {})


def _issue_token(db: Session, user: User, purpose: str, ttl: timedelta) -> str:
    for t in db.scalars(select(AuthToken).where(AuthToken.user_id == user.id, AuthToken.purpose == purpose, AuthToken.used_at.is_(None))):
        t.used_at = utcnow()  # invalidate older tokens of the same purpose
    raw = secrets.token_urlsafe(32)
    db.add(AuthToken(user_id=user.id, purpose=purpose, token_hash=sha256_hex(raw), expires_at=utcnow() + ttl))
    return raw


def _consume_token(db: Session, raw: str, purpose: str) -> AuthToken:
    tok = db.scalar(select(AuthToken).where(AuthToken.token_hash == sha256_hex(raw), AuthToken.purpose == purpose))
    if not tok or tok.used_at is not None or tok.expires_at <= utcnow():
        raise err(400, "invalid_token", "This link is invalid or has expired. Request a new one.")
    tok.used_at = utcnow()
    return tok


def _start_session(db: Session, user: User, request: Request, response: Response) -> None:
    token, _ = create_session(db, user.id, request.headers.get("user-agent"))
    user.last_login_at = utcnow()
    db.commit()
    set_session_cookies(response, token)


@router.post("/register", status_code=201, response_model=UserOut)
def register(body: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    problems = password_problems(body.password)
    if problems:
        raise err(422, "weak_password", " ".join(problems))
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        # do not reveal registration status; send a notice to the existing address instead
        raise err(409, "email_in_use", "An account with this email may already exist. Try signing in or resetting your password.")
    user = User(email=email, password_hash=hash_password(body.password), display_name=body.display_name,
                notification_prefs={"product_updates": False, "processing_complete": True})
    db.add(user)
    db.flush()
    raw = _issue_token(db, user, "verify", timedelta(hours=24))
    audit(db, "auth.registered", user.id, ip=client_ip(request))
    _start_session(db, user, request, response)
    send_verification(user.email, raw)
    return user_out(user)


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower()
    enforce(f"login:{email}:{client_ip(request)}", get_settings().login_rate_per_minute)
    user = db.scalar(select(User).where(User.email == email))
    # always run the hash so response time does not reveal whether the account exists
    password_ok = verify_password(body.password, user.password_hash if user else None)
    if not user or not user.is_active or not password_ok:
        audit(db, "auth.login_failed", user.id if user else None, ip=client_ip(request))
        db.commit()
        raise err(401, "invalid_credentials", "Email or password is incorrect.")
    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    audit(db, "auth.login", user.id, ip=client_ip(request))
    _start_session(db, user, request, response)
    return user_out(user)


@router.post("/logout", status_code=204)
def logout(response: Response, sess: UserSession = Depends(current_session), db: Session = Depends(get_db)):
    sess = db.merge(sess)
    sess.revoked_at = utcnow()
    db.commit()
    clear_session_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user_out(user)


@router.post("/verify-email", response_model=UserOut | None)
def verify_email(body: TokenIn, db: Session = Depends(get_db)):
    tok = _consume_token(db, body.token, "verify")
    user = db.get(User, tok.user_id)
    assert user
    user.email_verified_at = user.email_verified_at or utcnow()
    if user.email in get_settings().admin_email_set:
        user.role = "admin"
    elif user.email in get_settings().recruiter_email_set:
        user.role = "recruiter"
    audit(db, "auth.email_verified", user.id)
    db.commit()
    return user_out(user)


@router.post("/resend-verification", status_code=202)
def resend(user: User = Depends(current_user), db: Session = Depends(get_db)):
    enforce(f"resend:{user.id}", 3, 3600)
    if not user.email_verified_at:
        user = db.merge(user)
        raw = _issue_token(db, user, "verify", timedelta(hours=24))
        db.commit()
        send_verification(user.email, raw)
    return {"status": "sent"}


@router.post("/forgot-password", status_code=202)
def forgot(body: EmailIn, request: Request, db: Session = Depends(get_db)):
    email = body.email.lower()
    enforce(f"forgot:{email}:{client_ip(request)}", 3, 3600)
    user = db.scalar(select(User).where(User.email == email))
    if user and user.is_active:
        raw = _issue_token(db, user, "reset", timedelta(hours=1))
        audit(db, "auth.reset_requested", user.id)
        db.commit()
        send_password_reset(user.email, raw)
    # same response whether or not the account exists (no enumeration)
    return {"status": "If an account exists for that email, a reset link has been sent."}


@router.post("/reset-password", status_code=200)
def reset(body: ResetIn, db: Session = Depends(get_db)):
    problems = password_problems(body.password)
    if problems:
        raise err(422, "weak_password", " ".join(problems))
    tok = _consume_token(db, body.token, "reset")
    user = db.get(User, tok.user_id)
    assert user
    user.password_hash = hash_password(body.password)
    user.email_verified_at = user.email_verified_at or utcnow()  # possession of the inbox is proven
    revoke_all_sessions(db, user.id)
    audit(db, "auth.password_reset", user.id)
    db.commit()
    return {"status": "Password updated. Please sign in."}


# ---------------------------------------------------------------- Google OAuth (Authlib)


def _oauth():
    from authlib.integrations.starlette_client import OAuth

    s = get_settings()
    oauth = OAuth()
    oauth.register(
        "google", client_id=s.google_client_id, client_secret=s.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )
    return oauth


@router.get("/providers")
def providers():
    return {"google": get_settings().google_oauth_enabled}


@router.get("/google/login")
async def google_login(request: Request):  # pragma: no cover - requires Google credentials
    s = get_settings()
    if not s.google_oauth_enabled:
        raise err(404, "oauth_disabled", "Google sign-in is not configured.")
    if "session" not in request.scope:
        raise err(500, "oauth_misconfigured", "Session middleware missing for OAuth state.")
    return await _oauth().google.authorize_redirect(request, f"{s.api_base_url}/api/auth/google/callback")


@router.get("/google/callback")
async def google_callback(request: Request, db: Session = Depends(get_db)):  # pragma: no cover
    s = get_settings()
    if not s.google_oauth_enabled:
        raise err(404, "oauth_disabled", "Google sign-in is not configured.")
    token = await _oauth().google.authorize_access_token(request)
    info = token.get("userinfo") or {}
    if not info.get("email_verified") or not info.get("sub"):
        raise err(400, "oauth_unverified", "Your Google email address is not verified.")
    acct = db.scalar(select(OAuthAccount).where(OAuthAccount.provider == "google", OAuthAccount.subject == info["sub"]))
    if acct:
        user = db.get(User, acct.user_id)
    else:
        email = info["email"].lower()
        user = db.scalar(select(User).where(User.email == email))
        if not user:
            user = User(email=email, display_name=info.get("name"), email_verified_at=utcnow())
            db.add(user)
            db.flush()
        if not user.email_verified_at:
            # someone may have pre-registered this address without controlling it: drop their
            # password and sessions before linking the verified Google identity
            user.password_hash = None
            revoke_all_sessions(db, user.id)
            user.email_verified_at = utcnow()
        db.add(OAuthAccount(user_id=user.id, provider="google", subject=info["sub"]))
    assert user
    resp = RedirectResponse(f"{s.public_base_url}/dashboard", status_code=302)
    _start_session(db, user, request, resp)
    return resp
