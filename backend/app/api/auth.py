from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import client_ip, current_session, current_user, err
from app.config import get_settings
from app.db import get_db
from app.models import AuthToken, OAuthAccount, User, UserSession, utcnow
from app.security.crypto import keyed_hash_candidates, sha256_hex
from app.security.passwords import hash_password, needs_rehash, password_problems, verify_password
from app.security.ratelimit import check_failures, enforce, record_failure
from app.security.sessions import (
    clear_session_cookies,
    create_session,
    revoke_all_sessions,
    set_session_cookies,
)
from app.services.audit import audit
from app.services.email import send_existing_account_notice, send_password_reset, send_verification

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
    mfa_enabled: bool = False
    mfa_required_for_role: bool = False


def user_out(u: User) -> UserOut:
    return UserOut(id=u.id, email=u.email, display_name=u.display_name, role=u.role, email_verified=bool(u.email_verified_at),
                   ai_consent_provider=u.ai_consent_provider if u.ai_consent_at else None, has_password=bool(u.password_hash),
                   notification_prefs=u.notification_prefs or {}, career_prefs=u.career_prefs or {},
                   mfa_enabled=bool(u.totp_enabled_at),
                   mfa_required_for_role=u.role in ("recruiter", "admin") and get_settings().require_mfa_for_staff)


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


REGISTER_MESSAGE = ("Check your email. If this address can be used for a new account, we sent a link to verify it; "
                    "if it already has an account, we sent instructions to sign in or reset your password.")


class RegisterOut(BaseModel):
    status: str = "verification_sent"
    message: str = REGISTER_MESSAGE


@router.post("/register", status_code=201, response_model=RegisterOut)
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)):
    """Create an account and email a verification link.

    The response is the same whether or not the address already has an account, and no session is
    started, so the endpoint cannot be used to find out who is registered. The owner of an existing
    account gets an email instead ("someone tried to register with your address"). Sign in after
    verifying."""
    problems = password_problems(body.password)
    if problems:
        raise err(422, "weak_password", " ".join(problems))
    email = body.email.lower()
    # caps the emails one address can receive from this form, whatever the client IP
    enforce(f"register-email:{email}", 3, 3600)
    password_hash = hash_password(body.password)  # hashed in both branches so timing matches
    existing = db.scalar(select(User).where(User.email == email))
    if existing:
        audit(db, "auth.register_existing", existing.id, ip=client_ip(request))
        db.commit()
        send_existing_account_notice(existing.email)
        return RegisterOut()
    user = User(email=email, password_hash=password_hash, display_name=body.display_name,
                notification_prefs={"product_updates": False, "processing_complete": True})
    db.add(user)
    try:
        db.flush()
    except IntegrityError:  # registered by a concurrent request: answer exactly as for an existing account
        db.rollback()
        return RegisterOut()
    raw = _issue_token(db, user, "verify", timedelta(hours=24))
    audit(db, "auth.registered", user.id, ip=client_ip(request))
    db.commit()
    send_verification(user.email, raw)
    return RegisterOut()


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower()
    enforce(f"login:{email}:{client_ip(request)}", get_settings().login_rate_per_minute)
    check_failures(f"login-fail:{email}", get_settings().login_failures_per_account, LOGIN_FAIL_WINDOW)
    user = db.scalar(select(User).where(User.email == email))
    # always run the hash so response time does not reveal whether the account exists
    password_ok = verify_password(body.password, user.password_hash if user else None)
    if not user or not user.is_active or not password_ok:
        record_failure(f"login-fail:{email}", LOGIN_FAIL_WINDOW)
        audit(db, "auth.login_failed", user.id if user else None, ip=client_ip(request))
        db.commit()
        raise err(401, "invalid_credentials", "Email or password is incorrect.")
    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    if user.totp_enabled_at:
        # second step required: hand back a short-lived single-use token instead of a session
        tok = _issue_token(db, user, "mfa", MFA_TOKEN_TTL)
        audit(db, "auth.login_mfa_pending", user.id, ip=client_ip(request))
        db.commit()
        return JSONResponse({"mfa_required": True, "mfa_token": tok})
    audit(db, "auth.login", user.id, ip=client_ip(request))
    _start_session(db, user, request, response)
    return user_out(user)


class MfaLoginIn(BaseModel):
    # omitted after Google sign-in: the token is then in the HttpOnly MFA_COOKIE, never in a URL
    mfa_token: str | None = Field(default=None, max_length=128)
    code: str = Field(min_length=6, max_length=32, description="6-digit authenticator code or a recovery code")


MFA_COOKIE = "ri_mfa"
MFA_COOKIE_PATH = "/api/auth/login/mfa"
MFA_TOKEN_TTL = timedelta(minutes=5)
LOGIN_FAIL_WINDOW = 15 * 60
SECOND_FACTOR_FAIL_WINDOW = 60 * 60
MFA_TOKEN_MAX_FAILURES = 5


def check_second_factor(db: Session, user: User, code: str) -> str | None:
    """Accept a fresh TOTP code or an unused recovery code. Returns the method used, or None.

    Failures are counted per account across every place a code is entered; after
    `second_factor_failures_per_account` in an hour, further attempts are refused (429) so the
    6-digit code space can't be worked through slowly.
    """
    key = f"2fa-fail:{user.id}"
    check_failures(key, get_settings().second_factor_failures_per_account, SECOND_FACTOR_FAIL_WINDOW)
    method = _match_second_factor(user, code)
    if method is None:
        record_failure(key, SECOND_FACTOR_FAIL_WINDOW)
    return method


def _match_second_factor(user: User, code: str) -> str | None:
    from app.security import totp

    if user.totp_secret:
        step = totp.verify(user.totp_secret, code)
        if step is not None and (user.totp_last_step is None or step > user.totp_last_step):
            user.totp_last_step = step
            return "totp"
    stored = user.recovery_code_hashes or []
    h = next((c for c in keyed_hash_candidates(code.strip().lower()) if c in stored), None)
    if h is not None:
        user.recovery_code_hashes = [x for x in stored if x != h]
        return "recovery_code"
    return None


@router.post("/login/mfa")
def login_mfa(body: MfaLoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    enforce(f"mfa:{client_ip(request)}", get_settings().login_rate_per_minute)
    raw = body.mfa_token or request.cookies.get(MFA_COOKIE) or ""
    tok = db.scalar(select(AuthToken).where(AuthToken.token_hash == sha256_hex(raw), AuthToken.purpose == "mfa")) if raw else None
    if not tok or tok.used_at is not None or tok.expires_at <= utcnow():
        raise err(400, "invalid_token", "Your sign-in expired. Enter your email and password again.")
    user = db.get(User, tok.user_id)
    assert user
    enforce(f"mfa-user:{user.id}", 5)
    method = check_second_factor(db, user, body.code)
    if not method:
        audit(db, "auth.mfa_failed", user.id, ip=client_ip(request))
        # a sign-in attempt gets a few tries, then the password must be entered again
        if record_failure(f"mfa-token:{tok.id}", 300) >= MFA_TOKEN_MAX_FAILURES:
            tok.used_at = utcnow()
        db.commit()
        raise err(401, "invalid_code", "That code didn't work. Check your authenticator app's current code.")
    tok.used_at = utcnow()
    audit(db, "auth.login", user.id, ip=client_ip(request), mfa=method)
    _start_session(db, user, request, response)
    _clear_mfa_cookie(response)
    out = user_out(user).model_dump()
    if method == "recovery_code":
        out["recovery_codes_left"] = len(user.recovery_code_hashes)
    return out  # returned as a plain dict so the session cookies set on `response` are kept


def set_mfa_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(MFA_COOKIE, token, max_age=int(MFA_TOKEN_TTL.total_seconds()), httponly=True, secure=s.cookie_secure,
                        samesite="lax", domain=s.cookie_domain, path=MFA_COOKIE_PATH)


def _clear_mfa_cookie(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(MFA_COOKIE, domain=s.cookie_domain, path=MFA_COOKIE_PATH)


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
    enforce(f"forgot-email:{email}", 5, 3600)  # cap reset emails per address, whatever the client IP
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
    if user.totp_enabled_at:
        # the second-step token goes in a short-lived HttpOnly cookie scoped to the MFA endpoint, not
        # the URL, so it never reaches browser history, logs or Referer headers
        tok = _issue_token(db, user, "mfa", MFA_TOKEN_TTL)
        db.commit()
        resp = RedirectResponse(f"{s.public_base_url}/login?mfa=google", status_code=302)
        set_mfa_cookie(resp, tok)
        return resp
    resp = RedirectResponse(f"{s.public_base_url}/dashboard", status_code=302)
    _start_session(db, user, request, resp)
    return resp
