from __future__ import annotations

from conftest import PASSWORD, Api, _token_from_outbox


def test_register_sets_httponly_session_and_requires_verification(app):
    api = Api(app)
    r = api.post("/api/auth/register", json={"email": "a@example.com", "password": PASSWORD})
    assert r.status_code == 201
    cookies = r.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookies if c.startswith("ri_session="))
    assert "HttpOnly" in session_cookie and "SameSite=lax" in session_cookie
    assert r.json()["email_verified"] is False
    # unverified users cannot upload
    r = api.post("/api/resumes", files={"file": ("r.pdf", b"%PDF-1.4", "application/pdf")})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "email_not_verified"


def test_weak_password_rejected(app):
    r = Api(app).post("/api/auth/register", json={"email": "b@example.com", "password": "short"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "weak_password"


def test_login_logout_and_invalid_credentials(make_user, app):
    make_user("c@example.com")
    api = Api(app)
    assert api.post("/api/auth/login", json={"email": "c@example.com", "password": "wrong-password-1"}).status_code == 401
    assert api.post("/api/auth/login", json={"email": "C@Example.com", "password": PASSWORD}).status_code == 200
    assert api.get("/api/auth/me").json()["email"] == "c@example.com"
    assert api.post("/api/auth/logout").status_code == 204
    assert api.get("/api/auth/me").status_code == 401


def test_verification_token_single_use(app):
    api = Api(app)
    api.post("/api/auth/register", json={"email": "d@example.com", "password": PASSWORD})
    tok = _token_from_outbox("d@example.com", "verify-email")
    assert api.post("/api/auth/verify-email", json={"token": tok}).status_code == 200
    assert api.post("/api/auth/verify-email", json={"token": tok}).status_code == 400


def test_password_reset_flow_revokes_sessions_and_no_enumeration(make_user, app):
    old = make_user("e@example.com")
    anon = Api(app)
    r1 = anon.post("/api/auth/forgot-password", json={"email": "e@example.com"})
    r2 = anon.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
    assert r1.status_code == r2.status_code == 202 and r1.json() == r2.json()
    tok = _token_from_outbox("e@example.com", "reset-password")
    new_pw = "Another-strong-77"
    assert anon.post("/api/auth/reset-password", json={"token": tok, "password": new_pw}).status_code == 200
    assert old.get("/api/auth/me").status_code == 401  # old session revoked
    assert anon.post("/api/auth/login", json={"email": "e@example.com", "password": new_pw}).status_code == 200
    assert anon.post("/api/auth/reset-password", json={"token": tok, "password": new_pw}).status_code == 400


def test_csrf_required_for_authenticated_unsafe_requests(make_user):
    api = make_user("f@example.com")
    r = api.c.patch("/api/account/settings", json={"display_name": "X"})  # no CSRF header
    assert r.status_code == 403 and r.json()["detail"]["code"] == "csrf_failed"
    r = api.patch("/api/account/settings", json={"display_name": "X"})
    assert r.status_code == 200 and r.json()["display_name"] == "X"


def test_login_rate_limited(make_user, app):
    make_user("g@example.com")
    api = Api(app)
    codes = [api.post("/api/auth/login", json={"email": "g@example.com", "password": "bad-password-9"}).status_code for _ in range(12)]
    assert 429 in codes


def test_admin_permissions(make_user):
    user = make_user("h@example.com")
    assert user.get("/api/admin/overview").status_code == 403
    admin = make_user("admin@example.com")  # in ADMIN_EMAILS, promoted on verification
    r = admin.get("/api/admin/overview")
    assert r.status_code == 200
    assert "versions" in r.json() and "llm_7d" in r.json()


def test_security_headers(make_user):
    api = make_user("i@example.com")
    r = api.get("/api/auth/me")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "no-store" in r.headers["cache-control"]


def test_admin_overview_aggregates_usage_and_failures(make_user, pdf_bytes):
    from conftest import confirmed_version

    admin = make_user("admin@example.com")
    _, vid = confirmed_version(admin, pdf_bytes)
    admin.post(f"/api/versions/{vid}/suggestions", json={"operation": "grammar", "target_path": "summary"})
    admin.post("/api/resumes", files={"file": ("r.pdf", b"%PDF-1.4 not really a pdf at all", "application/pdf")})
    r = admin.get("/api/admin/overview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["llm_7d"][0]["provider"] == "fixture" and body["llm_7d"][0]["calls"] >= 1 and body["llm_7d"][0]["failures"] == 0
    assert body["resumes"]["total"] >= 1
    assert admin.get("/api/admin/jobs").status_code == 200
    assert admin.get("/api/admin/audit").status_code == 200
    # audit records never contain resume content
    assert "Bluebonnet" not in admin.get("/api/admin/audit").text
