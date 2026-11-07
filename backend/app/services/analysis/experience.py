"""Experience timeline: total years (overlap-merged), internships, gaps and overlaps."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.schemas.resume import ResumeContent
from app.services.extraction.dates import to_month_index


def _now_idx() -> int:
    n = datetime.now(UTC)
    return n.year * 12 + n.month - 1


@dataclass
class Timeline:
    professional_months: int = 0
    internship_months: int = 0
    undated_entries: list[str] = field(default_factory=list)
    overlaps: list[tuple[str, str, int]] = field(default_factory=list)
    gaps: list[tuple[str, str, int]] = field(default_factory=list)
    invalid: list[tuple[str, str]] = field(default_factory=list)
    future: list[str] = field(default_factory=list)

    @property
    def professional_years(self) -> float:
        return round(self.professional_months / 12, 1)

    @property
    def effective_years(self) -> float:
        """Professional years + internships at half weight (documented heuristic)."""
        return round((self.professional_months + self.internship_months * 0.5) / 12, 1)


def _merge(intervals: list[tuple[int, int]]) -> int:
    if not intervals:
        return 0
    intervals.sort()
    total, (cs, ce) = 0, intervals[0]
    for s, e in intervals[1:]:
        if s <= ce:
            ce = max(ce, e)
        else:
            total += ce - cs
            cs, ce = s, e
    return total + (ce - cs)


def build_timeline(c: ResumeContent, as_of: str | None = None) -> Timeline:
    """`as_of` (YYYY-MM) pins "present" for reproducible evaluation; defaults to today."""
    t = Timeline()
    now = to_month_index(as_of) if as_of else _now_idx()
    assert now is not None
    prof: list[tuple[int, int, str, str]] = []
    intern: list[tuple[int, int]] = []
    for e in c.experience:
        s = to_month_index(e.start)
        end = now if e.current else to_month_index(e.end)
        if end is not None and e.end and len(e.end) == 4:
            end += 11  # year-only end => assume December
        if s is None or end is None:
            t.undated_entries.append(e.id)
            continue
        if end < s:
            t.invalid.append((e.id, "End date is before start date."))
            continue
        if s > now:
            t.future.append(e.id)
        dur = end - s + 1
        if e.employment_type == "internship":
            intern.append((s, s + dur))
        else:
            prof.append((s, s + dur, e.id, e.employment_type))
    t.professional_months = _merge([(a, b) for a, b, _, _ in prof])
    t.internship_months = _merge(intern)
    full = sorted([p for p in prof if p[3] == "full_time"])
    for i in range(len(full)):
        for j in range(i + 1, len(full)):
            ov = min(full[i][1], full[j][1]) - max(full[i][0], full[j][0])
            if ov > 1:
                t.overlaps.append((full[i][2], full[j][2], ov))
    for a, b in zip(full, full[1:], strict=False):
        gap = b[0] - a[1]
        if gap > 6:
            t.gaps.append((a[2], b[2], gap))
    for ed in c.education:
        s, e = to_month_index(ed.start), to_month_index(ed.end)
        if s is not None and e is not None and e < s:
            t.invalid.append((ed.id, "Education end date is before start date."))
    return t
