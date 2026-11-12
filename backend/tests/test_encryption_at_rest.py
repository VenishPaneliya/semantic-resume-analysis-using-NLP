"""Resume content and everything derived from it is encrypted in the database, and migration 0005
encrypts (and its downgrade decrypts) existing rows."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import sqlalchemy as sa
from conftest import confirmed_version

BACKEND = Path(__file__).resolve().parents[1]

ENCRYPTED = {  # table -> columns that must never hold readable resume text
    "resume_versions": ["content"],
    "extractions": ["fields", "raw_text"],
    "ai_suggestions": ["before_text", "after_text", "explanation", "items", "questions", "placeholders", "grounding"],
    "career_artifacts": ["content"],
    "opening_applications": ["result", "content_enc"],
}


def _raw(table: str, cols: list[str]) -> list[dict]:
    from app.db import get_engine

    with get_engine().connect() as c:
        return [dict(r._mapping) for r in c.execute(sa.text(f"select {', '.join(cols)} from {table}"))]  # noqa: S608 - fixed names from this test


def test_resume_content_and_derived_text_are_stored_encrypted(make_user, pdf_bytes):
    from test_leaderboard import BACKEND_JD

    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    content = api.get(f"/api/versions/{vid}").json()["content"]
    bullet = content["experience"][0]["bullets"][0]
    s = api.post(f"/api/versions/{vid}/suggestions", json={"operation": "rewrite_bullet",
                 "target_path": f"experience/{content['experience'][0]['id']}/bullets/{bullet['id']}"})
    assert s.status_code == 201, s.text
    jd = api.post("/api/job-descriptions", json={"title": "Backend", "text": BACKEND_JD}).json()
    cl = api.post("/api/career/cover-letter", json={"version_id": vid, "jd_id": jd["id"]})
    assert cl.status_code in (200, 201), cl.text

    secrets_in_resume = [bullet["text"][:25], content["contact"]["name"], content["contact"]["email"]]
    for table, cols in ENCRYPTED.items():
        if table == "opening_applications":
            continue  # covered by the recruiter tests below
        rows = _raw(table, cols)
        assert rows, table
        for row in rows:
            for col, value in row.items():
                assert isinstance(value, str) and value.startswith("gAAAAA"), (table, col, str(value)[:60])
                assert not any(x and x in value for x in secrets_in_resume), (table, col)
    # the application still reads everything back
    assert api.get(f"/api/versions/{vid}").json()["content"] == content
    assert api.get(f"/api/versions/{vid}/suggestions").json()[0]["items"][0]["before"] == bullet["text"]
    assert api.get(f"/api/resumes/{rid}/extraction").json()["content"]["contact"]["name"] == content["contact"]["name"]


def test_opening_match_results_are_encrypted(make_user, personas, monkeypatch):
    from test_leaderboard import BACKEND_JD

    from app.config import get_settings
    from eval.synthetic import render

    monkeypatch.setattr(get_settings(), "recruiter_emails", "hr@example.com")
    hr = make_user("hr@example.com")
    o = hr.post("/api/recruiter/openings", json={"title": "Backend Developer", "company": "Acme", "description": BACKEND_JD}).json()
    cand = make_user("cand@example.com")
    _, vid = confirmed_version(cand, render(personas["p02"], "A")[1])
    assert cand.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).status_code == 201
    (row,) = _raw("opening_applications", ["result"])
    assert row["result"].startswith("gAAAAA") and "requirements" not in row["result"]
    rows = hr.get(f"/api/recruiter/openings/{o['id']}/candidates").json()["candidates"]
    assert rows and rows[0]["keywords_matched"]


# ---------------------------------------------------------------- migration 0005


def _alembic(url: str, monkeypatch, *args: str) -> None:
    from alembic.config import Config

    from alembic import command
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "database_url", url)  # alembic/env.py reads the URL from settings
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    getattr(command, args[0])(cfg, *args[1:])


def _fill(conn, table: str, overrides: dict, n: int) -> None:
    """Insert one row giving every NOT NULL column a placeholder value of the right type."""
    cols = sa.inspect(conn).get_columns(table)
    row = {}
    for c in cols:
        if c["name"] in overrides:
            row[c["name"]] = overrides[c["name"]]
        elif not c["nullable"]:
            t = c["type"]
            row[c["name"]] = (datetime.now(UTC) if isinstance(t, sa.DateTime) else 0 if isinstance(t, sa.Integer | sa.Float)
                              else False if isinstance(t, sa.Boolean) else f"x{n}")  # unique, for unique columns
    keys = ", ".join(row)
    conn.execute(sa.text(f"insert into {table} ({keys}) values ({', '.join(':' + k for k in row)})"), row)  # noqa: S608 - fixed names from this test


def test_migration_0005_encrypts_and_downgrade_decrypts_existing_rows(tmp_path, monkeypatch):
    from app.security.crypto import decrypt_str

    url = f"sqlite:///{tmp_path / 'migrate.db'}"
    _alembic(url, monkeypatch, "upgrade", "0004")
    content = {"contact": {"name": "Asha Rao", "email": "asha@example.com"}, "experience": [{"bullets": [{"text": "Built ₹ APIs"}]}]}
    plain = {
        "extractions": {"fields": json.dumps({"content": content})},
        "resume_versions": {"content": json.dumps(content)},
        "ai_suggestions": {"before_text": "Built APIs", "after_text": "Designed APIs", "explanation": "Stronger verb.",
                           "items": json.dumps([{"before": "Built APIs", "after": "Designed APIs"}]),
                           "questions": json.dumps(["How many users?"]), "placeholders": "[]",
                           "grounding": json.dumps({"grounded": True, "unsupported": []})},
        "career_artifacts": {"content": json.dumps({"paragraphs": ["Dear team, I am Asha Rao."]})},
        "opening_applications": {"result": json.dumps({"requirements": [{"evidence": ["Built APIs"]}]})},
    }
    eng = sa.create_engine(url)
    with eng.begin() as c:
        for table, values in plain.items():
            for i in range(3):  # several rows, so batching and ordering are exercised
                _fill(c, table, {"id": f"{table[:8]}-{i}", **values}, i)
    eng.dispose()

    _alembic(url, monkeypatch, "upgrade", "head")
    eng = sa.create_engine(url)
    with eng.connect() as c:
        for table, values in plain.items():
            for row in c.execute(sa.text(f"select {', '.join(values)} from {table}")).mappings():  # noqa: S608 - fixed names from this test
                for col, original in values.items():
                    assert row[col].startswith("gAAAAA") and "Asha" not in row[col], (table, col)
                    assert decrypt_str(row[col]) == original
    eng.dispose()

    # running the data step twice (e.g. after an interrupted deploy) must not double-encrypt
    _alembic(url, monkeypatch, "downgrade", "0004")
    eng = sa.create_engine(url)
    with eng.connect() as c:
        for table, values in plain.items():
            for row in c.execute(sa.text(f"select {', '.join(values)} from {table}")).mappings():  # noqa: S608 - fixed names from this test
                for col, original in values.items():
                    assert json.loads(row[col]) == json.loads(original) if original.startswith(("{", "[")) else row[col] == original
    eng.dispose()
    _alembic(url, monkeypatch, "upgrade", "head")
    _alembic(url, monkeypatch, "upgrade", "head")
    eng = sa.create_engine(url)
    with eng.connect() as c:
        (v,) = c.execute(sa.text("select content from resume_versions limit 1")).one()
        assert json.loads(decrypt_str(v)) == content
    eng.dispose()


def test_encrypted_json_round_trips_through_the_orm():
    from app.models import EncryptedJSON

    t = EncryptedJSON()
    for value in ({"a": [1, "₹ é"]}, [], {}, None):
        stored = t.process_bind_param(value, None)
        assert stored is None if value is None else stored.startswith("gAAAAA")
        assert t.process_result_value(stored, None) == value


@pytest.mark.parametrize("keys,ok", [("", False), (" , ", False), ("not-a-key", False), (None, True)])
def test_production_requires_valid_encryption_keys(keys, ok):
    from cryptography.fernet import Fernet
    from pydantic import ValidationError

    from app.config import Settings

    good = dict(env="production", secret_key="s" * 40, cookie_secure=True, task_always_eager=False,
                database_url="postgresql+psycopg://x/y", storage_backend="s3", llm_provider="disabled", metrics_token="t",
                email_backend="smtp", rate_limit_backend="redis", public_base_url="https://a.example", cors_origins="https://a.example",
                require_mfa_for_staff=True)
    if ok:
        Settings(**good, encryption_keys=f"{Fernet.generate_key().decode()},{Fernet.generate_key().decode()}")
    else:
        with pytest.raises(ValidationError, match="ENCRYPTION_KEYS"):
            Settings(**good, encryption_keys=keys)


# ---------------------------------------------------------------- old keys keep working


@pytest.fixture
def crypto_settings(monkeypatch):
    """Change key settings for one test; the key cache is rebuilt before and after."""
    from app.config import get_settings
    from app.security.crypto import reset_crypto_cache

    s = get_settings()
    reset_crypto_cache()

    def set_(**kw):
        for k, v in kw.items():
            monkeypatch.setattr(s, k, v)
        reset_crypto_cache()

    yield set_
    monkeypatch.undo()
    reset_crypto_cache()


def _legacy_token(secret_key: str, text: str) -> str:
    """Encrypt exactly as the previous version did without ENCRYPTION_KEYS."""
    from cryptography.fernet import Fernet

    from app.security.crypto import derive_key

    return Fernet(derive_key(secret_key)).encrypt(text.encode()).decode()


def test_data_from_the_old_dev_default_secret_still_decrypts(crypto_settings):
    """The dev compose file used SECRET_KEY=dev-insecure-change-me-dev-insecure-change-me; when that default
    disappeared, the derived key changed and stored 2FA secrets failed with "Unable to decrypt"."""
    from app.security.crypto import decrypt_str, encrypt_str

    old = _legacy_token("dev-insecure-change-me-dev-insecure-change-me", "JBSWY3DPEHPK3PXP")
    crypto_settings(secret_key="dev-insecure-change-me", encryption_keys="", env="development")
    assert decrypt_str(old) == "JBSWY3DPEHPK3PXP"
    # new data uses the current derived key
    assert decrypt_str(encrypt_str("x")) == "x"


def test_adding_encryption_keys_does_not_orphan_secret_key_data(crypto_settings):
    from cryptography.fernet import Fernet

    from app.security.crypto import decrypt_str, encrypt_str

    sk = "a-random-secret-key-that-is-long-enough-1234"
    old = _legacy_token(sk, "resume text")
    new_key = Fernet.generate_key().decode()
    crypto_settings(secret_key=sk, encryption_keys=new_key, env="production")
    assert decrypt_str(old) == "resume text"
    assert Fernet(new_key.encode()).decrypt(encrypt_str("y").encode()) == b"y", "new data uses ENCRYPTION_KEYS"


def test_a_rotated_secret_key_can_be_listed_as_a_fallback(crypto_settings):
    from app.security.crypto import decrypt_str

    old = _legacy_token("previous-secret-key-value-0123456789", "kept")
    crypto_settings(secret_key="new-secret-key-value-0123456789abcdef", encryption_keys="", env="production")
    with pytest.raises(ValueError):
        decrypt_str(old)
    crypto_settings(encryption_fallback_secret_keys="previous-secret-key-value-0123456789")
    assert decrypt_str(old) == "kept"


def test_two_factor_login_survives_the_dev_secret_key_change(make_user, app, crypto_settings):
    """Stored TOTP secret and recovery codes created under the old dev default still work."""
    import time

    from conftest import PASSWORD, Api
    from sqlalchemy import update

    from app.db import SessionLocal
    from app.models import User
    from app.security import totp
    from app.security.crypto import keyed_hash

    make_user("qa-hr@example.com")
    old_sk = "dev-insecure-change-me-dev-insecure-change-me"
    secret = totp.new_secret()
    db = SessionLocal()
    db.execute(update(User).where(User.email == "qa-hr@example.com").values(
        totp_enabled_at=datetime.now(UTC), recovery_code_hashes=[keyed_hash("aaaaaa-bbbbbb", old_sk)]))
    # raw SQL: the ORM column type would encrypt the stored token a second time
    db.execute(sa.text("update users set totp_secret = :t where email = 'qa-hr@example.com'"),
               {"t": _legacy_token(old_sk, secret)})
    db.commit()
    db.close()
    crypto_settings(secret_key="dev-insecure-change-me", env="development")
    c = Api(app)
    t = c.post("/api/auth/login", json={"email": "qa-hr@example.com", "password": PASSWORD}).json()["mfa_token"]
    r = c.post("/api/auth/login/mfa", json={"mfa_token": t, "code": totp.code_at(secret, int(time.time() // 30))})
    assert r.status_code == 200, r.text
    c2 = Api(app)
    t = c2.post("/api/auth/login", json={"email": "qa-hr@example.com", "password": PASSWORD}).json()["mfa_token"]
    r = c2.post("/api/auth/login/mfa", json={"mfa_token": t, "code": "aaaaaa-bbbbbb"})
    assert r.status_code == 200 and r.json()["recovery_codes_left"] == 0, r.text


def test_migration_refuses_to_double_encrypt_with_the_wrong_key(tmp_path, monkeypatch, crypto_settings):
    url = f"sqlite:///{tmp_path / 'wrongkey.db'}"
    _alembic(url, monkeypatch, "upgrade", "head")
    eng = sa.create_engine(url)
    with eng.begin() as c:
        _fill(c, "career_artifacts", {"id": "ca-1", "content": json.dumps({"paragraphs": ["hi"]})}, 1)
    eng.dispose()
    _alembic(url, monkeypatch, "downgrade", "0004")
    _alembic(url, monkeypatch, "upgrade", "head")  # encrypts with the current key
    eng = sa.create_engine(url)
    with eng.connect() as c:
        (before,) = c.execute(sa.text("select content from career_artifacts")).one()
    eng.dispose()
    # a re-run with keys that cannot read the data stops instead of wrapping the token again
    crypto_settings(secret_key="some-other-secret-key-0123456789abcdef", env="production",
                    encryption_keys="", encryption_fallback_secret_keys="")
    with pytest.raises(RuntimeError, match="cannot decrypt"):
        _alembic(url, monkeypatch, "downgrade", "0004")
    eng = sa.create_engine(url)
    with eng.connect() as c:
        (after,) = c.execute(sa.text("select content from career_artifacts")).one()
    eng.dispose()
    assert after == before
