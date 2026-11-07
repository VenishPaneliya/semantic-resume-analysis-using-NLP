"""Every user-owned resource must be invisible and immutable to other users."""

from __future__ import annotations

from conftest import confirmed_version


def test_cross_user_isolation_for_every_resource(make_user, pdf_bytes):
    alice = make_user("alice@example.com")
    bob = make_user("bob@example.com")
    rid, vid = confirmed_version(alice, pdf_bytes)
    jd = alice.post("/api/job-descriptions", json={"text": "Backend Developer\nRequirements\n- Python and SQL\n- 2+ years of experience building REST APIs"}).json()
    sug = alice.post(f"/api/versions/{vid}/suggestions", json={"operation": "grammar", "target_path": "summary"}).json()
    exp = alice.post(f"/api/resumes/{rid}/exports", json={"format": "pdf"}).json()
    app_row = alice.post("/api/applications", json={"company": "Acme", "role": "Dev", "resume_version_id": vid}).json()
    job_id = alice.get(f"/api/resumes/{rid}").json()["job"]["id"]

    reads = [
        f"/api/resumes/{rid}", f"/api/resumes/{rid}/extraction", f"/api/resumes/{rid}/versions", f"/api/resumes/{rid}/original-link",
        f"/api/versions/{vid}", f"/api/versions/{vid}/analysis", f"/api/versions/{vid}/suggestions", f"/api/versions/{vid}/skill-gap",
        f"/api/job-descriptions/{jd['id']}", f"/api/exports/{exp['id']}", f"/api/exports/{exp['id']}/link",
        f"/api/processing-jobs/{job_id}", f"/api/career/roadmap/{vid}",
    ]
    for url in reads:
        r = bob.get(url)
        assert r.status_code == 404, (url, r.status_code)

    writes = [
        ("post", f"/api/versions/{vid}/recommendations", {}),
        ("post", f"/api/versions/{vid}/restore", None),
        ("post", f"/api/resumes/{rid}/versions", {"base_version_id": vid, "content": {}}),
        ("post", f"/api/versions/{vid}/suggestions", {"operation": "grammar", "target_path": "summary"}),
        ("post", f"/api/suggestions/{sug['id']}/accept", {}),
        ("post", f"/api/suggestions/{sug['id']}/reject", None),
        ("post", f"/api/job-descriptions/{jd['id']}/match/{vid}", None),
        ("post", f"/api/resumes/{rid}/exports", {"format": "pdf"}),
        ("post", f"/api/resumes/{rid}/variants", {"title": "x"}),
        ("patch", f"/api/applications/{app_row['id']}", {"notes": "hijack"}),
        ("delete", f"/api/applications/{app_row['id']}", None),
        ("delete", f"/api/job-descriptions/{jd['id']}", None),
        ("delete", f"/api/resumes/{rid}", None),
        ("post", "/api/career/cover-letter", {"version_id": vid}),
        ("post", "/api/career/interview-questions", {"version_id": vid}),
    ]
    for method, url, body in writes:
        r = getattr(bob, method)(url, **({"json": body} if body is not None else {}))
        assert r.status_code in (404, 422), (method, url, r.status_code, r.text[:200])
        assert r.status_code == 404 or url.endswith("/versions"), (method, url, r.status_code)

    # Bob cannot attach Alice's version to his own application
    r = bob.post("/api/applications", json={"company": "X", "role": "Y", "resume_version_id": vid})
    assert r.status_code == 404
    # lists are scoped
    assert bob.get("/api/resumes").json() == []
    assert bob.get("/api/job-descriptions").json() == []
    assert bob.get("/api/applications").json() == []
    # Alice still has everything
    assert alice.get(f"/api/resumes/{rid}").status_code == 200
    assert len(alice.get("/api/applications").json()) == 1


def test_compare_across_users_is_rejected(make_user, pdf_bytes):
    alice = make_user("alice@example.com")
    bob = make_user("bob@example.com")
    _, va = confirmed_version(alice, pdf_bytes)
    _, vb = confirmed_version(bob, pdf_bytes)
    assert bob.get(f"/api/versions/{vb}/compare/{va}").status_code == 404
    assert alice.get(f"/api/versions/{va}/compare/{vb}").status_code == 404
