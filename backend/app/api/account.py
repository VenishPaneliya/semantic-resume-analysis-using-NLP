from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.auth import UserOut, user_out
from app.api.deps import client_ip, current_session, current_user, err, get_owned
from app.config import get_settings
from app.db import get_db
from app.models import Resume, UsageEvent, User, UserSession, utcnow
from app.security.passwords import hash_password, password_problems, verify_password
from app.security.ratelimit import enforce
from app.security.sessions import clear_session_cookies, revoke_all_sessions
from app.services.account import delete_account, export_user_data
from app.services.audit import audit
from app.services.llm.providers import get_provider
from app.services.taxonomy import get_taxonomy

router = APIRouter(prefix="/api/account", tags=["account"])


class CareerPrefs(BaseModel):
    target_roles: list[str] = Field(default_factory=list, max_length=10)
    domains: list[str] = Field(default_factory=list, max_length=10)
    locations: list[str] = Field(default_factory=list, max_length=10)
    work_arrangements: list[Literal["remote", "hybrid", "onsite"]] = Field(default_factory=list)


class JobAlertsIn(BaseModel):
    enabled: bool
    min_score: int = Field(default=60, ge=40, le=95)
    resume_id: str | None = Field(default=None, max_length=36)


class SettingsIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    notification_prefs: dict[str, bool] | None = None
    career_prefs: CareerPrefs | None = None
    job_alerts: JobAlertsIn | None = None


class ConsentIn(BaseModel):
    provider: str = Field(max_length=32)
    accept: bool


class PasswordIn(BaseModel):
    current_password: str | None = Field(default=None, max_length=256)
    new_password: str = Field(max_length=256)


class DeleteIn(BaseModel):
    confirm_email: str = Field(max_length=320)
    password: str | None = Field(default=None, max_length=256)


@router.patch("/settings", response_model=UserOut)
def update_settings(body: SettingsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    if body.display_name is not None:
        user.display_name = body.display_name.strip() or None
    if body.notification_prefs is not None:
        allowed = {"product_updates", "processing_complete", "weekly_digest"}
        kept = {k: v for k, v in (user.notification_prefs or {}).items() if k.startswith("job_alert")}
        user.notification_prefs = {**kept, **{k: bool(v) for k, v in body.notification_prefs.items() if k in allowed}}
    if body.job_alerts is not None:
        ja = body.job_alerts
        if ja.resume_id:
            get_owned(db, Resume, ja.resume_id, user)
        user.notification_prefs = {**(user.notification_prefs or {}), "job_alerts": ja.enabled,
                                   "job_alert_min_score": ja.min_score, "job_alert_resume_id": ja.resume_id}
    if body.career_prefs is not None:
        roles = get_taxonomy().roles
        prefs = body.career_prefs.model_dump()
        prefs["target_roles"] = [r for r in prefs["target_roles"] if r in roles]
        prefs["domains"] = [d.strip().lower()[:40] for d in prefs["domains"] if d.strip()]
        prefs["locations"] = [loc.strip()[:80] for loc in prefs["locations"] if loc.strip()]
        user.career_prefs = prefs
    db.commit()
    return user_out(user)


@router.get("/privacy")
def privacy(user: User = Depends(current_user)):
    s = get_settings()
    p = get_provider()
    return {
        "ai_provider": p.name,
        "ai_model": p.model,
        "sends_data_externally": p.sends_data_externally,
        "consented": bool(user.ai_consent_at and user.ai_consent_provider == p.name),
        "consented_at": user.ai_consent_at.isoformat() if user.ai_consent_at else None,
        "what_is_sent": (
            "Only the resume sections needed for the requested edit (and the job description, when tailoring). "
            "Your name, email, phone, location and links are removed before sending."
        ) if p.sends_data_externally else "Nothing leaves this server: the current AI provider is a local development fixture or disabled.",
        "training_use": "Your uploads are not used for model training." if not user.allow_training_use else "You opted in to anonymised evaluation use.",
        "retention_days": {"files": s.file_retention_days, "analyses": s.analysis_retention_days},
        "fixture_notice": "Development fixture — not live AI." if p.name == "fixture" else None,
    }


@router.post("/ai-consent", response_model=UserOut)
def ai_consent(body: ConsentIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    if body.accept:
        if body.provider != get_provider().name:
            raise err(409, "provider_changed", "The AI provider changed. Please review the current disclosure.")
        user.ai_consent_at, user.ai_consent_provider = utcnow(), body.provider
    else:
        user.ai_consent_at, user.ai_consent_provider = None, None
    audit(db, "account.ai_consent", user.id, ip=client_ip(request), status="granted" if body.accept else "revoked", provider=body.provider)
    db.commit()
    return user_out(user)


@router.post("/password", status_code=200)
def change_password(body: PasswordIn, sess: UserSession = Depends(current_session), db: Session = Depends(get_db)):
    user = db.get(User, sess.user_id)
    assert user
    if user.password_hash and not verify_password(body.current_password or "", user.password_hash):
        raise err(400, "invalid_credentials", "Current password is incorrect.")
    problems = password_problems(body.new_password)
    if problems:
        raise err(422, "weak_password", " ".join(problems))
    user.password_hash = hash_password(body.new_password)
    revoke_all_sessions(db, user.id, except_id=sess.id)
    from app.models import AuthToken

    for t in db.scalars(select(AuthToken).where(AuthToken.user_id == user.id, AuthToken.purpose == "reset",
                                                AuthToken.used_at.is_(None))):
        t.used_at = utcnow()
    audit(db, "account.password_changed", user.id)
    db.commit()
    return {"status": "Password updated. Other sessions were signed out."}


@router.get("/sessions")
def sessions(sess: UserSession = Depends(current_session), db: Session = Depends(get_db)):
    rows = db.scalars(select(UserSession).where(UserSession.user_id == sess.user_id, UserSession.revoked_at.is_(None),
                                                UserSession.expires_at > utcnow()))
    return [{"id": r.id, "created_at": r.created_at, "last_seen_at": r.last_seen_at, "user_agent": r.user_agent, "current": r.id == sess.id} for r in rows]


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_session(session_id: str, sess: UserSession = Depends(current_session), db: Session = Depends(get_db)):
    r = db.get(UserSession, session_id)
    if not r or r.user_id != sess.user_id:
        raise err(404, "not_found", "Session not found.")
    r.revoked_at = utcnow()
    db.commit()
    return Response(status_code=204)


@router.get("/usage")
def usage(user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_settings()
    month = utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    q = select(func.count(UsageEvent.id), func.coalesce(func.sum(UsageEvent.cost_usd), 0.0)).where(
        UsageEvent.user_id == user.id, UsageEvent.kind == "llm", UsageEvent.created_at >= month)
    n, cost = db.execute(q).one()
    return {"ai_requests_this_month": n, "estimated_cost_usd": round(float(cost), 4), "limits": {
        "ai_requests_per_day": s.ai_requests_per_day, "ai_monthly_cost_limit_usd": s.ai_monthly_cost_limit_usd,
        "uploads_per_day": s.uploads_per_day}}


@router.get("/export")
def export_data(user: User = Depends(current_user), db: Session = Depends(get_db)):
    enforce(f"export-data:{user.id}", 3, 3600)
    data = export_user_data(db, db.merge(user))
    return Response(data, media_type="application/zip", headers={"content-disposition": 'attachment; filename="my-data.zip"'})


@router.post("/delete", status_code=200)
def delete(body: DeleteIn, request: Request, response: Response, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    if body.confirm_email.strip().lower() != user.email:
        raise err(400, "confirmation_mismatch", "Type your account email to confirm deletion.")
    if user.password_hash and not verify_password(body.password or "", user.password_hash):
        raise err(400, "invalid_credentials", "Password is incorrect.")
    counts = delete_account(db, user, ip=client_ip(request))
    clear_session_cookies(response)
    return {"status": "deleted", **counts}
