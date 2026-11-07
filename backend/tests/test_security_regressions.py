"""Regression tests for findings from the independent security review."""

from __future__ import annotations

import json

from conftest import PASSWORD, Api, confirmed_version, upload

from app.schemas.resume import ResumeContent
from app.services.llm.grounding import verify


def test_grounding_checks_sentence_initial_entities(personas):
    c = ResumeContent.model_validate(personas["p02"]["content"])
    g = verify("Built dashboards. Google acquired it.", c, source_text="Built dashboards.")
    assert any(u["value"] == "Google" for u in g["unsupported"])
    g = verify("Microsoft partnership: built REST APIs.", c, source_text="Built REST APIs.")
    assert any(u["value"] == "Microsoft" for u in g["unsupported"])
    # ordinary verb openings are not flagged
    assert verify("Containerised services with Docker.", c, source_text="Containerised services with Docker.")["grounded"]


def test_placeholder_cannot_smuggle_claims(personas):
    c = ResumeContent.model_validate(personas["p02"]["content"])
    g = verify("Built APIs [ADD: PhD from MIT, 10x revenue].", c, source_text="Built APIs.")
    kinds = {u["type"] for u in g["unsupported"]}
    assert {"credential", "number"} <= kinds
    assert verify("Built APIs [ADD: number of users served].", c, source_text="Built APIs.")["grounded"]


def test_pii_inside_bullets_is_scrubbed_before_sending(make_user, personas, monkeypatch):
    from conftest import text_to_pdf

    from app.services.llm import providers
    from app.services.llm.providers import LLMResult, Provider
    from eval.synthetic import render_text

    sent = []

    class Spy(Provider):
        name = "spy"
        sends_data_externally = True

        def complete_json(self, system, user, *, operation, max_tokens=1200):
            sent.append(user)
            return LLMResult(json.dumps({"revised": [], "explanation": "", "questions": []}), "spy", "spy", 1, 1, 1)

    spy = Spy("spy")
    import app.api.account as acc
    import app.api.suggestions as sug
    import app.services.llm.service as svc
    for mod in (providers, svc, sug, acc):
        monkeypatch.setattr(mod, "get_provider", lambda: spy)
    content = json.loads(json.dumps(personas["p02"]["content"]))
    content["summary"] = "Marcus Bell, reach me at marcus.bell@example.com or +1 555 010 2233, see github.com/marcus-x."
    api = make_user()
    _, vid = confirmed_version(api, text_to_pdf(render_text(content)))
    api.post("/api/account/ai-consent", json={"provider": "spy", "accept": True})
    api.post(f"/api/versions/{vid}/suggestions", json={"operation": "grammar", "target_path": "summary"})
    assert sent
    for needle in ("marcus.bell@example.com", "555 010 2233", "Marcus Bell", "github.com/marcus"):
        assert needle not in sent[0], needle


def test_suggestion_cache_is_scoped_to_version(make_user, pdf_bytes):
    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    a = api.post(f"/api/versions/{vid}/suggestions", json={"operation": "grammar", "target_path": "summary"}).json()
    var = api.post(f"/api/resumes/{rid}/variants", json={"title": "B"}).json()
    b = api.post(f"/api/versions/{var['latest_version_id']}/suggestions", json={"operation": "grammar", "target_path": "summary"}).json()
    assert a["id"] != b["id"] and b["version_id"] == var["latest_version_id"]
    r = api.post(f"/api/suggestions/{b['id']}/accept", json={}).json()
    assert api.get(f"/api/versions/{r['version_id']}").json()["resume_id"] == var["id"]


def test_unicode_filename_download(make_user, pdf_bytes):
    api = make_user()
    rid = upload(api, pdf_bytes, name="简历\r\nX.pdf").json()["id"]
    r = api.get(api.get(f"/api/resumes/{rid}/original-link").json()["url"])
    assert r.status_code == 200 and r.content == pdf_bytes
    assert "\n" not in r.headers["content-disposition"] and "filename*=UTF-8''" in r.headers["content-disposition"]


def test_malformed_edited_items_is_422(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    s = api.post(f"/api/versions/{vid}/suggestions", json={"operation": "grammar", "target_path": "summary"}).json()
    r = api.post(f"/api/suggestions/{s['id']}/accept", json={"edited_items": [{"target_id": [1]}]})
    assert r.status_code == 422


def test_compare_rejects_unknown_role(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    assert api.get(f"/api/versions/{vid}/compare/{vid}", params={"target_role": "x" * 100}).status_code == 422


def test_unsafe_project_url_rejected():
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ResumeContent.model_validate({"projects": [{"name": "x", "url": "javascript:alert(1)"}]})
    with pytest.raises(ValidationError):
        ResumeContent.model_validate({"certifications": [{"name": "x", "url": "data:text/html,hi"}]})


def test_password_change_invalidates_reset_tokens(make_user, app):
    from conftest import _token_from_outbox

    api = make_user("p@example.com")
    Api(app).post("/api/auth/forgot-password", json={"email": "p@example.com"})
    tok = _token_from_outbox("p@example.com", "reset-password")
    assert api.post("/api/account/password", json={"current_password": PASSWORD, "new_password": "Brand-new-pass-88"}).status_code == 200
    assert Api(app).post("/api/auth/reset-password", json={"token": tok, "password": "Attacker-pass-99"}).status_code == 400


def test_jd_upload_counts_toward_quota(make_user, pdf_bytes, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "uploads_per_day", 1)
    api = make_user()
    assert api.post("/api/job-descriptions/upload", files={"file": ("jd.pdf", pdf_bytes, "application/pdf")}).status_code == 201
    r = api.post("/api/job-descriptions/upload", files={"file": ("jd.pdf", pdf_bytes, "application/pdf")})
    assert r.status_code == 429


def test_resume_deletion_removes_export_jobs(make_user, pdf_bytes):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import ProcessingJob

    api = make_user()
    rid, _ = confirmed_version(api, pdf_bytes)
    api.post(f"/api/resumes/{rid}/exports", json={"format": "pdf"})
    assert api.delete(f"/api/resumes/{rid}").status_code == 204
    db = SessionLocal()
    assert db.scalar(select(func.count()).select_from(ProcessingJob)) == 0
    db.close()


def test_auth_reads_do_not_consume_login_rate_limit(make_user, app):
    api = make_user("rl@example.com")
    for _ in range(15):  # more than LOGIN_RATE_PER_MINUTE page loads
        assert api.get("/api/auth/me").status_code == 200
    assert Api(app).post("/api/auth/login", json={"email": "rl@example.com", "password": PASSWORD}).status_code == 200
