"""Date range parsing for resume entries."""

from __future__ import annotations

import re
from dataclasses import dataclass

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_MON = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
_YEAR = r"(?:19[5-9]\d|20[0-4]\d)"
_POINT = rf"(?:{_MON}\s*,?\s*{_YEAR}|(?:0?[1-9]|1[0-2])\s*[/.-]\s*{_YEAR}|{_YEAR}\s*[/.-]\s*(?:0[1-9]|1[0-2])|{_YEAR})"
_PRESENT = r"(?:present|current|now|today|ongoing|till date|to date)"
_SEP = r"\s*(?:-|–|—|to|until|till|→)\s*"

RANGE_RE = re.compile(rf"(?P<start>{_POINT}){_SEP}(?P<end>{_POINT}|{_PRESENT})", re.IGNORECASE)
SINGLE_RE = re.compile(rf"(?P<point>{_POINT})", re.IGNORECASE)


@dataclass
class DateRange:
    start: str | None
    end: str | None
    current: bool
    raw: str
    span: tuple[int, int]
    month_precision: bool


def _norm_point(text: str) -> tuple[str | None, bool]:
    t = text.strip().lower().replace(",", " ").replace(".", " ")
    t = re.sub(r"\s+", " ", t)
    m = re.match(rf"^({_MON})\s*({_YEAR})$", t, re.I)
    if m:
        mon = MONTHS.get(m.group(1).rstrip(".")[:4].rstrip(), MONTHS.get(m.group(1)[:3]))
        return f"{m.group(2)}-{mon:02d}", True
    m = re.match(rf"^(\d{{1,2}})\s*[/ -]\s*({_YEAR})$", t)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}", True
    m = re.match(rf"^({_YEAR})\s*[/ -]\s*(\d{{2}})$", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}", True
    m = re.match(rf"^({_YEAR})$", t)
    if m:
        return m.group(1), False
    return None, False


def find_range(text: str) -> DateRange | None:
    m = RANGE_RE.search(text)
    if not m:
        return None
    start, p1 = _norm_point(m.group("start"))
    end_raw = m.group("end")
    current = bool(re.fullmatch(_PRESENT, end_raw.strip(), re.I))
    end, p2 = (None, True) if current else _norm_point(end_raw)
    return DateRange(start, end, current, m.group(0), m.span(), p1 and p2)


def find_single(text: str) -> tuple[str | None, tuple[int, int] | None]:
    m = SINGLE_RE.search(text)
    if not m:
        return None, None
    v, _ = _norm_point(m.group("point"))
    return v, m.span()


def to_month_index(d: str | None) -> int | None:
    """YYYY or YYYY-MM -> months since year 0 (YYYY assumes January for starts)."""
    if not d:
        return None
    parts = d.split("-")
    y = int(parts[0])
    mth = int(parts[1]) if len(parts) > 1 else 1
    return y * 12 + (mth - 1)
