from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import AuditLog
from app.security.crypto import keyed_hash

# meta keys allowed in audit records; everything else is dropped so resume content can
# never leak into the audit trail by accident.
_ALLOWED_META = {"reason", "format", "template", "count", "status", "operation", "provider", "role", "kind"}


def audit(
    db: Session,
    action: str,
    user_id: str | None,
    target_type: str | None = None,
    target_id: str | None = None,
    ip: str | None = None,
    **meta,
) -> None:
    safe = {k: (str(v)[:80] if not isinstance(v, int | float | bool) else v) for k, v in meta.items() if k in _ALLOWED_META}
    db.add(
        AuditLog(
            user_id=user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            ip_hash=keyed_hash(ip) if ip else None,
            meta=safe,
        )
    )
