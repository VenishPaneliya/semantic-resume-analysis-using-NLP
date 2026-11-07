"""Environment-based configuration. Every external credential is optional; absent
credentials select clearly-labelled development fallbacks, never silent fakes."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    app_name: str = "Resume Intelligence"
    public_base_url: str = "http://localhost:3000"
    api_base_url: str = "http://localhost:8000"

    # --- security ---
    secret_key: str = "dev-insecure-change-me"  # noqa: S105 - dev default; production validator rejects it
    # urlsafe base64 32-byte Fernet key(s), comma separated; first is used for encryption,
    # all are tried for decryption (key rotation).
    encryption_keys: str = ""
    session_cookie_name: str = "ri_session"
    csrf_cookie_name: str = "ri_csrf"
    session_ttl_hours: int = 24 * 7
    cookie_secure: bool = False
    cookie_domain: str | None = None
    cors_origins: str = "http://localhost:3000"
    trusted_proxies: int = 0

    # --- database / queue ---
    database_url: str = "sqlite:///./dev.db"
    redis_url: str = "redis://localhost:6379/0"
    task_always_eager: bool = True  # dev/test: run tasks inline; production: False

    # --- storage ---
    storage_backend: Literal["local", "s3"] = "local"
    local_storage_path: str = "./var/storage"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "resume-intelligence-private"
    s3_region: str = "us-east-1"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_sse: str | None = "AES256"  # server-side encryption header; None to disable
    signed_url_ttl_seconds: int = 300

    # --- uploads ---
    max_upload_bytes: int = 5 * 1024 * 1024
    max_pdf_pages: int = 10
    max_docx_uncompressed_bytes: int = 30 * 1024 * 1024
    parse_timeout_seconds: int = 45
    parse_memory_limit_mb: int = 768
    parse_sandbox: bool = True  # run parser in a resource-limited child process
    ocr_enabled: bool = False
    tesseract_cmd: str | None = None

    # --- quotas / rate limits ---
    rate_limit_backend: Literal["memory", "redis"] = "memory"
    login_rate_per_minute: int = 10
    api_rate_per_minute: int = 120
    uploads_per_day: int = 20
    ai_requests_per_day: int = 50
    ai_monthly_cost_limit_usd: float = 5.0

    # --- AI ---
    llm_provider: Literal["fixture", "anthropic", "openai", "disabled"] = "fixture"
    llm_model: str = ""  # the provider's model ID; required when LLM_PROVIDER is anthropic or openai
    llm_timeout_seconds: float = 60
    llm_max_retries: int = 2
    anthropic_api_key: str | None = None
    anthropic_base_url: str = "https://api.anthropic.com"
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    # cost per 1M tokens, used for usage accounting (configure to your contract)
    llm_input_cost_per_mtok: float = 3.0
    llm_output_cost_per_mtok: float = 15.0

    embedding_backend: Literal["auto", "sentence-transformers", "tfidf"] = "auto"
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # --- integrations (absent => "unavailable" state in UI) ---
    learning_resources_provider: Literal["none", "curated_file"] = "none"
    learning_resources_file: str | None = None
    job_listings_provider: Literal["none"] = "none"

    # --- email ---
    email_backend: Literal["console", "smtp", "memory"] = "console"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "no-reply@localhost"
    smtp_starttls: bool = True

    # --- OAuth ---
    google_client_id: str | None = None
    google_client_secret: str | None = None

    # --- retention ---
    file_retention_days: int = 365
    analysis_retention_days: int = 365
    unverified_account_retention_days: int = 30
    bulk_upload_retention_days: int = 90  # recruiter-uploaded candidates without an account
    bulk_upload_max_files: int = 25

    # --- observability ---
    log_level: str = "INFO"
    log_json: bool = True
    sentry_dsn: str | None = None
    metrics_enabled: bool = True
    metrics_token: str | None = None  # if set, /api/metrics requires Bearer token

    admin_emails: str = Field(default="", description="comma separated emails promoted to admin on verify")
    recruiter_emails: str = Field(default="", description="comma separated emails promoted to recruiter (HR staff) on verify")

    @model_validator(mode="after")
    def _production_guards(self) -> Settings:
        if self.env == "production":
            problems = []
            if self.secret_key.startswith("dev-") or len(self.secret_key) < 32:
                problems.append("SECRET_KEY must be a random value of >= 32 chars")
            if not self.encryption_keys:
                problems.append("ENCRYPTION_KEYS is required")
            if not self.cookie_secure:
                problems.append("COOKIE_SECURE must be true")
            if self.task_always_eager:
                problems.append("TASK_ALWAYS_EAGER must be false")
            if self.database_url.startswith("sqlite"):
                problems.append("DATABASE_URL must point to PostgreSQL")
            if self.storage_backend != "s3":
                problems.append("STORAGE_BACKEND must be s3")
            if self.llm_provider == "fixture":
                problems.append("LLM_PROVIDER=fixture is not allowed in production (use 'disabled' or a real provider)")
            if problems:
                raise ValueError("Unsafe production configuration: " + "; ".join(problems))
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def admin_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def recruiter_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.recruiter_emails.split(",") if e.strip()}

    @property
    def google_oauth_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
