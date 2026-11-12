"""Account: two-factor authentication setup, and voluntary demographic self-identification."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import check_second_factor
from app.api.deps import current_session, current_user, err
from app.db import get_db
from app.models import DemographicSelfId, User, UserSession, utcnow
from app.security import totp
from app.security.crypto import keyed_hash
from app.security.passwords import verify_password
from app.security.ratelimit import enforce
from app.security.sessions import revoke_all_sessions
from app.services.audit import audit

router = APIRouter(prefix="/api/account", tags=["account"])


# ---------------------------------------------------------------- two-factor authentication


@router.get("/2fa")
def mfa_status(user: User = Depends(current_user)):
    return {"enabled": bool(user.totp_enabled_at), "enabled_at": user.totp_enabled_at.isoformat() if user.totp_enabled_at else None,
            "recovery_codes_left": len(user.recovery_code_hashes or [])}


@router.post("/2fa/setup")
def mfa_setup(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Start setup: a new secret that only becomes active after a correct code is confirmed."""
    user = db.merge(user)
    if user.totp_enabled_at:
        raise err(409, "already_enabled", "Two-factor authentication is already on. Turn it off first to reset it.")
    user.totp_secret = totp.new_secret()
    user.totp_last_step = None
    db.commit()
    return {"secret": user.totp_secret, "otpauth_uri": totp.provisioning_uri(user.totp_secret, user.email),
            "instructions": "Scan the QR code (or type the key) in an authenticator app, then enter the 6-digit code it shows."}


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=32)


@router.post("/2fa/enable")
def mfa_enable(body: CodeIn, user: User = Depends(current_user), sess: UserSession = Depends(current_session),
               db: Session = Depends(get_db)):
    enforce(f"mfa-enable:{user.id}", 10)
    user = db.merge(user)
    if user.totp_enabled_at:
        raise err(409, "already_enabled", "Two-factor authentication is already on.")
    if not user.totp_secret:
        raise err(409, "not_started", "Start setup first.")
    step = totp.verify(user.totp_secret, body.code)
    if step is None:
        raise err(400, "invalid_code", "That code didn't match. Check the time on your phone and try the current code.")
    codes = totp.new_recovery_codes()
    user.totp_enabled_at, user.totp_last_step = utcnow(), step
    user.recovery_code_hashes = [keyed_hash(c) for c in codes]
    # like a password change: sessions that signed in with the password alone are signed out
    revoke_all_sessions(db, user.id, except_id=sess.id)
    audit(db, "account.mfa_enabled", user.id)
    db.commit()
    return {"enabled": True, "recovery_codes": codes, "other_sessions_signed_out": True,
            "note": "Save these recovery codes somewhere safe. Each works once if you lose your phone. They won't be shown again."}


class DisableIn(BaseModel):
    password: str | None = Field(default=None, max_length=256)
    code: str = Field(min_length=6, max_length=32)


@router.post("/2fa/disable")
def mfa_disable(body: DisableIn, user: User = Depends(current_user), sess: UserSession = Depends(current_session),
                db: Session = Depends(get_db)):
    enforce(f"mfa-disable:{user.id}", 5)
    user = db.merge(user)
    if not user.totp_enabled_at:
        raise err(409, "not_enabled", "Two-factor authentication is not on.")
    if user.password_hash and not verify_password(body.password or "", user.password_hash):
        raise err(400, "invalid_credentials", "Password is incorrect.")
    if not check_second_factor(db, user, body.code):
        raise err(400, "invalid_code", "That code didn't work.")
    user.totp_secret = None
    user.totp_enabled_at = user.totp_last_step = None
    user.recovery_code_hashes = []
    revoke_all_sessions(db, user.id, except_id=sess.id)
    audit(db, "account.mfa_disabled", user.id)
    db.commit()
    return {"enabled": False, "other_sessions_signed_out": True}


@router.post("/2fa/recovery-codes")
def mfa_new_codes(body: CodeIn, user: User = Depends(current_user), sess: UserSession = Depends(current_session),
                  db: Session = Depends(get_db)):
    enforce(f"mfa-codes:{user.id}", 5)
    user = db.merge(user)
    if not user.totp_enabled_at:
        raise err(409, "not_enabled", "Two-factor authentication is not on.")
    if check_second_factor(db, user, body.code) != "totp":
        raise err(400, "invalid_code", "Enter a current code from your authenticator app.")
    codes = totp.new_recovery_codes()
    user.recovery_code_hashes = [keyed_hash(c) for c in codes]
    # new codes are usually made because old ones may be exposed: sign out everywhere else too
    revoke_all_sessions(db, user.id, except_id=sess.id)
    audit(db, "account.mfa_codes_regenerated", user.id)
    db.commit()
    return {"recovery_codes": codes, "other_sessions_signed_out": True}


# ---------------------------------------------------------------- voluntary self-identification

GENDERS = ("woman", "man", "non_binary", "self_describe", "prefer_not")
AGE_BANDS = ("under_25", "25_34", "35_44", "45_54", "55_plus", "prefer_not")


class SelfIdIn(BaseModel):
    gender: Literal["woman", "man", "non_binary", "self_describe", "prefer_not"] | None = None
    age_band: Literal["under_25", "25_34", "35_44", "45_54", "55_plus", "prefer_not"] | None = None
    consent: bool = Field(description="I agree this is used only for anonymous, aggregate fairness checks.")


SELF_ID_NOTICE = ("Optional. Used only to check, in anonymous totals of at least 10 people, whether our rankings treat groups "
                  "differently. It is never used to rank, match or score you, never shown to recruiters as yours, stored "
                  "encrypted, and you can delete it at any time.")


@router.get("/self-id")
def get_self_id(user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.scalar(select(DemographicSelfId).where(DemographicSelfId.user_id == user.id))
    return {"notice": SELF_ID_NOTICE, "options": {"gender": GENDERS, "age_band": AGE_BANDS},
            "value": None if not row else {"gender": row.gender, "age_band": row.age_band, "consented_at": row.consented_at.isoformat()}}


@router.put("/self-id")
def put_self_id(body: SelfIdIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not body.consent:
        raise err(422, "consent_required", "Tick the consent box to share this, or simply skip it.")
    row = db.scalar(select(DemographicSelfId).where(DemographicSelfId.user_id == user.id))
    if not row:
        row = DemographicSelfId(user_id=user.id)
        db.add(row)
    row.gender, row.age_band, row.consented_at = body.gender, body.age_band, utcnow()
    db.commit()
    return get_self_id(user, db)


@router.delete("/self-id", status_code=204)
def delete_self_id(user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.scalar(select(DemographicSelfId).where(DemographicSelfId.user_id == user.id))
    if row:
        db.delete(row)
        db.commit()
    return Response(status_code=204)
