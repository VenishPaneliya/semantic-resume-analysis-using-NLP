"""Leaderboards (A roles, B openings), standing among applicants (C), relevance-gated tips (D),
and the recruiter side. Fixture resume `pdf_bytes` is persona p02 (backend developer)."""

from __future__ import annotations

import json

import pytest
from conftest import confirmed_version

from eval.synthetic import render

BACKEND_JD = """We are hiring a Backend Developer to build payment APIs.

Responsibilities:
- Design and build REST APIs
- Write tests and review code

Requirements:
- 2+ years of backend development experience
- Python
- Django or FastAPI
- PostgreSQL
- REST API design
- Git

Preferred:
- Docker
- Redis
"""

FRONTEND_JD = """Frontend Engineer for our design tools.

Responsibilities:
- Build reusable React components
- Keep pages fast and accessible

Requirements:
- 2+ years of frontend experience
- JavaScript
- TypeScript
- React
- HTML and CSS

Nice to have:
- Next.js
- Tailwind CSS
"""


@pytest.fixture
def recruiter(make_user, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "recruiter_emails", "hr@example.com")
    return make_user("hr@example.com")


def _opening(api, title, desc, **kw):
    r = api.post("/api/recruiter/openings", json={"title": title, "company": "Acme (test)", "description": desc, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_recruiter_role_required(make_user, recruiter):
    cand = make_user("cand@example.com")
    assert cand.post("/api/recruiter/openings", json={"title": "X", "company": "Y", "description": BACKEND_JD}).status_code == 403
    assert cand.get("/api/recruiter/openings").status_code == 403
    assert recruiter.get("/api/auth/me").json()["role"] == "recruiter"
    o = _opening(recruiter, "Backend Developer", BACKEND_JD, work_arrangement="onsite")
    assert o["role_id"] == "backend_developer" and "Python" in o["skills"]


def test_role_leaderboard_ranks_all_roles_with_keywords(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    lb = api.get(f"/api/versions/{vid}/leaderboard/roles").json()
    assert lb["status"] == "ok"
    rows = lb["rows"]
    assert len(rows) == 12 and [r["rank"] for r in rows] == list(range(1, 13))
    assert rows[0]["role_id"] == "backend_developer" and rows[0]["tier"]["id"] in ("strong", "good")
    assert rows[0]["keywords_matched"] and rows[0]["tips_available"] is True
    assert [r["score"] for r in rows] == sorted((r["score"] for r in rows), reverse=True) or lb.get("preferences_applied")
    ml = next(r for r in rows if r["role_id"] == "frontend_developer")
    assert ml["tips_available"] is False and ml["tips_blocked_reason"]


def test_tips_are_gated_for_unrelated_roles(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    far = api.get(f"/api/versions/{vid}/tips", params={"role_id": "frontend_developer"}).json()
    assert far["eligible"] is False and far["tips"] == [] and far["gate_message"]
    assert far["learning_path"], "an unrelated target still gets an honest learning path"
    near = api.get(f"/api/versions/{vid}/tips", params={"role_id": "backend_developer"}).json()
    assert near["eligible"] is True and near["tips"]
    # tips never instruct adding a missing skill unconditionally
    for t in near["tips"]:
        if t["kind"] == "possibly_unlisted":
            assert "If you haven't, leave it out" in t["detail"]
    assert api.get(f"/api/versions/{vid}/tips").status_code == 422
    assert api.get(f"/api/versions/{vid}/tips", params={"role_id": "nope"}).status_code == 422


def test_tailor_suggestion_blocked_for_unrelated_target(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    v = api.get(f"/api/versions/{vid}").json()
    path = next(f"experience/{e['id']}/bullets/{e['bullets'][0]['id']}" for e in v["content"]["experience"] if e["bullets"])
    r = api.post(f"/api/versions/{vid}/suggestions", json={"operation": "tailor", "target_path": path, "target_role": "frontend_developer"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "target_not_related"
    r = api.post(f"/api/versions/{vid}/suggestions", json={"operation": "tailor", "target_path": path, "target_role": "backend_developer"})
    assert r.status_code == 201, r.text


def test_openings_leaderboard_and_opening_tips(make_user, recruiter, pdf_bytes):
    be = _opening(recruiter, "Backend Developer", BACKEND_JD)
    fe = _opening(recruiter, "Frontend Engineer", FRONTEND_JD)
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    lb = api.get(f"/api/versions/{vid}/leaderboard/openings").json()
    assert [r["id"] for r in lb["rows"]] == [be["id"], fe["id"]]
    assert lb["rows"][0]["score"] > lb["rows"][1]["score"] and lb["rows"][0]["keywords_matched"]
    assert lb["rows"][0]["tips_available"] and not lb["rows"][1]["tips_available"]
    assert api.get(f"/api/versions/{vid}/tips", params={"opening_id": fe["id"]}).json()["eligible"] is False
    t = api.get(f"/api/versions/{vid}/tips", params={"opening_id": be["id"]}).json()
    assert t["eligible"] is True and t["target"]["kind"] == "opening"
    # tailoring to an unrelated opening is refused, to a related one allowed
    v = api.get(f"/api/versions/{vid}").json()
    path = next(f"experience/{e['id']}/bullets/{e['bullets'][0]['id']}" for e in v["content"]["experience"] if e["bullets"])
    assert api.post(f"/api/versions/{vid}/suggestions", json={"operation": "tailor", "target_path": path,
                                                             "opening_id": fe["id"]}).status_code == 422
    assert api.post(f"/api/versions/{vid}/suggestions", json={"operation": "tailor", "target_path": path,
                                                             "opening_id": be["id"]}).status_code == 201


def test_no_openings_state(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    lb = api.get(f"/api/versions/{vid}/leaderboard/openings").json()
    assert lb["status"] == "no_openings" and lb["rows"] == [] and lb["message"]


def test_apply_standing_is_private_and_needs_pool(make_user, recruiter, personas, pdf_bytes):
    o = _opening(recruiter, "Backend Developer", BACKEND_JD)
    people = []
    for email, pid in (("a@example.com", "p02"), ("b@example.com", "p06"), ("c@example.com", "p01")):
        api = make_user(email)
        _, vid = confirmed_version(api, render(personas[pid], "A")[1])
        people.append((api, vid, email))

    a_api, a_vid, _ = people[0]
    assert a_api.post(f"/api/openings/{o['id']}/apply", json={"version_id": a_vid, "share_consent": False}).status_code == 422
    r = a_api.post(f"/api/openings/{o['id']}/apply", json={"version_id": a_vid, "share_consent": True})
    assert r.status_code == 201
    assert r.json()["standing"]["available"] is False  # only 1 applicant

    for api, vid, _ in people[1:]:
        assert api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).status_code == 201
    st = a_api.get(f"/api/openings/{o['id']}/standing").json()["standing"]
    assert st["available"] and st["applicants"] == 3 and st["rank"] == 1  # the backend developer leads
    assert sum(b["count"] for b in st["distribution"]) == 3
    blob = json.dumps(a_api.get(f"/api/openings/{o['id']}").json())
    for _, _, email in people[1:]:
        assert email not in blob, "candidates must never see other applicants"

    # candidates can't reach the recruiter view; the recruiter sees everyone ranked
    assert a_api.get(f"/api/recruiter/openings/{o['id']}/candidates").status_code == 403
    cands = recruiter.get(f"/api/recruiter/openings/{o['id']}/candidates").json()["candidates"]
    assert [c["email"] for c in cands][0] == "a@example.com" and len(cands) == 3
    detail = recruiter.get(f"/api/recruiter/applications/{cands[0]['application_id']}").json()
    assert detail["resume"]["experience"]
    assert recruiter.patch(f"/api/recruiter/applications/{cands[0]['application_id']}", json={"stage": "shortlisted"}).status_code == 200
    assert a_api.get(f"/api/openings/{o['id']}/standing").json()["stage"] == "shortlisted"

    # withdraw removes the application
    assert people[2][0].delete(f"/api/openings/{o['id']}/apply").status_code == 204
    assert people[2][0].get(f"/api/openings/{o['id']}/standing").status_code == 404


def test_reapply_and_recruiter_edit_rescore(make_user, recruiter, pdf_bytes):
    o = _opening(recruiter, "Backend Developer", BACKEND_JD)
    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    first = api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).json()
    again = api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).json()
    assert first["id"] == again["id"]
    r = recruiter.patch(f"/api/recruiter/openings/{o['id']}", json={"description": FRONTEND_JD})
    assert r.json()["rescored_applications"] == 1
    after = api.get(f"/api/openings/{o['id']}/standing").json()
    assert after["score"] < first["score"]


def test_closed_opening_hidden_from_candidates(make_user, recruiter, pdf_bytes):
    o = _opening(recruiter, "Backend Developer", BACKEND_JD)
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    recruiter.patch(f"/api/recruiter/openings/{o['id']}", json={"status": "closed"})
    assert api.get(f"/api/openings/{o['id']}").status_code == 404
    assert api.get("/api/openings").json() == []
    assert api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).status_code == 404


def test_deleting_resume_or_account_removes_applications(make_user, recruiter, pdf_bytes):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import JobOpening, OpeningApplication

    o = _opening(recruiter, "Backend Developer", BACKEND_JD)
    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True})
    assert api.delete(f"/api/resumes/{rid}").status_code == 204
    db = SessionLocal()
    assert db.scalar(select(func.count()).select_from(OpeningApplication)) == 0
    db.close()

    rid, vid = confirmed_version(api, pdf_bytes)
    api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True})
    from conftest import PASSWORD
    assert api.post("/api/account/delete", json={"password": PASSWORD, "confirm_email": "user@example.com"}).status_code == 200
    db = SessionLocal()
    assert db.scalar(select(func.count()).select_from(OpeningApplication)) == 0
    assert db.scalar(select(func.count()).select_from(JobOpening)) == 1  # the firm's opening stays
    db.close()


def test_demo_seed_is_labelled_and_idempotent():
    import subprocess
    import sys

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import JobOpening

    # the script uses the same DATABASE_URL as the tests (env set in conftest)
    for _ in range(2):
        subprocess.run([sys.executable, "scripts/seed_demo_openings.py"], check=True, capture_output=True)
    db = SessionLocal()
    rows = list(db.scalars(select(JobOpening)))
    assert rows and all(o.is_demo and "(sample)" in o.company for o in rows)
    assert len(rows) == len({(o.title, o.company) for o in rows})
    db.close()
    subprocess.run([sys.executable, "scripts/seed_demo_openings.py", "--remove"], check=True, capture_output=True)
