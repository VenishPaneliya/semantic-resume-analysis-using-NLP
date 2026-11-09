"""Job alerts: email opted-in candidates when a newly posted (or reopened) opening matches their resume
strongly. Opt-in only; one alert per user per opening; the score is the same compatibility indicator
the candidate sees in the app."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import JobAlertSent, JobOpening, Resume, ResumeVersion, User
from app.observability import get_logger
from app.services.email import send_email
from app.services.ml.jd import match

log = get_logger("alerts")
DEFAULT_MIN_SCORE = 60


def alert_prefs(user: User) -> dict:
    p = user.notification_prefs or {}
    return {"enabled": bool(p.get("job_alerts", False)),
            "min_score": int(p.get("job_alert_min_score", DEFAULT_MIN_SCORE)),
            "resume_id": p.get("job_alert_resume_id")}


def alert_version(db: Session, user: User, resume_id: str | None) -> ResumeVersion | None:
    """The chosen resume's latest version, else the user's most recently updated confirmed resume."""
    q = select(Resume).where(Resume.user_id == user.id)
    resumes = [db.get(Resume, resume_id)] if resume_id else list(db.scalars(q.order_by(Resume.updated_at.desc())))
    for r in resumes:
        if r is None or r.user_id != user.id:
            continue
        v = db.scalar(select(ResumeVersion).where(ResumeVersion.resume_id == r.id).order_by(ResumeVersion.number.desc()))
        if v:
            return v
    return None


def send_opening_alerts(db: Session, opening_id: str) -> dict:
    o = db.get(JobOpening, opening_id)
    if not o or o.status != "open" or o.is_demo:
        return {"sent": 0, "skipped": "not_open_or_demo"}
    base = get_settings().public_base_url
    sent = checked = 0
    for user in db.scalars(select(User).where(User.is_active.is_(True), User.email_verified_at.is_not(None))):
        prefs = alert_prefs(user)
        if not prefs["enabled"]:
            continue
        if db.scalar(select(JobAlertSent).where(JobAlertSent.user_id == user.id, JobAlertSent.opening_id == o.id)):
            continue
        v = alert_version(db, user, prefs["resume_id"])
        if not v:
            continue
        checked += 1
        score = match(v.content, o.extracted)["overall"]
        if score is None or score < prefs["min_score"]:
            continue
        db.add(JobAlertSent(user_id=user.id, opening_id=o.id, score=float(score)))
        db.commit()  # record first so a retry never double-sends
        send_email(
            user.email,
            f"New opening that matches your resume: {o.title}",
            f"A new opening was posted that scores {score} for your resume (your alert threshold is {prefs['min_score']}).\n\n"
            f"{o.title} — {o.company}{' · ' + o.location if o.location else ''}\n\n"
            f"See the full match and apply: {base}/openings/{o.id}?resume={v.resume_id}\n\n"
            "The score is a compatibility indicator, not a hiring probability.\n"
            f"Turn job alerts off or change the threshold: {base}/settings",
        )
        sent += 1
    log.info("alerts.sent", opening_id=o.id, sent=sent, checked=checked)
    return {"sent": sent, "checked": checked}


def queue_opening_alerts(db: Session, o: JobOpening) -> None:
    """Run in the worker (inline when TASK_ALWAYS_EAGER). Alert failures never break posting."""
    s = get_settings()
    try:
        if s.task_always_eager:
            send_opening_alerts(db, o.id)
        else:  # pragma: no cover - needs broker
            from app.worker.celery_app import celery_app

            celery_app.send_task("ri.opening_alerts", args=[o.id])
    except Exception as exc:  # noqa: BLE001
        log.warning("alerts.queue_failed", opening_id=o.id, error=type(exc).__name__)
