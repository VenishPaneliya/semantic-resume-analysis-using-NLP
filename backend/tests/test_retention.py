"""Nightly retention sweep: activity-based resume retention, open applications, unverified accounts,
processing-job purge and batched commits; plus the per-task worker time limits."""

from __future__ import annotations

from datetime import timedelta

import pytest
from conftest import confirmed_version
from sqlalchemy import select, update

from app.db import SessionLocal
from app.models import ProcessingJob, Resume, ResumeVersion, User, utcnow
from app.services.pipeline import retention_sweep


def _age_resume(db, rid: str, days: int, *, versions_too: bool = True) -> None:
    """Make a resume look uploaded (and, optionally, last edited) `days` ago, with retention due."""
    past = utcnow() - timedelta(days=days)
    db.execute(update(Resume).where(Resume.id == rid).values(created_at=past, updated_at=past,
                                                            retention_until=utcnow() - timedelta(days=1)))
    if versions_too:
        db.execute(update(ResumeVersion).where(ResumeVersion.resume_id == rid).values(created_at=past))
    db.execute(update(ProcessingJob).where(ProcessingJob.target_id == rid).values(created_at=past, updated_at=past,
                                                                                  finished_at=past))
    db.commit()


def test_resume_retention_counts_from_last_activity(make_user, pdf_bytes):
    api = make_user()
    idle, _ = confirmed_version(api, pdf_bytes)
    used, vid = confirmed_version(api, pdf_bytes)
    db = SessionLocal()
    _age_resume(db, idle, 400)
    _age_resume(db, used, 400)
    # the second resume was edited 10 days ago
    db.execute(update(ResumeVersion).where(ResumeVersion.id == vid).values(created_at=utcnow() - timedelta(days=10)))
    db.commit()
    out = retention_sweep(db)
    assert out["resumes"] == 1 and out["resumes_kept_in_use"] == 1
    assert db.get(Resume, idle) is None
    kept = db.get(Resume, used, populate_existing=True)
    assert kept is not None and kept.retention_until > utcnow() + timedelta(days=350)
    db.close()
    assert api.get(f"/api/resumes/{used}").status_code == 200


def test_new_version_pushes_retention_forward(make_user, pdf_bytes):
    api = make_user()
    rid, vid = confirmed_version(api, pdf_bytes)
    db = SessionLocal()
    db.execute(update(Resume).where(Resume.id == rid).values(retention_until=utcnow() + timedelta(days=5)))
    db.commit()
    content = api.get(f"/api/versions/{vid}").json()["content"]
    content["summary"] = "Backend engineer focused on reliable APIs."
    r = api.post(f"/api/resumes/{rid}/versions", json={"base_version_id": vid, "content": content, "label": "edit"})
    assert r.status_code in (200, 201), r.text
    assert db.get(Resume, rid, populate_existing=True).retention_until > utcnow() + timedelta(days=360)
    db.close()


def test_resume_with_an_open_application_is_never_deleted(make_user, pdf_bytes, monkeypatch):
    from test_leaderboard import BACKEND_JD

    from app.config import get_settings
    from app.models import OpeningApplication

    monkeypatch.setattr(get_settings(), "recruiter_emails", "hr@example.com")
    hr = make_user("hr@example.com")
    o = hr.post("/api/recruiter/openings", json={"title": "Backend Developer", "company": "Acme", "description": BACKEND_JD}).json()
    api = make_user("cand@example.com")
    rid, vid = confirmed_version(api, pdf_bytes)
    assert api.post(f"/api/openings/{o['id']}/apply", json={"version_id": vid, "share_consent": True}).status_code == 201
    db = SessionLocal()
    _age_resume(db, rid, 800)
    db.execute(update(OpeningApplication).values(created_at=utcnow() - timedelta(days=800),
                                                 updated_at=utcnow() - timedelta(days=800)))
    db.commit()
    out = retention_sweep(db)
    assert out["resumes"] == 0 and out["resumes_kept_in_use"] == 1
    assert db.get(Resume, rid, populate_existing=True).retention_until > utcnow()
    # once the opening is closed, an idle resume follows the normal rule again
    assert hr.patch(f"/api/recruiter/openings/{o['id']}", json={"status": "closed"}).status_code == 200
    _age_resume(db, rid, 800)
    db.execute(update(OpeningApplication).values(updated_at=utcnow() - timedelta(days=800)))
    db.commit()
    assert retention_sweep(db)["resumes"] == 1
    assert db.get(Resume, rid) is None
    db.close()


def test_unverified_accounts_are_deleted_after_the_retention_period(make_user):
    make_user("old-unverified@example.com", verify=False)
    make_user("new-unverified@example.com", verify=False)
    make_user("old-verified@example.com")
    db = SessionLocal()
    old = utcnow() - timedelta(days=31)
    db.execute(update(User).where(User.email.in_(["old-unverified@example.com", "old-verified@example.com"]))
               .values(created_at=old))
    db.commit()
    assert retention_sweep(db)["unverified_accounts"] == 1
    emails = set(db.scalars(select(User.email)))
    assert emails == {"new-unverified@example.com", "old-verified@example.com"}
    db.close()


def test_finished_processing_jobs_are_purged(make_user, pdf_bytes, monkeypatch):
    from app.services import pipeline
    from app.services.jobs import JobError

    api = make_user()
    ok_rid, _ = confirmed_version(api, pdf_bytes)

    def broken(*a, **k):
        raise JobError("corrupted_pdf", "bad")

    monkeypatch.setattr(pipeline, "parse_isolated", broken)
    bad = api.post("/api/resumes", files={"file": ("r.pdf", pdf_bytes, "application/pdf")}).json()
    assert bad["status"] == "failed"
    db = SessionLocal()
    old = utcnow() - timedelta(days=40)
    db.execute(update(ProcessingJob).values(finished_at=old, updated_at=old))
    db.commit()
    assert retention_sweep(db)["processing_jobs"] == 1
    left = list(db.scalars(select(ProcessingJob)))
    assert [j.target_id for j in left] == [bad["id"]], "a failed parse stays retryable while its resume exists"
    db.close()
    assert api.get(f"/api/resumes/{ok_rid}").json()["job"] is None
    assert api.get(f"/api/resumes/{bad['id']}").json()["job"]["status"] == "failed"


def test_sweep_commits_in_batches(make_user, pdf_bytes, monkeypatch):
    import app.services.account as account

    api = make_user()
    rids = [confirmed_version(api, pdf_bytes)[0] for _ in range(3)]
    db = SessionLocal()
    for rid in rids:
        _age_resume(db, rid, 400)
    real = account.delete_resume
    calls = []

    def flaky(db_, r):
        calls.append(r.id)
        if len(calls) == 3:
            raise RuntimeError("worker stopped")
        real(db_, r)

    monkeypatch.setattr(account, "delete_resume", flaky)
    with pytest.raises(RuntimeError):
        retention_sweep(db, batch_size=1)
    db.rollback()
    remaining = set(db.scalars(select(Resume.id)))
    assert len(remaining) == 1, "the two finished batches stay deleted"
    monkeypatch.setattr(account, "delete_resume", real)
    assert retention_sweep(db)["resumes"] == 1
    db.close()


def test_worker_tasks_have_their_own_time_limits():
    from app.worker import tasks
    from app.worker.celery_app import celery_app

    assert tasks.retention_task.soft_time_limit >= 30 * 60 and tasks.retention_task.time_limit > tasks.retention_task.soft_time_limit
    assert tasks.queue_depth_task.time_limit <= 60
    assert tasks.opening_alerts_task.time_limit > celery_app.conf.task_time_limit
    # parse/export jobs keep the global limit sized for one sandboxed parse
    assert tasks.run_job_task.time_limit == celery_app.conf.task_time_limit < 5 * 60


def test_nightly_refresh_of_stale_openings_is_scheduled_and_commits(make_user, monkeypatch):
    from test_leaderboard import BACKEND_JD

    from app.config import get_settings
    from app.models import JobOpening
    from app.worker import tasks
    from app.worker.celery_app import celery_app

    sched = {v["task"] for v in celery_app.conf.beat_schedule.values()}
    assert "ri.refresh_stale_openings" in sched and tasks.refresh_stale_openings_task.soft_time_limit
    monkeypatch.setattr(get_settings(), "recruiter_emails", "hr@example.com")
    hr = make_user("hr@example.com")
    o = hr.post("/api/recruiter/openings", json={"title": "Backend Developer", "company": "Acme", "description": BACKEND_JD}).json()
    db = SessionLocal()
    row = db.get(JobOpening, o["id"])
    row.extracted = {**row.extracted, "matcher_version": "0.0.0-old"}
    db.commit()
    db.close()
    out = tasks.refresh_stale_openings_task.run()
    assert out["openings"] == 1
    db = SessionLocal()  # a fresh session sees the committed result
    assert db.get(JobOpening, o["id"]).extracted.get("matcher_version") != "0.0.0-old"
    db.close()
