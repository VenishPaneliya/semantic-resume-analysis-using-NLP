"""encrypt resume content, AI suggestions, career artefacts and opening match results at rest

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-10 09:00:00

JSON columns become text holding a Fernet token of the JSON (app.models.EncryptedJSON); the AI
suggestion text columns hold Fernet tokens (app.models.EncryptedText). Existing rows are rewritten
in batches. Run with the production ENCRYPTION_KEYS: the first key encrypts. The downgrade decrypts
and restores the JSON/JSONB types. Both directions skip values already in the target form, so an
interrupted or repeated run is safe; a value that looks encrypted but cannot be decrypted with the
configured keys stops the migration (rolled back) instead of being encrypted a second time.
"""
from __future__ import annotations

import base64

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

JSON_COLUMNS: dict[str, list[str]] = {
    "extractions": ["fields"],
    "resume_versions": ["content"],
    "ai_suggestions": ["questions", "placeholders", "grounding", "items"],
    "career_artifacts": ["content"],
    "opening_applications": ["result"],
}
TEXT_COLUMNS: dict[str, list[str]] = {
    "ai_suggestions": ["before_text", "after_text", "explanation"],
}
BATCH = 500
_TOKEN_PREFIX = "gAAAAA"  # noqa: S105 - not a secret; every Fernet token starts with version byte 0x80 + timestamp, base64-encoded


def _all_columns() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {t: list(c) for t, c in JSON_COLUMNS.items()}
    for t, cols in TEXT_COLUMNS.items():
        out.setdefault(t, []).extend(cols)
    return out


def _looks_like_token(value: str) -> bool:
    """Structural check only: a Fernet token is url-safe base64 of version byte 0x80 + timestamp + IV +
    ciphertext + HMAC (at least 73 bytes). Plain JSON or text never has this shape."""
    if not value.startswith(_TOKEN_PREFIX):
        return False
    try:
        raw = base64.urlsafe_b64decode(value.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        return False
    return len(raw) >= 73 and raw[0] == 0x80


def _check_decrypts(value: str) -> str:
    from app.security.crypto import decrypt_str

    try:
        return decrypt_str(value)
    except ValueError as exc:
        raise RuntimeError(
            "Found an encrypted value that the configured keys cannot decrypt. Run this migration with the "
            "ENCRYPTION_KEYS (or SECRET_KEY / ENCRYPTION_FALLBACK_SECRET_KEYS) the application used; nothing "
            "was changed for this row."
        ) from exc


def _encrypt(value: str | None) -> str | None:
    from app.security.crypto import encrypt_str

    if value is None:
        return value
    if _looks_like_token(value):
        _check_decrypts(value)  # already encrypted (re-run): leave it, but never with an unreadable key
        return value
    return encrypt_str(value)


def _decrypt(value: str | None) -> str | None:
    if value is None or not _looks_like_token(value):
        return value  # already plain (re-run)
    return _check_decrypts(value)


def _rewrite(bind, table: str, cols: list[str], fn) -> None:
    t = sa.table(table, sa.column("id", sa.String), *[sa.column(c, sa.Text) for c in cols])
    last = ""
    while True:
        rows = bind.execute(sa.select(t).where(t.c.id > last).order_by(t.c.id).limit(BATCH)).all()
        if not rows:
            return
        for row in rows:
            changed = {}
            for c in cols:
                old = getattr(row, c)
                new = fn(old)
                if new != old:
                    changed[c] = new
            if changed:
                bind.execute(t.update().where(t.c.id == row.id).values(**changed))
        last = rows[-1].id


def _set_json_types(to_text: bool) -> None:
    bind = op.get_bind()
    for table, cols in JSON_COLUMNS.items():
        if bind.dialect.name == "postgresql":
            for c in cols:
                if to_text:
                    op.execute(f"ALTER TABLE {table} ALTER COLUMN {c} TYPE TEXT USING {c}::text")
                else:
                    op.execute(f"ALTER TABLE {table} ALTER COLUMN {c} TYPE JSONB USING {c}::jsonb")
        else:
            with op.batch_alter_table(table) as batch_op:
                for c in cols:
                    if to_text:
                        batch_op.alter_column(c, type_=sa.Text(), existing_type=sa.JSON(), existing_nullable=False)
                    else:
                        batch_op.alter_column(c, type_=sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
                                              existing_type=sa.Text(), existing_nullable=False)


def upgrade() -> None:
    _set_json_types(to_text=True)
    bind = op.get_bind()
    for table, cols in _all_columns().items():
        _rewrite(bind, table, cols, _encrypt)


def downgrade() -> None:
    bind = op.get_bind()
    for table, cols in _all_columns().items():
        _rewrite(bind, table, cols, _decrypt)
    _set_json_types(to_text=False)
