"""Version history and edit targeting. History is append-only: edits, accepted AI
suggestions and restores all create new versions; nothing is overwritten, and the original
upload is never modified."""

from __future__ import annotations

import difflib
import json
import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Resume, ResumeVersion
from app.schemas.resume import ResumeContent
from app.security.crypto import sha256_hex


class TargetError(ValueError):
    pass


def content_hash(content: dict) -> str:
    return sha256_hex(json.dumps(content, sort_keys=True, ensure_ascii=False))


def latest_version(db: Session, resume_id: str) -> ResumeVersion | None:
    return db.scalar(select(ResumeVersion).where(ResumeVersion.resume_id == resume_id).order_by(ResumeVersion.number.desc()).limit(1))


def create_version(
    db: Session, resume: Resume, content: ResumeContent | dict, *, source: str, label: str | None = None,
    parent_id: str | None = None, target_role: str | None = None, target_jd_id: str | None = None,
) -> ResumeVersion:
    c = content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)
    data = c.model_dump()
    n = (db.scalar(select(func.max(ResumeVersion.number)).where(ResumeVersion.resume_id == resume.id)) or 0) + 1
    v = ResumeVersion(
        resume_id=resume.id, user_id=resume.user_id, number=n, parent_id=parent_id, label=label, source=source,
        content=data, content_hash=content_hash(data), target_role=target_role or resume.target_role, target_jd_id=target_jd_id,
    )
    db.add(v)
    db.flush()
    return v


# ---------------------------------------------------------------- path targeting
# summary | experience/<id>/bullets[/<bid>] | projects/<id>/bullets[/<bid>] | achievements/<id>

_PATH = re.compile(r"^(summary|(experience|projects)/([\w-]+)/bullets(?:/([\w-]+))?|achievements/([\w-]+))$")


def target_items(content: ResumeContent, path: str) -> list[dict]:
    m = _PATH.match(path)
    if not m:
        raise TargetError("Unsupported target path.")
    if path == "summary":
        return [{"id": "summary", "text": content.summary or ""}]
    if m.group(5):
        item = next((a for a in content.achievements if a.id == m.group(5)), None)
        if not item:
            raise TargetError("Achievement not found.")
        return [{"id": item.id, "text": item.text}]
    coll = content.experience if m.group(2) == "experience" else content.projects
    entry = next((e for e in coll if e.id == m.group(3)), None)
    if not entry:
        raise TargetError("Entry not found.")
    bullets = entry.bullets if not m.group(4) else [b for b in entry.bullets if b.id == m.group(4)]
    if not bullets:
        raise TargetError("Bullet not found.")
    return [{"id": b.id, "text": b.text} for b in bullets]


def apply_items(content: ResumeContent, path: str, revised: dict[str, str]) -> ResumeContent:
    c = content.model_copy(deep=True)
    m = _PATH.match(path)
    if not m:
        raise TargetError("Unsupported target path.")
    if path == "summary":
        if "summary" in revised:
            c.summary = revised["summary"]
        return c
    if m.group(5):
        for a in c.achievements:
            if a.id in revised:
                a.text = revised[a.id]
        return c
    coll = c.experience if m.group(2) == "experience" else c.projects
    entry = next((e for e in coll if e.id == m.group(3)), None)
    if not entry:
        raise TargetError("Entry not found.")
    for b in entry.bullets:
        if b.id in revised:
            b.text = revised[b.id]
    return c


def word_diff(before: str, after: str) -> list[dict]:
    a, b = re.findall(r"\S+|\s+", before), re.findall(r"\S+|\s+", after)
    ops = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            ops.append({"op": "equal", "text": "".join(a[i1:i2])})
        else:
            if i2 > i1:
                ops.append({"op": "delete", "text": "".join(a[i1:i2])})
            if j2 > j1:
                ops.append({"op": "insert", "text": "".join(b[j1:j2])})
    return ops


def content_diff(a: dict, b: dict) -> list[dict]:
    """Field-level diff between two versions for the comparison view."""
    ca, cb = ResumeContent.model_validate(a), ResumeContent.model_validate(b)
    changes = []
    if (ca.summary or "") != (cb.summary or ""):
        changes.append({"path": "summary", "before": ca.summary, "after": cb.summary, "diff": word_diff(ca.summary or "", cb.summary or "")})
    for name in ("experience", "projects"):
        la = {e.id: e for e in getattr(ca, name)}
        lb = {e.id: e for e in getattr(cb, name)}
        for eid in la.keys() - lb.keys():
            changes.append({"path": f"{name}/{eid}", "change": "removed"})
        for eid in lb.keys() - la.keys():
            changes.append({"path": f"{name}/{eid}", "change": "added"})
        for eid in la.keys() & lb.keys():
            ba = {x.id: x.text for x in la[eid].bullets}
            bb = {x.id: x.text for x in lb[eid].bullets}
            for bid in ba.keys() | bb.keys():
                if ba.get(bid) != bb.get(bid):
                    changes.append({"path": f"{name}/{eid}/bullets/{bid}", "before": ba.get(bid), "after": bb.get(bid),
                                    "diff": word_diff(ba.get(bid) or "", bb.get(bid) or "")})
    if ca.skills != cb.skills:
        sa, sb = set(ca.skills.technical + ca.skills.soft), set(cb.skills.technical + cb.skills.soft)
        changes.append({"path": "skills", "added": sorted(sb - sa), "removed": sorted(sa - sb)})
    if ca.section_order != cb.section_order:
        changes.append({"path": "section_order", "before": ca.section_order, "after": cb.section_order})
    return changes
