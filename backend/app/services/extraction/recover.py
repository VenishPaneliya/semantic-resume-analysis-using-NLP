"""Recover line structure from resume text that lost its layout.

Text pasted from web forms, scraped from resume sites or exported by some PDF tools often arrives
with headings glued to the next word ("ExperienceData Analyst"), whole jobs on one line and
sentences run together ("…previous file.Performing a monthly…"). The extractor reads structure
from line breaks, so on such text it finds nothing.

`recover(text)` inserts line breaks (and "• " bullet markers) where the structure clearly was, and
returns a map from every character of the new text back to its position in the original, so
evidence spans can still point at the user's original document. Text that already has normal
structure is returned unchanged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.services.extraction.dates import RANGE_RE

# Section names that may be glued to the following word. Kept to unambiguous ones: a heading glued to
# a capitalised word or digit ("SkillsPython", "Experience09/2015") is very unlikely to be prose.
_GLUED = [
    "Professional Summary", "Career Summary", "Summary", "Profile", "Objective", "Career Objective",
    "Work Experience", "Professional Experience", "Employment History", "Work History", "Experience",
    "Education and Training", "Education", "Academic Background", "Qualifications",
    "Technical Skills", "Core Competencies", "Key Skills", "Skills", "Highlights",
    "Certifications", "Certificates", "Licenses", "Accomplishments", "Achievements", "Awards",
    "Projects", "Languages", "Interests", "Additional Information", "Affiliations",
]
_GLUED_RE = re.compile(
    r"(?:(?<=^)|(?<=[.!?:;]\s)|(?<=[.!?:;]))(" + "|".join(re.escape(h) for h in sorted(_GLUED, key=len, reverse=True))
    + r"|" + "|".join(re.escape(h.upper()) for h in _GLUED) + r")(?=[A-Z0-9(•])"
)
# sentence boundary inside a long line: "file.Performing", "file. Performing", "200 daily Monitor" is left alone
_SENT_RE = re.compile(r"(?<=[A-Za-z0-9%)\]])\.\s?(?=[A-Z][a-z])")
# "Altice USA Tyler,TX,Loaded daily files" -> the first duty starts after "City,ST,"
_PLACE_END = re.compile(r"(?<=,[A-Z]{2}),\s?(?=[A-Z][a-z])")
LONG_LINE = 260


@dataclass
class Recovered:
    text: str
    index: list[int]      # index[i] = position in the original text of new character i
    changed: bool

    def to_original(self, pos: int) -> int:
        if not self.index:
            return pos
        if pos >= len(self.index):
            return self.index[-1] + 1
        return self.index[max(0, pos)]


def looks_flattened(text: str) -> bool:
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        return False
    long_chars = sum(len(ln) for ln in lines if len(ln) > LONG_LINE)
    glued = sum(1 for ln in lines[:60] if _GLUED_RE.match(ln.strip()))
    return long_chars > 0.5 * sum(len(ln) for ln in lines) or glued >= 2


def recover(text: str) -> Recovered:
    if not looks_flattened(text):
        return Recovered(text, list(range(len(text))), False)
    out: list[str] = []
    idx: list[int] = []

    def emit(s: str, at: int) -> None:  # inserted characters map to the original position `at`
        out.extend(s)
        idx.extend([at] * len(s))

    pos = 0
    for raw in text.split("\n"):
        line = raw
        cuts: list[tuple[int, int, str]] = []   # (start, end, replacement) within this line
        for m in _GLUED_RE.finditer(line):
            cuts.append((m.end(1), m.end(1), "\n"))
        if len(line) > LONG_LINE:
            for m in _SENT_RE.finditer(line):
                # a sentence that starts with "Title,<date range>" is the next job, not a bullet
                nxt = RANGE_RE.search(line, m.end(), m.end() + 70)
                cuts.append((m.start(), m.end(), ".\n" if nxt else ".\n• "))
            for m in _PLACE_END.finditer(line):
                cuts.append((m.start(), m.end(), "\n• "))
            for m in RANGE_RE.finditer(line):
                # "Data Analyst,09/2015-06/2016Altice Usa" -> title + dates on one line, employer on the next
                cuts.append((m.end(), m.end(), "\n"))
        cuts.sort()
        cur = 0
        for s, e, rep in cuts:
            if s < cur:
                continue
            for k in range(cur, s):
                out.append(line[k])
                idx.append(pos + k)
            emit(rep, pos + s)
            cur = e
        for k in range(cur, len(line)):
            out.append(line[k])
            idx.append(pos + k)
        pos += len(raw) + 1
        out.append("\n")
        idx.append(pos - 1)
    new = "".join(out)
    if new.endswith("\n") and not text.endswith("\n"):
        new, idx = new[:-1], idx[:-1]
    return Recovered(new, idx, new != text)
