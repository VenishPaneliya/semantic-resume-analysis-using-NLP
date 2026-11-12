"""Races that hit a unique constraint answer 409, recruiter candidate lists are paginated, bulk uploads
have a time budget, and AI target ids survive PII scrubbing."""

from __future__ import annotations

import pytest
from conftest import confirmed_version, text_to_pdf, upload
from test_leaderboard import BACKEND_JD

from eval.synthetic import render


@pytest.fixture
def hr(make_user, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "recruiter_emails", "hr@example.com")
    return make_user("hr@example.com")


def _opening(hr) -> dict:
    r = hr.post("/api/recruiter/openings", json={"title": "Backend Developer", "company": "Acme", "description": BACKEND_JD})
    assert r.status_code == 201, r.text
    return r.json()


def test_racing_apply_returns_409_not_500(make_user, hr, personas, monkeypatch):
    import app.api.openings as openings_api

    o = _opening(hr)
    api = make_user("cand@example.com")
    _, vid = confirmed_version(api, render(personas["p02"], "A")[1])
    assert api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).status_code == 201
    # the second request didn't see the first one's row yet (two clicks at the same moment)
    monkeypatch.setattr(openings_api, "_my_application", lambda *a, **k: None)
    r = api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "conflict", r.text
    # the failed transaction was rolled back; the API keeps working
    monkeypatch.undo()
    assert api.get(f"/api/openings/{o['id']}/standing").status_code == 200


def test_racing_version_save_returns_409(make_user, pdf_bytes, monkeypatch):
    import app.services.editor as editor

    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    content = api.get(f"/api/versions/{vid}").json()["content"]
    content["summary"] = "First edit."
    assert api.post(f"/api/resumes/{rid}/versions", json={"base_version_id": vid, "content": content}).status_code == 201
    # a second tab saved from the same base at the same moment: it passed the stale-version check and
    # computed the same next version number, so the unique (resume_id, number) constraint fires
    import app.api.versions as versions_api
    from app.db import SessionLocal
    from app.models import ResumeVersion

    db = SessionLocal()
    v1 = db.get(ResumeVersion, vid)
    db.close()
    monkeypatch.setattr(versions_api, "latest_version", lambda db, resume_id: db.merge(v1))
    monkeypatch.setattr(editor, "func", _MaxIsOne())
    content["summary"] = "Second edit."
    r = api.post(f"/api/resumes/{rid}/versions", json={"base_version_id": vid, "content": content})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "conflict", r.text


class _MaxIsOne:
    """Stands in for sqlalchemy.func in editor.create_version so the next number collides with v2."""

    def max(self, col):
        from sqlalchemy import literal

        return literal(1)


def test_recruiter_candidates_are_paginated(make_user, hr, personas):
    o = _opening(hr)
    for i, pid in enumerate(("p02", "p06", "p01")):
        api = make_user(f"c{i}@example.com")
        _, vid = confirmed_version(api, render(personas[pid], "A")[1])
        assert api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).status_code == 201
    url = f"/api/recruiter/openings/{o['id']}/candidates"
    full = hr.get(url).json()
    assert full["total"] == full["matched"] == 3 and len(full["candidates"]) == 3 and full["has_more"] is False
    assert full["limit"] == 100 and full["offset"] == 0
    p1 = hr.get(url, params={"limit": 2}).json()
    p2 = hr.get(url, params={"limit": 2, "offset": 2}).json()
    assert [c["rank"] for c in p1["candidates"]] == [1, 2] and p1["has_more"] is True
    assert [c["rank"] for c in p2["candidates"]] == [3] and p2["has_more"] is False
    assert [c["application_id"] for c in p1["candidates"] + p2["candidates"]] == [c["application_id"] for c in full["candidates"]]
    # filters apply before paging; ranks stay positions in the whole pipeline
    top = full["candidates"][0]["score"]
    f = hr.get(url, params={"min_score": top, "limit": 1}).json()
    assert f["matched"] >= 1 and f["candidates"][0]["rank"] == 1 and f["total"] == 3
    assert hr.get(url, params={"limit": 0}).status_code == 422
    assert hr.get(url, params={"limit": 501}).status_code == 422


def test_bulk_upload_has_a_time_budget_and_page_limit(hr, personas, monkeypatch):
    from app.config import get_settings

    o = _opening(hr)
    url = f"/api/recruiter/openings/{o['id']}/bulk-upload"
    files = [("files", ("p09.pdf", render(personas["p09"], "A")[1], "application/pdf")),
             ("files", ("long.pdf", text_to_pdf("line\n" * 60 * 12), "application/pdf"))]
    body = hr.post(url, files=files, data={"consent_attested": "true"}).json()
    assert len(body["added"]) == 1 and [f["code"] for f in body["failed"]] == ["too_many_pages"]
    monkeypatch.setattr(get_settings(), "bulk_upload_time_budget_seconds", 0)
    body = hr.post(url, files=files[:1], data={"consent_attested": "true"}).json()
    assert body["added"] == [] and body["failed"][0]["code"] == "time_budget_exceeded"


def test_ai_target_ids_that_look_like_phone_numbers_survive_scrubbing(make_user, pdf_bytes):
    """Item ids are 10 random hex characters, so about 1 in 110 is all digits. The PII scrubber used to
    turn such an id into "[PHONE]", the fixture answered for "[PHONE]", and the suggestion failed with
    502 empty_ai_output (seen once on CI as KeyError 'items')."""
    api = make_user()
    r = upload(api, pdf_bytes)
    rid = r.json()["id"]
    content = api.get(f"/api/resumes/{rid}/extraction").json()["content"]
    exp = content["experience"][0]
    exp["bullets"][0]["id"] = "4815162342"
    exp["bullets"][0]["text"] = "responsible for maintaining the deployment scripts"
    v = api.put(f"/api/resumes/{rid}/review", json={"content": content})
    assert v.status_code == 200, v.text
    s = api.post(f"/api/versions/{v.json()['version_id']}/suggestions",
                 json={"operation": "rewrite_bullet", "target_path": f"experience/{exp['id']}/bullets/4815162342"})
    assert s.status_code == 201, s.text
    assert s.json()["items"][0]["target_id"] == "4815162342"


def test_scrubbing_still_removes_phone_numbers_in_text():
    from app.services.llm.service import scrub_value

    out = scrub_value({"id": "4815162342", "target_id": "4815162342", "text": "Call 4815162342 or +1 (555) 010-0199"}, None)
    assert out["id"] == out["target_id"] == "4815162342"
    assert "4815162342" not in out["text"] and "555" not in out["text"]
