from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="ri-test-")
os.environ.update({
    "ENV": "test",
    # TEST_DATABASE_URL runs the suite against PostgreSQL (CI / docker); default is SQLite
    "DATABASE_URL": os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_TMP}/test.db",
    "EMAIL_BACKEND": "memory",
    "TASK_ALWAYS_EAGER": "true",
    "EMBEDDING_BACKEND": os.environ.get("TEST_EMBEDDING_BACKEND", "tfidf"),
    "LOCAL_STORAGE_PATH": f"{_TMP}/storage",
    "PARSE_SANDBOX": "false",
    "LLM_PROVIDER": "fixture",
    "SECRET_KEY": "test-secret-key-that-is-long-enough-123",
    "LOG_JSON": "true",
    "LOG_LEVEL": "WARNING",
    "ADMIN_EMAILS": "admin@example.com",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings  # noqa: E402

get_settings.cache_clear()

import app.models  # noqa: E402,F401
from app.db import Base, get_engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.security.ratelimit import reset_rate_limits  # noqa: E402
from app.services import email as email_mod  # noqa: E402
from app.services.storage import reset_storage  # noqa: E402
from eval.synthetic import load, render, render_text, text_to_pdf  # noqa: E402

PASSWORD = "Correct-horse-42"


@pytest.fixture(autouse=True)
def _fresh_db():
    eng = get_engine()
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    reset_rate_limits()
    reset_storage()
    email_mod.OUTBOX.clear()
    yield


@pytest.fixture
def app():
    return create_app()


class Api:
    """TestClient wrapper that sends the CSRF header like the real frontend."""

    def __init__(self, app):
        self.c = TestClient(app)

    def _h(self, headers=None):
        h = dict(headers or {})
        tok = self.c.cookies.get(get_settings().csrf_cookie_name)
        if tok:
            h["x-csrf-token"] = tok
        return h

    def get(self, url, **kw):
        return self.c.get(url, **kw)

    def post(self, url, **kw):
        kw["headers"] = self._h(kw.get("headers"))
        return self.c.post(url, **kw)

    def put(self, url, **kw):
        kw["headers"] = self._h(kw.get("headers"))
        return self.c.put(url, **kw)

    def patch(self, url, **kw):
        kw["headers"] = self._h(kw.get("headers"))
        return self.c.patch(url, **kw)

    def delete(self, url, **kw):
        kw["headers"] = self._h(kw.get("headers"))
        return self.c.delete(url, **kw)


def _token_from_outbox(to: str, kind: str) -> str:
    for m in reversed(email_mod.OUTBOX):
        if m.to == to and kind in m.body:
            return re.search(r"token=([\w\-]+)", m.body).group(1)  # type: ignore[union-attr]
    raise AssertionError("no email")


@pytest.fixture
def make_user(app):
    def _make(email="user@example.com", verify=True) -> Api:
        api = Api(app)
        r = api.post("/api/auth/register", json={"email": email, "password": PASSWORD})
        assert r.status_code == 201, r.text
        if verify:
            tok = _token_from_outbox(email, "verify-email")
            r = api.post("/api/auth/verify-email", json={"token": tok})
            assert r.status_code == 200, r.text
        return api
    return _make


@pytest.fixture
def personas():
    return {p["id"]: p for p in load()["personas"]}


@pytest.fixture
def pdf_bytes(personas):
    return render(personas["p02"], "A")[1]


def upload(api: Api, data: bytes, name="resume.pdf", ctype="application/pdf"):
    return api.post("/api/resumes", files={"file": (name, data, ctype)})


def confirmed_version(api: Api, data: bytes, name="resume.pdf", ctype="application/pdf") -> tuple[str, str]:
    r = upload(api, data, name, ctype)
    assert r.status_code == 202, r.text
    rid = r.json()["id"]
    ex = api.get(f"/api/resumes/{rid}/extraction")
    assert ex.status_code == 200, ex.text
    r = api.put(f"/api/resumes/{rid}/review", json={"content": ex.json()["content"]})
    assert r.status_code == 200, r.text
    return rid, r.json()["version_id"]


__all__ = ["Api", "upload", "confirmed_version", "render_text", "text_to_pdf", "PASSWORD"]
