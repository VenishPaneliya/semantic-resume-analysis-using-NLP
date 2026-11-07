from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import err, get_owned, verified_user
from app.db import get_db
from app.models import ProcessingJob, User
from app.security.ratelimit import enforce
from app.services.jobs import retry_failed

router = APIRouter(prefix="/api/processing-jobs", tags=["resumes"])


def out(j: ProcessingJob) -> dict:
    return {"id": j.id, "kind": j.kind, "target_id": j.target_id, "status": j.status, "stage": j.stage, "progress": j.progress,
            "attempts": j.attempts, "max_attempts": j.max_attempts, "error_code": j.error_code, "error_message": j.error_message,
            "created_at": j.created_at.isoformat(), "finished_at": j.finished_at.isoformat() if j.finished_at else None}


@router.get("/{job_id}")
def get_job(job_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    return out(get_owned(db, ProcessingJob, job_id, user))


@router.post("/{job_id}/retry")
def retry(job_id: str, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    j = get_owned(db, ProcessingJob, job_id, user)
    if j.status != "failed":
        raise err(409, "not_failed", "Only failed jobs can be retried.")
    enforce(f"retry:{user.id}", 10, 3600)
    return out(retry_failed(db, j))
