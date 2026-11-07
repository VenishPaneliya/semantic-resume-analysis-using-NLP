from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_owned, verified_user
from app.db import get_db
from app.models import Application, JobDescription, ResumeVersion, User

router = APIRouter(prefix="/api/applications", tags=["applications"])

Status = Literal["saved", "applied", "interviewing", "offer", "rejected", "withdrawn"]
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class AppIn(BaseModel):
    company: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=200)
    status: Status = "saved"
    applied_on: str | None = None
    next_step_on: str | None = None
    location: str | None = Field(default=None, max_length=200)
    url: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=5000)
    resume_version_id: str | None = None
    jd_id: str | None = None

    @field_validator("applied_on", "next_step_on")
    @classmethod
    def _d(cls, v):
        if v in (None, ""):
            return None
        if not DATE.match(v):
            raise ValueError("use YYYY-MM-DD")
        return v

    @field_validator("url")
    @classmethod
    def _u(cls, v):
        if v and not re.match(r"^https?://", v, re.I):
            raise ValueError("URL must start with http(s)://")
        return v


class AppPatch(AppIn):
    company: str | None = Field(default=None, max_length=200)  # type: ignore[assignment]
    role: str | None = Field(default=None, max_length=200)  # type: ignore[assignment]
    status: Status | None = None  # type: ignore[assignment]


def out(a: Application) -> dict:
    return {c.name: (getattr(a, c.name).isoformat() if hasattr(getattr(a, c.name), "isoformat") else getattr(a, c.name))
            for c in a.__table__.columns if c.name != "user_id"}


def _check_refs(db: Session, user: User, body: AppIn | AppPatch) -> None:
    if body.resume_version_id:
        get_owned(db, ResumeVersion, body.resume_version_id, user)
    if body.jd_id:
        get_owned(db, JobDescription, body.jd_id, user)


@router.get("")
def list_apps(user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return [out(a) for a in db.scalars(select(Application).where(Application.user_id == user.id).order_by(Application.updated_at.desc()))]


@router.post("", status_code=201)
def create(body: AppIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    _check_refs(db, user, body)
    a = Application(user_id=user.id, **body.model_dump())
    db.add(a)
    db.commit()
    return out(a)


@router.patch("/{app_id}")
def update(app_id: str, body: AppPatch, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = get_owned(db, Application, app_id, user)
    _check_refs(db, user, body)
    for k, v in body.model_dump(exclude_unset=True).items():
        if k in ("company", "role", "status") and v is None:
            continue
        setattr(a, k, v)
    db.commit()
    return out(a)


@router.delete("/{app_id}", status_code=204)
def delete(app_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, Application, app_id, user))
    db.commit()
    return Response(status_code=204)
