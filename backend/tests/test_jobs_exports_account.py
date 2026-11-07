"""Background job recovery, exports, career features and account deletion."""

from __future__ import annotations

import io
from datetime import timedelta
from pathlib import Path

import pytest
from conftest import confirmed_version, upload

from app.db import SessionLocal
from app.models import ProcessingJob, Resume, utcnow
from app.services import jobs as jobs_mod
from app.services.jobs import JobError, enqueue, recover_stale_jobs, run_job

# ---------------------------------------------------------------- jobs


def test_enqueue_is_idempotent(make_user):
    make_user()
    db = SessionLocal()
    uid = db.scalars(__import__("sqlalchemy").select(__import__("app.models", fromlist=["User"]).User.id)).first()
    a = enqueue(db, user_id=uid, kind="noop", target_id="t", key="k1")
    b = enqueue(db, user_id=uid, kind="noop", target_id="t", key="k1")
    assert a.id == b.id
    db.close()


def test_retryable_failure_is_retried_then_succeeds(make_user, monkeypatch):
    make_user()
    calls = {"n": 0}

    def flaky(db, job):
        calls["n"] += 1
        if calls["n"] < 3:
            raise JobError("transient", "temporary", retryable=True)

    monkeypatch.setitem(jobs_mod.HANDLERS, "flaky", flaky)
    db = SessionLocal()
    from sqlalchemy import select

    from app.models import User
    uid = db.scalar(select(User.id))
    job = enqueue(db, user_id=uid, kind="flaky", target_id="t", key="flaky1", max_attempts=3)
    assert run_job(job.id) == "retry"  # attempt 1 fails -> re-dispatched eagerly -> attempt 2 fails -> attempt 3 ok
    db.expire_all()
    j = db.get(ProcessingJob, job.id)
    assert j.status == "succeeded" and j.attempts == 3 and calls["n"] == 3
    db.close()


def test_bounded_retries_end_in_failed(make_user, monkeypatch):
    make_user()
    monkeypatch.setitem(jobs_mod.HANDLERS, "always", lambda db, job: (_ for _ in ()).throw(JobError("boom", "x", retryable=True)))
    db = SessionLocal()
    from sqlalchemy import select

    from app.models import User
    job = enqueue(db, user_id=db.scalar(select(User.id)), kind="always", target_id="t", key="always1", max_attempts=2)
    run_job(job.id)
    db.expire_all()
    j = db.get(ProcessingJob, job.id)
    assert j.status == "failed" and j.attempts == 2 and j.error_code == "boom"
    assert run_job(job.id) == "skipped"  # terminal jobs are never re-run implicitly
    db.close()


def test_crashed_worker_lease_is_recovered(make_user, pdf_bytes, monkeypatch):
    api = make_user()
    from app.config import get_settings

    # simulate the broker accepting the job but the worker dying mid-parse
    monkeypatch.setattr(get_settings(), "task_always_eager", False)
    monkeypatch.setattr(jobs_mod, "dispatch", lambda job_id, countdown=0: None)
    import app.api.resumes as res_api
    monkeypatch.setattr(res_api, "dispatch", lambda job_id, countdown=0: None)
    rid = upload(api, pdf_bytes).json()["id"]
    db = SessionLocal()
    job = db.query(ProcessingJob).filter_by(target_id=rid).one()
    job.status, job.attempts, job.lease_expires_at = "running", 1, utcnow() - timedelta(minutes=1)
    db.commit()
    monkeypatch.setattr(get_settings(), "task_always_eager", True)
    monkeypatch.setattr(jobs_mod, "dispatch", lambda job_id, countdown=0: run_job(job_id))
    assert recover_stale_jobs(db) == 1
    db.expire_all()
    assert db.get(ProcessingJob, job.id).status == "succeeded"
    assert db.get(Resume, rid).status == "needs_review"
    db.close()


def test_concurrent_claim_runs_once(make_user, monkeypatch):
    make_user()
    ran = []
    monkeypatch.setitem(jobs_mod.HANDLERS, "once", lambda db, job: ran.append(job.id))
    db = SessionLocal()
    from sqlalchemy import select

    from app.models import User
    job = enqueue(db, user_id=db.scalar(select(User.id)), kind="once", target_id="t", key="once1")
    assert run_job(job.id) == "succeeded"
    assert run_job(job.id) == "skipped"
    assert ran == [job.id]
    db.close()


def test_user_retry_of_failed_parse(make_user, pdf_bytes, monkeypatch):
    api = make_user()
    import app.services.pipeline as pipe
    from app.services.parsing.parsers import ParseError

    real = pipe.parse_isolated
    monkeypatch.setattr(pipe, "parse_isolated", lambda kind, data: (_ for _ in ()).throw(ParseError("parse_timeout", "slow")))
    r = upload(api, pdf_bytes).json()
    st = api.get(f"/api/resumes/{r['id']}").json()
    assert st["status"] == "failed" and st["job"]["error_code"] == "parse_timeout"
    monkeypatch.setattr(pipe, "parse_isolated", real)
    rr = api.post(f"/api/processing-jobs/{st['job']['id']}/retry")
    assert rr.status_code == 200
    assert api.get(f"/api/resumes/{r['id']}").json()["status"] == "needs_review"


def test_parser_timeout_in_sandbox(pdf_bytes):
    from app.services.parsing.parsers import ParseError
    from app.services.parsing.sandbox import parse_isolated

    with pytest.raises(ParseError) as e:
        parse_isolated("pdf", pdf_bytes, in_process=False, timeout=0.001)
    assert e.value.code == "parse_timeout"


# ---------------------------------------------------------------- exports


@pytest.mark.parametrize("template", ["student", "professional", "technical"])
@pytest.mark.parametrize("page_size", ["A4", "LETTER"])
def test_pdf_export_has_selectable_text_and_page_size(make_user, pdf_bytes, template, page_size):
    import pdfplumber

    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    e = api.post(f"/api/resumes/{rid}/exports", json={"format": "pdf", "template": template, "page_size": page_size}).json()
    assert e["status"] == "ready" and e["version_id"] == vid
    data = api.get(api.get(f"/api/exports/{e['id']}/link").json()["url"]).content
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        text = "\n".join(p.extract_text() or "" for p in pdf.pages)
        w, h = pdf.pages[0].width, pdf.pages[0].height
        meta = pdf.metadata
    assert "Bluebonnet Logistics" in text and "Marcus Bell" in text and "FastAPI" in text
    assert (round(w), round(h)) == ((595, 842) if page_size == "A4" else (612, 792))
    assert meta.get("Title", "").startswith("Resume")


def test_docx_export_and_placeholder_detection(make_user, pdf_bytes):
    from docx import Document

    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    c = api.get(f"/api/versions/{vid}").json()["content"]
    c["experience"][0]["bullets"][0]["text"] = "Designed REST APIs [ADD: number of users]."
    v2 = api.post(f"/api/resumes/{rid}/versions", json={"base_version_id": vid, "content": c}).json()
    e = api.post(f"/api/resumes/{rid}/exports", json={"format": "docx", "template": "technical"}).json()
    assert e["version_id"] == v2["id"]  # always the latest saved version
    assert e["unresolved_placeholders"] and e["unresolved_placeholders"][0]["placeholder"] == "[ADD: number of users]"
    data = api.get(api.get(f"/api/exports/{e['id']}/link").json()["url"]).content
    doc = Document(io.BytesIO(data))
    full = "\n".join(p.text for p in doc.paragraphs)
    assert "[ADD: number of users]" in full and "Bluebonnet Logistics" in full
    highlighted = [r for p in doc.paragraphs for r in p.runs if r.font.highlight_color is not None]
    assert any("[ADD:" in r.text for r in highlighted)


def test_long_resume_paginates(make_user, personas):
    import json as _json

    from conftest import text_to_pdf

    from eval.synthetic import render_text

    content = _json.loads(_json.dumps(personas["p04"]["content"]))
    content["experience"][0]["bullets"] = [f"Delivered infrastructure improvement number {i} across services." for i in range(35)]
    api = make_user()
    rid, vid = confirmed_version(api, text_to_pdf(render_text(content)))
    e = api.post(f"/api/resumes/{rid}/exports", json={"format": "pdf", "template": "professional"}).json()
    assert e["page_count"] >= 2


# ---------------------------------------------------------------- career


def test_roadmap_and_integrations_unavailable_state(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    r = api.get(f"/api/career/roadmap/{vid}", params={"roles": ["mlops_engineer"]}).json()
    assert r["status"] == "ok" and r["steps"] and r["portfolio_projects"]
    assert all(s["resources"]["status"] == "unavailable" for s in r["steps"])
    jl = api.get("/api/career/job-listings").json()
    assert jl["status"] == "unavailable" and "never generated" in jl["message"]


def test_curated_resources_require_source_and_date(make_user, pdf_bytes, tmp_path, monkeypatch):
    import json as _json

    from app.config import get_settings

    f = tmp_path / "res.json"
    f.write_text(_json.dumps([
        {"skill": "Kubernetes", "title": "Kubernetes docs", "url": "https://kubernetes.io/docs/", "source": "kubernetes.io", "retrieved_on": "2026-10-01"},
        {"skill": "Kubernetes", "title": "No date", "url": "https://example.com"},
    ]))
    monkeypatch.setattr(get_settings(), "learning_resources_provider", "curated_file")
    monkeypatch.setattr(get_settings(), "learning_resources_file", str(f))
    api = make_user()
    r = api.get("/api/career/resources", params={"skill": "Kubernetes"}).json()
    assert r["status"] == "ok" and len(r["resources"]) == 1 and r["resources"][0]["retrieved_on"] == "2026-10-01"


def test_interview_questions_and_grounded_cover_letter(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    jd = api.post("/api/job-descriptions", json={"text": "Backend Engineer\nCompany: Acme Corp\nRequirements\n- Python\n- Kubernetes\n- 2+ years of experience"}).json()
    iq = api.post("/api/career/interview-questions", json={"version_id": vid, "jd_id": jd["id"]}).json()
    assert iq["content"]["questions"] and iq["is_fixture"]
    cl = api.post("/api/career/cover-letter", json={"version_id": vid, "jd_id": jd["id"]}).json()
    assert cl["kind"] == "cover_letter" and cl["content"]["paragraphs"]
    assert "grounding" in cl["content"]


def test_application_tracker_crud(make_user, pdf_bytes):
    api = make_user()
    _, vid = confirmed_version(api, pdf_bytes)
    a = api.post("/api/applications", json={"company": "Acme", "role": "Backend Dev", "status": "applied", "applied_on": "2026-10-01",
                                            "resume_version_id": vid, "url": "https://acme.example/jobs/1"}).json()
    assert a["status"] == "applied" and a["resume_version_id"] == vid
    assert api.post("/api/applications", json={"company": "A", "role": "B", "applied_on": "01/10/2026"}).status_code == 422
    assert api.post("/api/applications", json={"company": "A", "role": "B", "url": "javascript:alert(1)"}).status_code == 422
    u = api.patch(f"/api/applications/{a['id']}", json={"status": "interviewing", "notes": "Phone screen Tue"}).json()
    assert u["status"] == "interviewing" and u["company"] == "Acme"
    assert api.delete(f"/api/applications/{a['id']}").status_code == 204
    assert api.get("/api/applications").json() == []


# ---------------------------------------------------------------- account deletion & export


def test_account_deletion_removes_files_and_derived_data(make_user, pdf_bytes):
    from sqlalchemy import func, select

    from app import models as m
    from app.config import get_settings

    api = make_user("del@example.com")
    other = make_user("keep@example.com")
    rid, vid = confirmed_version(api, pdf_bytes)
    _, ovid = confirmed_version(other, pdf_bytes)
    api.get(f"/api/versions/{vid}/analysis")
    api.post(f"/api/versions/{vid}/recommendations", json={})
    jd = api.post("/api/job-descriptions", json={"text": "Engineer role\nRequirements\n- Python\n- SQL and PostgreSQL experience"}).json()
    api.post(f"/api/job-descriptions/{jd['id']}/match/{vid}")
    api.post(f"/api/versions/{vid}/suggestions", json={"operation": "grammar", "target_path": "summary"})
    api.post(f"/api/resumes/{rid}/exports", json={"format": "pdf"})
    api.post("/api/applications", json={"company": "A", "role": "B", "resume_version_id": vid})
    storage_root = Path(get_settings().local_storage_path)
    me = api.get("/api/auth/me").json()
    assert any(storage_root.joinpath("users", me["id"]).rglob("*"))

    assert api.post("/api/account/delete", json={"confirm_email": "wrong@example.com", "password": "x"}).status_code == 400
    from conftest import PASSWORD
    r = api.post("/api/account/delete", json={"confirm_email": "del@example.com", "password": PASSWORD})
    assert r.status_code == 200 and r.json()["resumes"] == 1

    db = SessionLocal()
    for model in (m.Resume, m.ResumeVersion, m.Extraction, m.Analysis, m.RoleRecommendation, m.JDMatch, m.JobDescription,
                  m.AISuggestion, m.Export, m.Application, m.CareerArtifact, m.UserSession, m.AuthToken):
        assert db.scalar(select(func.count()).select_from(model).where(model.user_id == me["id"])) == 0, model.__name__
    assert db.scalar(select(func.count()).select_from(m.User).where(m.User.id == me["id"])) == 0
    # audit trail keeps a content-free record
    logs = db.scalars(select(m.AuditLog).where(m.AuditLog.user_id == me["id"])).all()
    assert any(lg.action == "account.deleted" for lg in logs)
    assert all("Bluebonnet" not in str(lg.meta) for lg in logs)
    db.close()
    assert not storage_root.joinpath("users", me["id"]).exists() or not any(storage_root.joinpath("users", me["id"]).rglob("*.pdf"))
    assert api.get("/api/auth/me").status_code == 401
    # the other user is untouched
    assert other.get(f"/api/versions/{ovid}").status_code == 200


def test_data_export_contains_records_and_original(make_user, pdf_bytes):
    import zipfile

    api = make_user()
    confirmed_version(api, pdf_bytes)
    r = api.get("/api/account/export")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "versions.json" in names and any(n.startswith("uploads/") for n in names)
    assert "password_hash" not in z.read("account.json").decode()
    up = next(n for n in names if n.startswith("uploads/"))
    assert z.read(up) == pdf_bytes


def test_health_and_metrics(make_user):
    api = make_user()
    assert api.get("/api/health/live").json() == {"status": "ok"}
    r = api.get("/api/health/ready").json()
    assert r["checks"]["database"] == "ok"
    m = api.get("/api/metrics")
    assert m.status_code == 200 and "ri_http_requests_total" in m.text


def test_openapi_documents_core_routes(app):
    spec = app.openapi()
    for path in ("/api/resumes", "/api/versions/{version_id}/analysis", "/api/suggestions/{suggestion_id}/accept",
                 "/api/job-descriptions/{jd_id}/match/{version_id}", "/api/account/delete"):
        assert path in spec["paths"], path
