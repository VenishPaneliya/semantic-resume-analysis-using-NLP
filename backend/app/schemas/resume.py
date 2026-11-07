"""Canonical structured resume content. Every list item carries a stable id so the editor,
AI suggestions and evidence references can target it precisely."""

from __future__ import annotations

import re
import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator

DATE_RE = re.compile(r"^\d{4}(-\d{2})?$")


def short_id() -> str:
    return uuid.uuid4().hex[:10]


def _clean_text(v: str | None, max_len: int) -> str | None:
    if v is None:
        return None
    v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", v).strip()
    return v[:max_len] if v else None


def _safe_url(v: str | None) -> str | None:
    if not v:
        return None
    v = v.strip()
    if re.match(r"^\s*(javascript|data|vbscript|file):", v, re.I):
        raise ValueError("unsafe link scheme")
    return v if re.match(r"^https?://", v, re.I) else "https://" + v.lstrip("/")


class Link(BaseModel):
    label: str = Field(default="", max_length=60)
    url: str = Field(max_length=500)

    @field_validator("url")
    @classmethod
    def _safe_scheme(cls, v: str) -> str:
        v = v.strip()
        if not re.match(r"^(https?://|mailto:)", v, re.I):
            v = "https://" + v.lstrip("/")
        if re.match(r"^(javascript|data|vbscript):", v, re.I):
            raise ValueError("unsafe link scheme")
        return v


class Contact(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=40)
    location: str | None = Field(default=None, max_length=120)
    links: list[Link] = Field(default_factory=list, max_length=10)


class Bullet(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    text: str = Field(max_length=800)

    @field_validator("text")
    @classmethod
    def _t(cls, v: str) -> str:
        return _clean_text(v, 800) or ""


def _coerce_bullets(v):
    """Accept plain strings as bullets (convenient for API clients and fixtures)."""
    if isinstance(v, list):
        return [{"text": x} if isinstance(x, str) else x for x in v]
    return v


class Experience(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    title: str | None = Field(default=None, max_length=160)
    organization: str | None = Field(default=None, max_length=160)
    location: str | None = Field(default=None, max_length=120)
    start: str | None = None
    end: str | None = None
    current: bool = False
    employment_type: Literal["full_time", "part_time", "internship", "contract", "freelance", "unknown"] = "unknown"
    bullets: list[Bullet] = Field(default_factory=list, max_length=40)

    _b = field_validator("bullets", mode="before")(lambda cls, v: _coerce_bullets(v))

    @field_validator("start", "end")
    @classmethod
    def _date(cls, v: str | None) -> str | None:
        if v in (None, ""):
            return None
        if not DATE_RE.match(v):
            raise ValueError("dates must be YYYY or YYYY-MM")
        return v


class Education(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    degree: str | None = Field(default=None, max_length=160)
    field_of_study: str | None = Field(default=None, max_length=160)
    institution: str | None = Field(default=None, max_length=200)
    location: str | None = Field(default=None, max_length=120)
    start: str | None = None
    end: str | None = None
    grade: str | None = Field(default=None, max_length=60)
    details: list[str] = Field(default_factory=list, max_length=20)

    _d = field_validator("start", "end")(Experience._date.__func__)  # type: ignore[attr-defined]


class Project(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    name: str = Field(max_length=160)
    url: str | None = Field(default=None, max_length=500)
    start: str | None = None
    end: str | None = None
    technologies: list[str] = Field(default_factory=list, max_length=40)
    bullets: list[Bullet] = Field(default_factory=list, max_length=30)

    _u = field_validator("url")(lambda cls, v: _safe_url(v))

    _b = field_validator("bullets", mode="before")(lambda cls, v: _coerce_bullets(v))

    _d = field_validator("start", "end")(Experience._date.__func__)  # type: ignore[attr-defined]


class Skills(BaseModel):
    technical: list[str] = Field(default_factory=list, max_length=150)
    soft: list[str] = Field(default_factory=list, max_length=50)
    other: list[str] = Field(default_factory=list, max_length=100)  # not in taxonomy; kept verbatim


class Certification(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    name: str = Field(max_length=200)
    issuer: str | None = Field(default=None, max_length=160)
    date: str | None = None
    url: str | None = Field(default=None, max_length=500)

    _u = field_validator("url")(lambda cls, v: _safe_url(v))


class SimpleItem(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    text: str = Field(max_length=600)


class LanguageItem(BaseModel):
    id: str = Field(default_factory=short_id, max_length=24)
    name: str = Field(max_length=60)
    proficiency: str | None = Field(default=None, max_length=60)


SECTION_KEYS = ["summary", "experience", "projects", "education", "skills", "certifications", "achievements", "languages"]


class ResumeContent(BaseModel):
    contact: Contact = Field(default_factory=Contact)
    summary: str | None = Field(default=None, max_length=3000)
    experience: list[Experience] = Field(default_factory=list, max_length=40)
    education: list[Education] = Field(default_factory=list, max_length=20)
    projects: list[Project] = Field(default_factory=list, max_length=30)
    skills: Skills = Field(default_factory=Skills)
    certifications: list[Certification] = Field(default_factory=list, max_length=40)
    achievements: list[SimpleItem] = Field(default_factory=list, max_length=40)
    languages: list[LanguageItem] = Field(default_factory=list, max_length=20)
    section_order: list[str] = Field(default_factory=lambda: list(SECTION_KEYS))

    @field_validator("section_order")
    @classmethod
    def _order(cls, v: list[str]) -> list[str]:
        seen = [k for k in dict.fromkeys(v) if k in SECTION_KEYS]
        return seen + [k for k in SECTION_KEYS if k not in seen]

    def all_bullets(self) -> list[tuple[str, str, str]]:
        """(path, owner label, text) for every bullet."""
        out = []
        for e in self.experience:
            for b in e.bullets:
                out.append((f"experience/{e.id}/bullets/{b.id}", f"{e.title or ''} @ {e.organization or ''}".strip(" @"), b.text))
        for p in self.projects:
            for b in p.bullets:
                out.append((f"projects/{p.id}/bullets/{b.id}", p.name, b.text))
        return out
