"""ORM models. Types are portable (SQLite for tests, PostgreSQL in production); JSON maps to
JSONB on PostgreSQL. Resume content, text derived from it (AI suggestions, cover letters, match
evidence) and other sensitive free text are encrypted at the application layer (EncryptedText /
EncryptedJSON); those columns are never filtered on in SQL."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from app.db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


def uid() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(UTC)


class EncryptedText(TypeDecorator):
    """Fernet-encrypted text column (encryption at rest independent of DB disk encryption)."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        from app.security.crypto import encrypt_str

        return encrypt_str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        from app.security.crypto import decrypt_str

        return decrypt_str(value)


class EncryptedJSON(TypeDecorator):
    """JSON value stored as Fernet-encrypted text. Use for resume content and anything derived
    from it that is only ever read whole by the application (never filtered on in SQL)."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        from app.security.crypto import encrypt_str

        return encrypt_str(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        from app.security.crypto import decrypt_str

        return json.loads(decrypt_str(value))


class TZDateTime(TypeDecorator):
    """Always returns timezone-aware UTC datetimes (SQLite drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, onupdate=utcnow, nullable=False)


# ---------------------------------------------------------------- identity


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16), default="user", nullable=False)  # user | recruiter | admin
    email_verified_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notification_prefs: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    career_prefs: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    ai_consent_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    ai_consent_provider: Mapped[str | None] = mapped_column(String(64))
    allow_training_use: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # two-factor authentication (TOTP, RFC 6238)
    totp_secret: Mapped[str | None] = mapped_column(EncryptedText)
    totp_enabled_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    recovery_code_hashes: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    totp_last_step: Mapped[int | None] = mapped_column(Integer)  # rejects reuse of an accepted code

    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")


class OAuthAccount(TimestampMixin, Base):
    __tablename__ = "oauth_accounts"
    __table_args__ = (UniqueConstraint("provider", "subject"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    subject: Mapped[str] = mapped_column(String(255))


class UserSession(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    user_agent: Mapped[str | None] = mapped_column(String(255))
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    user = relationship("User", back_populates="sessions")


class AuthToken(Base):
    """Single-use email verification / password reset tokens (hash only)."""

    __tablename__ = "auth_tokens"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(16))  # verify | reset
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime)
    used_at: Mapped[datetime | None] = mapped_column(TZDateTime)


# ---------------------------------------------------------------- resumes


class Resume(TimestampMixin, Base):
    __tablename__ = "resumes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    original_filename: Mapped[str] = mapped_column(String(255))
    file_key: Mapped[str] = mapped_column(String(512))
    file_kind: Mapped[str] = mapped_column(String(8))  # pdf | docx
    mime_type: Mapped[str] = mapped_column(String(128))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    page_count: Mapped[int | None] = mapped_column(Integer)
    # uploaded -> processing -> needs_review -> ready | failed
    status: Mapped[str] = mapped_column(String(24), default="uploaded")
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(String(500))
    retention_until: Mapped[datetime | None] = mapped_column(TZDateTime)
    # targeted variants share the original upload; the file is deleted when no resume references it
    source_resume_id: Mapped[str | None] = mapped_column(String(36), index=True)
    target_role: Mapped[str | None] = mapped_column(String(64))

    extraction = relationship("Extraction", uselist=False, back_populates="resume", cascade="all, delete-orphan")
    versions = relationship(
        "ResumeVersion", back_populates="resume", cascade="all, delete-orphan", order_by="ResumeVersion.number"
    )


class Extraction(TimestampMixin, Base):
    __tablename__ = "extractions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    resume_id: Mapped[str] = mapped_column(ForeignKey("resumes.id", ondelete="CASCADE"), unique=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    raw_text: Mapped[str] = mapped_column(EncryptedText)
    pages: Mapped[list] = mapped_column(JSONType, default=list)  # [{page, char_start, char_end}]
    fields: Mapped[dict] = mapped_column(EncryptedJSON, default=dict)  # structured content with evidence/confidence
    layout: Mapped[dict] = mapped_column(JSONType, default=dict)  # measured properties only
    warnings: Mapped[list] = mapped_column(JSONType, default=list)
    ocr_used: Mapped[bool] = mapped_column(Boolean, default=False)
    parser_version: Mapped[str] = mapped_column(String(32))
    extractor_version: Mapped[str] = mapped_column(String(32))

    resume = relationship("Resume", back_populates="extraction")


class ResumeVersion(Base):
    __tablename__ = "resume_versions"
    __table_args__ = (UniqueConstraint("resume_id", "number"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    resume_id: Mapped[str] = mapped_column(ForeignKey("resumes.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    parent_id: Mapped[str | None] = mapped_column(String(36))
    label: Mapped[str | None] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(16))  # extracted | user_edit | ai_accepted | restore
    content: Mapped[dict] = mapped_column(EncryptedJSON)
    content_hash: Mapped[str] = mapped_column(String(64))
    target_role: Mapped[str | None] = mapped_column(String(64))
    target_jd_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)

    resume = relationship("Resume", back_populates="versions")


# ---------------------------------------------------------------- jobs


class ProcessingJob(TimestampMixin, Base):
    __tablename__ = "processing_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # parse_resume | export | analysis
    target_id: Mapped[str] = mapped_column(String(36), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|succeeded|failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    stage: Mapped[str | None] = mapped_column(String(64))
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(String(500))
    started_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    finished_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    lease_expires_at: Mapped[datetime | None] = mapped_column(TZDateTime)


# ---------------------------------------------------------------- derived results


class Analysis(Base):
    __tablename__ = "analyses"
    __table_args__ = (Index("ix_analysis_cache", "version_id", "cache_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    cache_key: Mapped[str] = mapped_column(String(64))
    target_role: Mapped[str | None] = mapped_column(String(64))
    rubric_version: Mapped[str] = mapped_column(String(32))
    taxonomy_version: Mapped[str] = mapped_column(String(80))
    result: Mapped[dict] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


class RoleRecommendation(Base):
    __tablename__ = "role_recommendations"
    __table_args__ = (Index("ix_rec_cache", "version_id", "cache_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    cache_key: Mapped[str] = mapped_column(String(64))
    preferences: Mapped[dict] = mapped_column(JSONType, default=dict)
    recommender_version: Mapped[str] = mapped_column(String(48))
    embedding_model: Mapped[str] = mapped_column(String(128))
    taxonomy_version: Mapped[str] = mapped_column(String(80))
    result: Mapped[dict] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


class JobDescription(TimestampMixin, Base):
    __tablename__ = "job_descriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    company: Mapped[str | None] = mapped_column(String(200))
    raw_text: Mapped[str] = mapped_column(EncryptedText)
    extracted: Mapped[dict] = mapped_column(JSONType, default=dict)
    source: Mapped[str] = mapped_column(String(16), default="paste")  # paste | upload


class JDMatch(Base):
    __tablename__ = "jd_matches"
    __table_args__ = (Index("ix_jdmatch_cache", "version_id", "jd_id", "cache_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    jd_id: Mapped[str] = mapped_column(ForeignKey("job_descriptions.id", ondelete="CASCADE"), index=True)
    cache_key: Mapped[str] = mapped_column(String(64))
    matcher_version: Mapped[str] = mapped_column(String(32))
    embedding_model: Mapped[str] = mapped_column(String(128))
    result: Mapped[dict] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


class AISuggestion(TimestampMixin, Base):
    __tablename__ = "ai_suggestions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    operation: Mapped[str] = mapped_column(String(32))
    target_path: Mapped[str] = mapped_column(String(200))  # e.g. experience/<id>/bullets/<id>
    before_text: Mapped[str] = mapped_column(EncryptedText)
    after_text: Mapped[str] = mapped_column(EncryptedText)
    explanation: Mapped[str] = mapped_column(EncryptedText)
    questions: Mapped[list] = mapped_column(EncryptedJSON, default=list)
    placeholders: Mapped[list] = mapped_column(EncryptedJSON, default=list)
    grounding: Mapped[dict] = mapped_column(EncryptedJSON, default=dict)
    # pending | needs_facts | accepted | rejected | superseded
    status: Mapped[str] = mapped_column(String(16), default="pending")
    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(64))
    prompt_version: Mapped[str] = mapped_column(String(32))
    applied_version_id: Mapped[str | None] = mapped_column(String(36))
    items: Mapped[list] = mapped_column(EncryptedJSON, default=list)  # [{target_id, before, after, diff, grounding}]
    params: Mapped[dict] = mapped_column(JSONType, default=dict)
    cache_key: Mapped[str | None] = mapped_column(String(64), index=True)


class Export(TimestampMixin, Base):
    __tablename__ = "exports"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    format: Mapped[str] = mapped_column(String(8))  # pdf | docx
    template: Mapped[str] = mapped_column(String(32))
    page_size: Mapped[str] = mapped_column(String(8))  # A4 | LETTER
    status: Mapped[str] = mapped_column(String(16), default="queued")
    file_key: Mapped[str | None] = mapped_column(String(512))
    content_hash: Mapped[str] = mapped_column(String(64))
    unresolved_placeholders: Mapped[list] = mapped_column(JSONType, default=list)
    page_count: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(String(500))


class CareerArtifact(TimestampMixin, Base):
    """Generated career material: cover letters, interview question sets, roadmaps."""

    __tablename__ = "career_artifacts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str | None] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    jd_id: Mapped[str | None] = mapped_column(ForeignKey("job_descriptions.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(32))  # cover_letter | interview_questions | roadmap
    content: Mapped[dict] = mapped_column(EncryptedJSON)
    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(64))


class Application(TimestampMixin, Base):
    __tablename__ = "applications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    company: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(200))
    # saved | applied | interviewing | offer | rejected | withdrawn
    status: Mapped[str] = mapped_column(String(16), default="saved")
    applied_on: Mapped[str | None] = mapped_column(String(10))
    next_step_on: Mapped[str | None] = mapped_column(String(10))
    location: Mapped[str | None] = mapped_column(String(200))
    url: Mapped[str | None] = mapped_column(String(1000))
    notes: Mapped[str | None] = mapped_column(Text)
    resume_version_id: Mapped[str | None] = mapped_column(ForeignKey("resume_versions.id", ondelete="SET NULL"))
    jd_id: Mapped[str | None] = mapped_column(ForeignKey("job_descriptions.id", ondelete="SET NULL"))


# ---------------------------------------------------------------- job openings (posted by HR staff)


class JobOpening(TimestampMixin, Base):
    """A real vacancy posted by a recruiter. Visible to all verified candidates while open."""

    __tablename__ = "job_openings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    posted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    company: Mapped[str] = mapped_column(String(200))
    location: Mapped[str | None] = mapped_column(String(200))
    work_arrangement: Mapped[str | None] = mapped_column(String(16))  # onsite | hybrid | remote
    employment_type: Mapped[str | None] = mapped_column(String(16))  # full_time | part_time | contract | internship
    description: Mapped[str] = mapped_column(Text)
    extracted: Mapped[dict] = mapped_column(JSONType, default=dict)
    role_id: Mapped[str | None] = mapped_column(String(64))  # closest taxonomy role, for grouping
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open | closed
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class OpeningApplication(TimestampMixin, Base):
    """A candidate in an opening's pipeline.

    source=applied  — a registered candidate applied with one of their resume versions (user_id,
                      version_id set). Counts toward "where I stand".
    source=uploaded — a recruiter bulk-uploaded the resume after attesting the person agreed to be
                      considered. No account; extracted content is stored encrypted and the row is
                      deleted at expires_at (default 90 days). Never counts toward candidates' standing.
    Scores are recomputed when the candidate re-applies or the recruiter edits the opening."""

    __tablename__ = "opening_applications"
    __table_args__ = (UniqueConstraint("opening_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    opening_id: Mapped[str] = mapped_column(ForeignKey("job_openings.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str | None] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(16), default="applied", nullable=False)  # applied | uploaded
    candidate_name: Mapped[str | None] = mapped_column(EncryptedText)
    candidate_email: Mapped[str | None] = mapped_column(EncryptedText)
    content_enc: Mapped[str | None] = mapped_column(EncryptedText)  # JSON resume content for uploaded rows
    original_filename: Mapped[str | None] = mapped_column(String(255))
    uploaded_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    consent_attested_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    expires_at: Mapped[datetime | None] = mapped_column(TZDateTime, index=True)
    score: Mapped[float] = mapped_column(Float)
    result: Mapped[dict] = mapped_column(EncryptedJSON, default=dict)  # match details with evidence from the resume
    matcher_version: Mapped[str] = mapped_column(String(32))
    # submitted | shortlisted | interview | offer | hired | rejected  (set by recruiter)
    stage: Mapped[str] = mapped_column(String(16), default="submitted")
    stage_changed_at: Mapped[datetime | None] = mapped_column(TZDateTime)


class ApplicationNote(Base):
    """Private recruiter note on a candidate. Never shown to the candidate."""

    __tablename__ = "application_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    application_id: Mapped[str] = mapped_column(ForeignKey("opening_applications.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    text: Mapped[str] = mapped_column(EncryptedText)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


# ---------------------------------------------------------------- candidate engagement


class JobAlertSent(Base):
    """Dedupe record: one alert per user per opening."""

    __tablename__ = "job_alerts_sent"
    __table_args__ = (UniqueConstraint("user_id", "opening_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    opening_id: Mapped[str] = mapped_column(ForeignKey("job_openings.id", ondelete="CASCADE"), index=True)
    score: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


class LearningItem(TimestampMixin, Base):
    """A skill on the user's learning plan."""

    __tablename__ = "learning_items"
    __table_args__ = (UniqueConstraint("user_id", "skill"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    skill: Mapped[str] = mapped_column(String(80))
    target_kind: Mapped[str | None] = mapped_column(String(16))  # role | opening
    target_id: Mapped[str | None] = mapped_column(String(64))
    target_title: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default="todo")  # todo | learning | done
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime)


class InterviewSession(TimestampMixin, Base):
    """Mock interview practice. Answers are personal free text and stored encrypted."""

    __tablename__ = "interview_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("resume_versions.id", ondelete="CASCADE"), index=True)
    target_kind: Mapped[str | None] = mapped_column(String(16))
    target_id: Mapped[str | None] = mapped_column(String(64))
    target_title: Mapped[str | None] = mapped_column(String(200))
    questions: Mapped[list] = mapped_column(JSONType, default=list)
    questions_source: Mapped[str] = mapped_column(String(32))  # provider name or "template"
    answers_enc: Mapped[str | None] = mapped_column(EncryptedText)  # JSON {question_id: {answer, feedback, at}}


class DemographicSelfId(TimestampMixin, Base):
    """Voluntary self-identification used ONLY for aggregate fairness monitoring.

    Never read by ranking, matching, tips or recruiter candidate views. Values are encrypted;
    reports only show groups with at least FAIRNESS_MIN_GROUP people. Deleting it is one click."""

    __tablename__ = "demographic_self_ids"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
    gender: Mapped[str | None] = mapped_column(EncryptedText)
    age_band: Mapped[str | None] = mapped_column(EncryptedText)
    consented_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


# ---------------------------------------------------------------- ops


class UsageEvent(Base):
    __tablename__ = "usage_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # llm | upload | export
    operation: Mapped[str | None] = mapped_column(String(48))
    provider: Mapped[str | None] = mapped_column(String(32))
    model: Mapped[str | None] = mapped_column(String(64))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, index=True)


class AuditLog(Base):
    """Minimal audit trail. Never stores resume or JD content."""

    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)  # not FK: survives deletion
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str | None] = mapped_column(String(32))
    target_id: Mapped[str | None] = mapped_column(String(36))
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    meta: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, index=True)
