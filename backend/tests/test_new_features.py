"""Recruiter tools, engagement features, two-factor login and fairness monitoring."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from conftest import PASSWORD, Api, _token_from_outbox, confirmed_version
from test_leaderboard import BACKEND_JD, FRONTEND_JD

from eval.synthetic import render


@pytest.fixture
def recruiter(make_user, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "recruiter_emails", "hr@example.com")
    return make_user("hr@example.com")


def _opening(api, title=" Backend Developer", desc=BACKEND_JD):
    r = api.post("/api/recruiter/openings", json={"title": title.strip(), "company": "Acme (test)", "description": desc})
    assert r.status_code == 201, r.text
    return r.json()


def _applicants(make_user, personas, opening_id, specs=(("a@example.com", "p02"), ("b@example.com", "p06"), ("c@example.com", "p01"))):
    out = []
    for email, pid in specs:
        api = make_user(email)
        _, vid = confirmed_version(api, render(personas[pid], "A")[1])
        r = api.post(f"/api/openings/{opening_id}/apply", json={"version_id": vid, "share_consent": True})
        assert r.status_code == 201, r.text
        out.append((api, vid, r.json()["id"]))
    return out


# ---------------------------------------------------------------- recruiter tools


def test_filters_compare_stages_and_private_notes(make_user, recruiter, personas):
    o = _opening(recruiter)
    apps = _applicants(make_user, personas, o["id"])
    base = f"/api/recruiter/openings/{o['id']}/candidates"
    allc = recruiter.get(base).json()
    assert allc["total"] == 3 and all(c["years"] is not None for c in allc["candidates"])
    py = recruiter.get(base, params={"must_have": ["Python"]}).json()["candidates"]
    assert py and all("a@example.com" == c["email"] or c["score"] for c in py)
    assert len(py) < 3, "the frontend persona does not show Python"
    assert recruiter.get(base, params={"min_score": 60}).json()["candidates"][0]["email"] == "a@example.com"
    assert recruiter.get(base, params={"must_have": ["NotASkill"]}).status_code == 422

    # pipeline stages
    aid = apps[0][2]
    for st in ("shortlisted", "interview", "offer"):
        r = recruiter.patch(f"/api/recruiter/applications/{aid}", json={"stage": st}).json()
        assert r["stage"] == st and r["stage_changed_at"]
    assert [c["email"] for c in recruiter.get(base, params={"stage": ["offer"]}).json()["candidates"]] == ["a@example.com"]
    assert apps[0][0].get(f"/api/openings/{o['id']}/standing").json()["stage"] == "offer"

    # side-by-side
    cmp_ = recruiter.get(f"/api/recruiter/openings/{o['id']}/compare", params={"ids": [apps[0][2], apps[1][2]]}).json()
    assert len(cmp_["candidates"]) == 2 and cmp_["requirements"]
    assert all(len(r["cells"]) == 2 for r in cmp_["requirements"])
    assert recruiter.get(f"/api/recruiter/openings/{o['id']}/compare", params={"ids": [aid]}).status_code == 422

    # notes are private to staff
    n = recruiter.post(f"/api/recruiter/applications/{aid}/notes", json={"text": "Strong API design answers."}).json()
    assert n["text"] == "Strong API design answers." and n["author"]
    assert "Strong API design" not in json.dumps(apps[0][0].get(f"/api/openings/{o['id']}").json())
    assert apps[0][0].get(f"/api/recruiter/applications/{aid}/notes").status_code == 403
    assert recruiter.get(f"/api/recruiter/applications/{aid}").json()["notes"][0]["id"] == n["id"]
    assert recruiter.delete(f"/api/recruiter/notes/{n['id']}").status_code == 204
    # applied candidates can't be deleted by staff, only rejected
    assert recruiter.delete(f"/api/recruiter/applications/{aid}").status_code == 409


def test_bulk_upload_consent_standing_and_expiry(make_user, recruiter, personas):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import OpeningApplication, utcnow
    from app.services.pipeline import retention_sweep

    o = _opening(recruiter)
    files = [("files", (f"{pid}.pdf", render(personas[pid], "A")[1], "application/pdf")) for pid in ("p09", "p03")]
    url = f"/api/recruiter/openings/{o['id']}/bulk-upload"
    assert recruiter.post(url, files=files, data={"consent_attested": "false"}).status_code == 422
    r = recruiter.post(url, files=files + [("files", ("bad.pdf", b"not a pdf", "application/pdf"))], data={"consent_attested": "true"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert len(body["added"]) == 2 and len(body["failed"]) == 1 and body["retention_days"] == 90
    cands = recruiter.get(f"/api/recruiter/openings/{o['id']}/candidates", params={"source": "uploaded"}).json()["candidates"]
    assert len(cands) == 2 and all(c["source"] == "uploaded" and c["expires_at"] for c in cands)
    detail = recruiter.get(f"/api/recruiter/applications/{cands[0]['application_id']}").json()
    assert detail["resume"]["experience"] and detail["name"]

    # uploads never count toward a candidate's standing
    a = make_user("solo@example.com")
    _, vid = confirmed_version(a, render(personas["p02"], "A")[1])
    st = a.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).json()["standing"]
    assert st["available"] is False and st["applicants"] == 1

    # stored content is encrypted at rest
    from sqlalchemy import text

    db = SessionLocal()
    raw = db.execute(text("select content_enc from opening_applications where source='uploaded'")).scalars().first()
    assert raw and "experience" not in raw
    # expiry removes uploads (not applicants)
    for row in db.scalars(select(OpeningApplication).where(OpeningApplication.source == "uploaded")):
        row.expires_at = utcnow() - timedelta(days=1)
    db.commit()
    assert retention_sweep(db)["uploaded_candidates"] == 2
    assert db.scalar(select(OpeningApplication).where(OpeningApplication.source == "applied")) is not None
    db.close()


def test_analytics(make_user, recruiter, personas):
    from app.db import SessionLocal
    from app.models import JobOpening, utcnow

    o = _opening(recruiter)
    _applicants(make_user, personas, o["id"])
    db = SessionLocal()
    db.get(JobOpening, o["id"]).created_at = utcnow() - timedelta(days=20)
    db.commit()
    db.close()
    an = recruiter.get("/api/recruiter/analytics").json()
    assert an["totals"]["candidates"] == 3 and an["totals"]["applied"] == 3
    assert an["most_missing_skills"] and an["most_missing_skills"][0]["candidates"] >= 1
    row = next(r for r in an["openings"] if r["id"] == o["id"])
    assert row["applicants"] == 3 and row["age_days"] >= 20 and row["hard_to_fill"] is True  # only 1 strong match
    assert "email" not in json.dumps(an)


# ---------------------------------------------------------------- engagement


def test_job_alerts_opt_in_threshold_and_dedupe(make_user, recruiter, personas, pdf_bytes):
    from app.services.email import OUTBOX

    on = make_user("on@example.com")
    rid, _ = confirmed_version(on, pdf_bytes)
    assert on.patch("/api/account/settings", json={"job_alerts": {"enabled": True, "min_score": 60, "resume_id": rid}}).status_code == 200
    on.patch("/api/account/settings", json={"notification_prefs": {"weekly_digest": True}})  # must not wipe alert prefs
    assert on.get("/api/auth/me").json()["notification_prefs"]["job_alerts"] is True
    off = make_user("off@example.com")
    confirmed_version(off, pdf_bytes)
    OUTBOX.clear()
    o = _opening(recruiter)
    _opening(recruiter, "Frontend Engineer", FRONTEND_JD)  # below threshold for this backend resume
    sent = [m for m in OUTBOX if "New opening" in m.subject]
    assert [m.to for m in sent] == ["on@example.com"] and o["id"] in sent[0].body and "/settings" in sent[0].body
    recruiter.patch(f"/api/recruiter/openings/{o['id']}", json={"status": "closed"})
    recruiter.patch(f"/api/recruiter/openings/{o['id']}", json={"status": "open"})
    assert len([m for m in OUTBOX if "New opening" in m.subject]) == 1, "one alert per opening"
    other = make_user("x@example.com")
    assert other.patch("/api/account/settings", json={"job_alerts": {"enabled": True, "resume_id": rid}}).status_code == 404


def test_what_if_previews_without_saving(make_user, pdf_bytes):
    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    c = api.get(f"/api/versions/{vid}").json()["content"]
    e = next(x for x in c["experience"] if x["bullets"])
    e["bullets"].append({"id": "new1", "text": "Containerised services with Docker and deployed them on Kubernetes with Terraform."})
    r = api.post(f"/api/versions/{vid}/what-if", json={"content": c, "role_id": "devops_engineer"}).json()
    assert r["delta"] > 0 and "Kubernetes" in r["keywords_gained"] and not r["keywords_lost"]
    assert len(api.get(f"/api/resumes/{rid}/versions").json()) == 1, "nothing saved"
    assert api.post(f"/api/versions/{vid}/what-if", json={"content": c}).status_code == 422


def test_learning_plan_progress_and_resources(make_user, pdf_bytes):
    api = make_user()
    confirmed_version(api, pdf_bytes)
    r = api.post("/api/learning", json={"skills": ["Kubernetes", "Terraform", "Kubernetes"], "target_kind": "role",
                                        "target_id": "devops_engineer", "target_title": "DevOps Engineer"}).json()
    assert r["added"] == ["Kubernetes", "Terraform"] and r["progress"] == {"done": 0, "total": 2, "percent": 0}
    k = next(i for i in r["items"] if i["skill"] == "Kubernetes")
    assert k["resources"]["status"] == "ok" and k["resources"]["resources"][0]["url"].startswith("https://kubernetes.io")
    done = api.patch(f"/api/learning/{k['id']}", json={"status": "done"}).json()
    assert done["completed_at"] and done["next_step"] and done["evidence_in_resume"] is False
    assert api.get("/api/learning").json()["progress"]["percent"] == 50
    assert api.post("/api/learning", json={"skills": ["Juggling"]}).status_code == 422
    assert make_user("z@example.com").patch(f"/api/learning/{k['id']}", json={"status": "todo"}).status_code == 404


def test_resume_history(make_user, pdf_bytes):
    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    c = api.get(f"/api/versions/{vid}").json()["content"]
    c["summary"] = "Backend developer building REST APIs in Python, FastAPI and PostgreSQL, deployed with Docker."
    api.post(f"/api/resumes/{rid}/versions", json={"base_version_id": vid, "content": c})
    h = api.get(f"/api/resumes/{rid}/history", params={"role_id": "backend_developer"}).json()
    assert [p["number"] for p in h["points"]] == [1, 2]
    assert all(p["quality"] is not None and p["target_score"] is not None and p["top_role"] for p in h["points"])
    assert h["change"]["target_score"] is not None


def test_mock_interview_checks_ai_feedback_and_encryption(make_user, pdf_bytes):
    from sqlalchemy import text

    from app.db import SessionLocal

    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    s = api.post(f"/api/versions/{vid}/interviews", json={"role_id": "backend_developer"}).json()
    assert s["questions"] and s["target"]["title"] == "Backend Developer"
    q = s["questions"][0]["id"]
    ans = ("When our checkout API kept timing out, I investigated the slow queries and I added indexes in PostgreSQL. "
           "I also introduced Redis caching for the product catalogue so that repeated reads skipped the database. "
           "As a result p95 latency dropped from 1.2 seconds to 300 ms and timeouts stopped during the sale.")
    r = api.post(f"/api/interviews/{s['id']}/answers", json={"question_id": q, "answer": ans}).json()
    ok = {i["id"]: i["ok"] for i in r["checks"]["items"]}
    assert ok["situation"] and ok["action"] and ok["result"] and ok["measurable"] and ok["ownership"]
    assert r["checks"]["label"].startswith("Structure checks") and r["ai"]["status"] in ("ok", "unavailable")
    weak = api.post(f"/api/interviews/{s['id']}/answers", json={"question_id": q, "answer": "We did the project together."}).json()
    assert not {i["id"]: i["ok"] for i in weak["checks"]["items"]}["action"]
    assert api.get(f"/api/interviews/{s['id']}").json()["answered"] == 1
    db = SessionLocal()
    raw = db.execute(text("select answers_enc from interview_sessions")).scalars().first()
    assert raw and "checkout" not in raw
    db.close()
    assert make_user("o@example.com").get(f"/api/interviews/{s['id']}").status_code == 404
    assert api.delete(f"/api/interviews/{s['id']}").status_code == 204


# ---------------------------------------------------------------- two-factor authentication


def _enable_mfa(api):
    from app.security import totp

    secret = api.post("/api/account/2fa/setup").json()["secret"]
    r = api.post("/api/account/2fa/enable", json={"code": totp.code_at(secret, int(__import__("time").time() // 30))})
    assert r.status_code == 200, r.text
    return secret, r.json()["recovery_codes"]


def test_two_factor_login_replay_and_recovery(make_user, app):
    import time

    from app.security import totp

    api = make_user("mfa@example.com")
    secret, codes = _enable_mfa(api)
    assert len(codes) == 10 and api.get("/api/auth/me").json()["mfa_enabled"] is True

    fresh = Api(app)
    r = fresh.post("/api/auth/login", json={"email": "mfa@example.com", "password": PASSWORD}).json()
    assert r["mfa_required"] is True and "id" not in r
    assert fresh.get("/api/auth/me").status_code == 401, "no session before the second factor"
    assert fresh.post("/api/auth/login/mfa", json={"mfa_token": r["mfa_token"], "code": "000000"}).status_code == 401
    step = int(time.time() // 30) + 1  # a code the enable step hasn't used yet
    ok = fresh.post("/api/auth/login/mfa", json={"mfa_token": r["mfa_token"], "code": totp.code_at(secret, step)})
    assert ok.status_code == 200 and fresh.get("/api/auth/me").status_code == 200

    # the same code can't be replayed, and the login token is single-use
    again = Api(app)
    t2 = again.post("/api/auth/login", json={"email": "mfa@example.com", "password": PASSWORD}).json()["mfa_token"]
    assert again.post("/api/auth/login/mfa", json={"mfa_token": t2, "code": totp.code_at(secret, step)}).status_code == 401
    assert fresh.post("/api/auth/login/mfa", json={"mfa_token": r["mfa_token"], "code": codes[0]}).status_code == 400
    # a recovery code works exactly once
    rc = again.post("/api/auth/login/mfa", json={"mfa_token": t2, "code": codes[0]}).json()
    assert rc["recovery_codes_left"] == 9
    from app.security.ratelimit import reset_rate_limits

    reset_rate_limits()  # 5 second-factor attempts per account per minute; this test makes more on purpose
    third = Api(app)
    t3 = third.post("/api/auth/login", json={"email": "mfa@example.com", "password": PASSWORD}).json()["mfa_token"]
    assert third.post("/api/auth/login/mfa", json={"mfa_token": t3, "code": codes[0]}).status_code == 401
    # disabling needs password + a second factor
    assert api.post("/api/account/2fa/disable", json={"password": PASSWORD, "code": "123"}).status_code == 422
    assert api.post("/api/account/2fa/disable", json={"password": PASSWORD, "code": codes[1]}).status_code == 200
    plain = Api(app).post("/api/auth/login", json={"email": "mfa@example.com", "password": PASSWORD}).json()
    assert "mfa_required" not in plain


def _second_login(app, email):
    api = Api(app)
    r = api.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200 and "mfa_required" not in r.json(), r.text
    return api


def test_two_factor_changes_sign_out_other_sessions(make_user, app):
    import time

    from app.security import totp
    from app.security.ratelimit import reset_rate_limits

    api = make_user("mfa-sessions@example.com")
    other = _second_login(app, "mfa-sessions@example.com")
    secret, codes = _enable_mfa(api)
    assert api.get("/api/auth/me").status_code == 200, "the session that turned 2FA on stays signed in"
    assert other.get("/api/auth/me").status_code == 401, "a password-only session is signed out"

    # new recovery codes also sign out other sessions
    third = Api(app)
    t = third.post("/api/auth/login", json={"email": "mfa-sessions@example.com", "password": PASSWORD}).json()["mfa_token"]
    assert third.post("/api/auth/login/mfa", json={"mfa_token": t, "code": codes[0]}).status_code == 200
    step = int(time.time() // 30) + 1
    r = api.post("/api/account/2fa/recovery-codes", json={"code": totp.code_at(secret, step)})
    assert r.status_code == 200 and r.json()["other_sessions_signed_out"] is True
    assert third.get("/api/auth/me").status_code == 401 and api.get("/api/auth/me").status_code == 200

    # and so does turning it off
    reset_rate_limits()
    fourth = Api(app)
    t = fourth.post("/api/auth/login", json={"email": "mfa-sessions@example.com", "password": PASSWORD}).json()["mfa_token"]
    new_codes = r.json()["recovery_codes"]
    assert fourth.post("/api/auth/login/mfa", json={"mfa_token": t, "code": new_codes[0]}).status_code == 200
    assert api.post("/api/account/2fa/disable", json={"password": PASSWORD, "code": new_codes[1]}).status_code == 200
    assert fourth.get("/api/auth/me").status_code == 401 and api.get("/api/auth/me").status_code == 200


def test_google_sign_in_keeps_the_second_step_token_out_of_the_url(make_user, app, monkeypatch):
    from app.api import auth as auth_api
    from app.config import get_settings

    api = make_user("g-mfa@example.com")
    _, codes = _enable_mfa(api)
    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "cid")
    monkeypatch.setattr(s, "google_client_secret", "csecret")

    class FakeGoogle:
        async def authorize_access_token(self, request):
            return {"userinfo": {"sub": "google-sub-1", "email": "g-mfa@example.com", "email_verified": True}}

    class FakeOAuth:
        google = FakeGoogle()

    monkeypatch.setattr(auth_api, "_oauth", lambda: FakeOAuth())
    browser = Api(app)
    r = browser.c.get("/api/auth/google/callback", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.endswith("/login?mfa=google") and "token" not in loc
    cookie = next(c for c in r.headers.get_list("set-cookie") if c.startswith(f"{auth_api.MFA_COOKIE}="))
    assert "HttpOnly" in cookie and f"Path={auth_api.MFA_COOKIE_PATH}" in cookie and "Max-Age=300" in cookie
    assert browser.get("/api/auth/me").status_code == 401, "no session before the second factor"
    # the login page sends only the code; the token comes from the cookie
    ok = browser.post("/api/auth/login/mfa", json={"code": codes[0]})
    assert ok.status_code == 200, ok.text
    assert browser.get("/api/auth/me").json()["email"] == "g-mfa@example.com"
    assert any(c.startswith(f"{auth_api.MFA_COOKIE}=") and "Max-Age=0" in c for c in ok.headers.get_list("set-cookie"))
    # without a token in the body or a cookie, the step fails cleanly
    assert Api(app).post("/api/auth/login/mfa", json={"code": codes[1]}).json()["detail"]["code"] == "invalid_token"


def test_staff_need_two_factor_when_enforced(make_user, monkeypatch):
    from app.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "recruiter_emails", "hr2@example.com")
    hr = make_user("hr2@example.com")
    monkeypatch.setattr(s, "require_mfa_for_staff", True)
    r = hr.get("/api/recruiter/openings")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "mfa_required"
    assert hr.get("/api/auth/me").json()["mfa_required_for_role"] is True
    _enable_mfa(hr)
    assert hr.get("/api/recruiter/openings").status_code == 200
    # candidates are unaffected
    assert make_user("cand2@example.com").get("/api/openings").status_code == 200


def test_production_requires_staff_mfa():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError, match="REQUIRE_MFA_FOR_STAFF"):
        Settings(env="production", require_mfa_for_staff=False, secret_key="x" * 40)


# ---------------------------------------------------------------- fairness


def test_self_id_is_voluntary_and_never_changes_scores(make_user, recruiter, pdf_bytes):
    o = _opening(recruiter)
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    before = api.get(f"/api/versions/{vid}/leaderboard/roles").json()["rows"]
    assert api.put("/api/account/self-id", json={"gender": "woman", "age_band": "25_34", "consent": False}).status_code == 422
    v = api.put("/api/account/self-id", json={"gender": "woman", "age_band": "25_34", "consent": True}).json()
    assert v["value"]["gender"] == "woman" and "never used to rank" in v["notice"]
    after = api.get(f"/api/versions/{vid}/leaderboard/roles").json()["rows"]
    assert [(r["role_id"], r["score"]) for r in before] == [(r["role_id"], r["score"]) for r in after]
    s = api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).json()
    assert "woman" not in json.dumps(recruiter.get(f"/api/recruiter/applications/{s['id']}").json())
    assert api.delete("/api/account/self-id").status_code == 204
    assert api.get("/api/account/self-id").json()["value"] is None


def _fairness_population(make_user, recruiter, personas, monkeypatch, groups=("man", "woman")):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "login_rate_per_minute", 1000)  # many sign-ups from one test client
    o = _opening(recruiter)
    strong, weak = render(personas["p02"], "A")[1], render(personas["p06"], "A")[1]
    ids = {}
    for i in range(12):
        for g, pdf in zip(groups, (strong, weak), strict=False):
            api = make_user(f"{g}{i}@example.com")
            _, vid = confirmed_version(api, pdf)
            api.put("/api/account/self-id", json={"gender": g, "consent": True})
            ids[f"{g}{i}"] = api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).json()["id"]
    return o, ids


@pytest.fixture
def admin(make_user, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "admin_emails", "admin@example.com")
    return make_user("admin@example.com")


@pytest.fixture
def tomorrow(monkeypatch):
    """Pretend the report is viewed tomorrow, so today's applications fall inside its snapshot."""
    from datetime import timedelta

    from app.api import recruiter as rec
    from app.models import utcnow

    monkeypatch.setattr(rec, "fairness_cutoff", lambda: utcnow() + timedelta(days=1))


def _set_stage(ids, prefix, stage):
    from app.db import SessionLocal
    from app.models import OpeningApplication

    db = SessionLocal()
    for k, aid in ids.items():
        if k.startswith(prefix):
            db.get(OpeningApplication, aid).stage = stage
    db.commit()
    db.close()


def test_fairness_report_flags_gaps_and_hides_small_groups(make_user, recruiter, admin, personas, monkeypatch, tomorrow):
    o, ids = _fairness_population(make_user, recruiter, personas, monkeypatch)
    for i in range(3):
        api = make_user(f"nb{i}@example.com")
        _, vid = confirmed_version(api, render(personas["p02"], "A")[1])
        api.put("/api/account/self-id", json={"gender": "non_binary", "consent": True})
        api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True})
    _set_stage(ids, "man", "shortlisted")
    rep = admin.get("/api/recruiter/fairness", params={"opening_id": o["id"]}).json()
    g = {x["group"]: x for x in rep["dimensions"]["gender"]["groups"]}
    assert set(g) == {"man", "woman"}  # non_binary (3 people) hidden
    assert g["woman"]["selection_rate_impact_ratio"] == 0 and g["woman"]["flags"]
    assert g["man"]["flags"] == []
    assert rep["min_group_size"] == 10
    # nothing that lets a reader count hidden or self-identified people
    assert "self_identified" not in rep and "suppressed_people" not in rep["dimensions"]["gender"]


def test_fairness_report_is_admin_only(recruiter, make_user):
    assert recruiter.get("/api/recruiter/fairness").status_code == 403
    assert make_user("nosy@example.com").get("/api/recruiter/fairness").status_code == 403


def test_fairness_report_ignores_todays_stage_changes(make_user, recruiter, admin, personas, monkeypatch):
    """Differencing attack: move one person's stage, reload, see which group's rate moved."""
    from datetime import timedelta

    from app.api import recruiter as rec
    from app.db import SessionLocal
    from app.models import OpeningApplication, utcnow

    o, ids = _fairness_population(make_user, recruiter, personas, monkeypatch)
    # applications were made "yesterday"; the report snapshot is the start of today
    db = SessionLocal()
    for aid in ids.values():
        db.get(OpeningApplication, aid).created_at = utcnow() - timedelta(days=2)
    db.commit()
    db.close()
    monkeypatch.setattr(rec, "fairness_cutoff", lambda: utcnow() - timedelta(hours=1))
    before = admin.get("/api/recruiter/fairness", params={"opening_id": o["id"]}).json()
    assert recruiter.patch(f"/api/recruiter/applications/{ids['woman3']}", json={"stage": "shortlisted"}).status_code == 200
    after = admin.get("/api/recruiter/fairness", params={"opening_id": o["id"]}).json()
    assert before["dimensions"] == after["dimensions"]


def test_fairness_report_hides_a_lone_group(make_user, recruiter, admin, personas, monkeypatch, tomorrow):
    """If everyone who self-identified is in one group, showing it would reveal each person's answer."""
    o, _ = _fairness_population(make_user, recruiter, personas, monkeypatch, groups=("woman",))
    rep = admin.get("/api/recruiter/fairness", params={"opening_id": o["id"]}).json()
    assert rep["dimensions"]["gender"]["groups"] == []


def test_counterfactual_identity_changes_do_not_change_scores(personas):
    """No personal data needed: swapping name, contact details, location, employer and school must not move scores."""
    from app.services.ml.jd import extract_jd, match
    from app.services.ml.leaderboard import role_leaderboard

    base = json.loads(json.dumps(personas["p02"]["content"]))
    alt = json.loads(json.dumps(base))
    alt["contact"].update({"name": "Priya Sharma", "email": "priya@example.com", "location": "Ahmedabad, India"})
    for e in alt["experience"]:
        e["organization"] = "Some Other Company"
    for ed in alt["education"]:
        ed["institution"] = "A Different University"
    a = [(r["role_id"], r["score"]) for r in role_leaderboard(base)["rows"]]
    b = [(r["role_id"], r["score"]) for r in role_leaderboard(alt)["rows"]]
    assert a == b
    jd = extract_jd(BACKEND_JD)
    assert match(base, jd)["overall"] == match(alt, jd)["overall"]


def test_account_deletion_covers_new_data(make_user, pdf_bytes):
    from sqlalchemy import func, select

    from app.db import SessionLocal
    from app.models import DemographicSelfId, InterviewSession, LearningItem

    api = make_user("gone@example.com")
    _, vid = confirmed_version(api, pdf_bytes)
    api.post("/api/learning", json={"skills": ["Docker"]})
    api.post(f"/api/versions/{vid}/interviews", json={})
    api.put("/api/account/self-id", json={"gender": "prefer_not", "consent": True})
    exp = api.get("/api/account/export")
    import io
    import zipfile

    names = zipfile.ZipFile(io.BytesIO(exp.content)).namelist()
    assert {"learning_plan.json", "mock_interviews.json", "self_identification.json"} <= set(names)
    assert api.post("/api/account/delete", json={"password": PASSWORD, "confirm_email": "gone@example.com"}).status_code == 200
    db = SessionLocal()
    for m in (LearningItem, InterviewSession, DemographicSelfId):
        assert db.scalar(select(func.count()).select_from(m)) == 0
    db.close()
    _ = _token_from_outbox


# ---------------------------------------------------------------- review round 1: security fixes


def test_data_export_never_contains_second_factor_secrets(make_user):
    import io
    import zipfile

    api = make_user()
    secret, _ = _enable_mfa(api)
    z = zipfile.ZipFile(io.BytesIO(api.get("/api/account/export").content))
    account = z.read("account.json").decode()
    assert secret not in account
    for col in ("totp_secret", "recovery_code_hashes", "totp_last_step", "password_hash"):
        assert col not in account


def test_password_guessing_is_limited_per_account_even_with_spoofed_ips(make_user, app, monkeypatch):
    """Each request claims a different client IP; the per-account failure limit must still apply."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "trusted_proxies", 1)
    make_user("victim@example.com")
    from fastapi.testclient import TestClient

    c = TestClient(app)
    codes = []
    for i in range(12):
        r = c.post("/api/auth/login", json={"email": "victim@example.com", "password": "wrong-password-123"},
                   headers={"X-Forwarded-For": f"203.0.113.{i}"})
        codes.append(r.status_code)
    assert codes[:10] == [401] * 10 and codes[10:] == [429, 429]
    # the right password is also refused while locked, so guessing gains nothing
    r = c.post("/api/auth/login", json={"email": "victim@example.com", "password": "x"}, headers={"X-Forwarded-For": "198.51.100.1"})
    assert r.status_code == 429


def test_reset_emails_are_capped_per_address_even_with_spoofed_ips(make_user, app, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "trusted_proxies", 1)
    make_user("target@example.com")
    c = TestClient(app)
    codes = [c.post("/api/auth/forgot-password", json={"email": "target@example.com"},
                    headers={"X-Forwarded-For": f"203.0.113.{i}"}).status_code for i in range(7)]
    assert codes[:5] == [202] * 5 and codes[5:] == [429, 429]


def test_second_factor_guessing_locks_out_and_burns_the_sign_in(make_user, app, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from tests.conftest import PASSWORD

    monkeypatch.setattr(get_settings(), "login_rate_per_minute", 1000)  # isolate the per-account limits

    api = make_user("mfa-guess@example.com")
    _enable_mfa(api)
    c = TestClient(app)
    tok = c.post("/api/auth/login", json={"email": "mfa-guess@example.com", "password": PASSWORD}).json()["mfa_token"]
    codes = [c.post("/api/auth/login/mfa", json={"mfa_token": tok, "code": f"{i:06d}"}).status_code for i in range(6)]
    # five wrong codes, then this sign-in attempt is used up and the password must be entered again
    assert codes[:5] == [401] * 5 and codes[5] == 400
    # across fresh sign-ins, the per-account limit (10 an hour) stops further guessing
    statuses = []
    for _ in range(2):
        r = c.post("/api/auth/login", json={"email": "mfa-guess@example.com", "password": PASSWORD})
        assert "mfa_token" in r.json(), (r.status_code, r.text)
        tok = r.json()["mfa_token"]
        statuses += [c.post("/api/auth/login/mfa", json={"mfa_token": tok, "code": "000000"}).status_code for _ in range(4)]
    assert 429 in statuses


def test_production_config_rejects_public_metrics_console_email_and_http():
    import pytest as _pytest
    from pydantic import ValidationError

    from app.config import Settings

    with _pytest.raises(ValidationError) as e:
        Settings(env="production", secret_key="x" * 40, public_base_url="http://example.com")
    msg = str(e.value)
    for needle in ("METRICS_TOKEN", "EMAIL_BACKEND", "RATE_LIMIT_BACKEND", "PUBLIC_BASE_URL must use https"):
        assert needle in msg


def test_real_ai_provider_requires_a_model_id():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError, match="LLM_MODEL is required"):
        Settings(llm_provider="anthropic", llm_model="")
    assert Settings(llm_provider="fixture", llm_model="").llm_provider == "fixture"
