"""Deterministic structured extraction from resume text.

Output: (ResumeContent, evidence, report). Evidence maps a content path to the source span
`{page, start, end, text}`; the report lists per-field confidence, uncertain fields and
sections that were *detected but not reliably parsed* (distinct from *missing*).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pydantic import BaseModel

from app.schemas.resume import (
    Bullet,
    Certification,
    Contact,
    Education,
    Experience,
    LanguageItem,
    Link,
    Project,
    ResumeContent,
    SimpleItem,
    Skills,
)
from app.services.extraction.dates import find_range, find_single
from app.services.extraction.recover import Recovered, recover
from app.services.taxonomy import get_taxonomy
from app.versions import EXTRACTOR_VERSION

HEADINGS: dict[str, list[str]] = {
    "summary": ["summary", "professional summary", "profile", "about me", "objective", "career objective",
                "professional profile", "career summary", "about"],
    "experience": ["experience", "work experience", "professional experience", "employment", "employment history",
                   "work history", "internships", "internship", "internship experience", "relevant experience",
                   "career history"],
    "education": ["education", "academic background", "academics", "education and training", "qualifications",
                  "academic qualifications"],
    "projects": ["projects", "personal projects", "academic projects", "key projects", "selected projects",
                 "project experience", "side projects"],
    "skills": ["skills", "highlights", "skill highlights", "technical skills", "core skills", "key skills", "skills and tools", "technologies",
               "tech stack", "core competencies", "competencies", "tools", "skills & tools", "technical proficiencies"],
    "certifications": ["certifications", "certificates", "licenses", "licenses and certifications",
                       "certifications and licenses", "courses", "certifications & courses"],
    "achievements": ["achievements", "awards", "honors", "honours", "awards and achievements", "accomplishments",
                     "honors and awards", "awards & achievements"],
    "languages": ["languages", "language proficiency", "spoken languages"],
    "_ignore": ["references", "hobbies", "interests", "volunteering", "volunteer experience", "publications",
                "activities", "extracurricular activities", "personal details", "declaration"],
}
_HEADING_LOOKUP = {h: k for k, hs in HEADINGS.items() for h in hs}

BULLET_RE = re.compile(r"^\s*(?:[•\-\*▪◦●‣–·>]|\d{1,2}[.)])\s+")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<!\d)(\+?\d[\d\s().-]{7,}\d)(?!\d)")
URL_RE = re.compile(
    r"((?:https?://)?(?:www\.)?(?:linkedin\.com/in/[\w\-%]+|github\.com/[\w\-]+|gitlab\.com/[\w\-]+|"
    r"[\w\-]+\.(?:dev|io|me|com|net|org|app|ai)(?:/[\w\-./%]*)?))",
    re.I,
)
DEGREE_RE = re.compile(
    r"\b(b\.?\s?tech|m\.?\s?tech|b\.?\s?ed|m\.?\s?ed|b\.?\s?des|m\.?\s?des|b\.?\s?pharm|m\.?\s?pharm|b\.?\s?arch|"
    r"m\.?\s?arch|mbbs|llb|llm|bds|b\.?\s?e\.?|m\.?\s?e\.?|b\.?\s?sc|m\.?\s?sc|b\.?\s?s\.?|m\.?\s?s\.?|b\.?\s?a\.?|m\.?\s?a\.?|"
    r"bca|mca|bba|mba|ph\.?\s?d|bachelor(?:'s)?|master(?:'s)?|doctorate|associate(?:'s)? degree|diploma|"
    r"high school|secondary school|hsc|ssc|class xii|class x|a-levels|b\.?com|m\.?com)\b",
    re.I,
)
INSTITUTION_RE = re.compile(r"\b(university|college|institute|school|academy|iit|nit|polytechnic)\b", re.I)
GRADE_RE = re.compile(r"\b(?:gpa|cgpa|cpi|grade|percentage|score)\s*[:\-]?\s*([0-9.]+\s*(?:/\s*[0-9.]+|%)?)", re.I)
INTERN_RE = re.compile(r"\bintern(ship)?\b", re.I)
PARTTIME_RE = re.compile(r"\bpart[- ]time\b", re.I)
CONTRACT_RE = re.compile(r"\b(contract|contractor|freelance|freelancer|consultant)\b", re.I)
TECH_LINE_RE = re.compile(r"^\s*(?:tech(?:nologies|nology| stack)?|tools|stack|built with)\s*[:\-]\s*(.+)$", re.I)
PROFICIENCY_RE = re.compile(
    r"\b(native|fluent|proficient|professional|intermediate|basic|beginner|conversational|elementary|"
    r"bilingual|full professional|limited working|c1|c2|b1|b2|a1|a2)\b", re.I
)
# phrases often used to smuggle instructions to AI systems; flagged, never executed
INJECTION_RE = re.compile(
    r"(ignore (all )?(previous|prior|above) instructions|disregard (the )?(previous|above)|system prompt|"
    r"you are (now )?(an?|the) (ai|assistant|model)|rate this (resume|candidate) (as )?(highly|10)|"
    r"respond only with|<\s*/?\s*(system|assistant|instructions?)\s*>)",
    re.I,
)


@dataclass
class Line:
    text: str
    start: int
    end: int
    page: int | None


@dataclass
class Section:
    key: str
    heading: Line | None
    lines: list[Line] = field(default_factory=list)


@dataclass
class ExtractionReport:
    confidence: dict[str, float] = field(default_factory=dict)
    uncertain: list[dict] = field(default_factory=list)
    detected_sections: list[str] = field(default_factory=list)
    unparsed_sections: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    unrecognized_skills: list[str] = field(default_factory=list)


class Extractor:
    def __init__(self, text: str, pages: list[dict]) -> None:
        self.text = text
        self.pages = pages
        self.evidence: dict[str, dict] = {}
        self.report = ExtractionReport()
        self.tax = get_taxonomy()

    # ------------------------------------------------------------ helpers
    def _page_of(self, pos: int) -> int | None:
        for p in self.pages:
            if p.get("char_start", 0) <= pos <= p.get("char_end", 0):
                return p.get("page")
        return None

    def _lines(self) -> list[Line]:
        out, pos = [], 0
        for raw in self.text.split("\n"):
            start = pos
            pos += len(raw) + 1
            stripped = raw.strip()
            if not stripped:
                out.append(Line("", start, start, self._page_of(start)))
                continue
            lead = len(raw) - len(raw.lstrip())
            s = start + lead
            out.append(Line(stripped, s, s + len(stripped), self._page_of(s)))
        return out

    def _ev(self, path: str, line_or_span, text: str | None = None) -> None:
        if isinstance(line_or_span, Line):
            s, e = line_or_span.start, line_or_span.end
        else:
            s, e = line_or_span
        self.evidence[path] = {"page": self._page_of(s), "start": s, "end": e, "text": (text or self.text[s:e])[:300]}

    def _uncertain(self, path: str, reason: str) -> None:
        self.report.uncertain.append({"path": path, "reason": reason})

    @staticmethod
    def _heading_key(line: str) -> str | None:
        t = re.sub(r"[:\-–—|_*#=]+$", "", line.strip()).strip()
        t = re.sub(r"^[#*=\-\s]+", "", t)
        if not t or len(t) > 45 or len(t.split()) > 5:
            return None
        key = t.lower().replace("&", "and")
        key = re.sub(r"\s+", " ", key)
        if key in _HEADING_LOOKUP:
            return _HEADING_LOOKUP[key]
        alt = t.lower()
        return _HEADING_LOOKUP.get(alt)

    # ------------------------------------------------------------ sections
    def _sections(self, lines: list[Line]) -> tuple[list[Line], list[Section]]:
        header: list[Line] = []
        sections: list[Section] = []
        current: Section | None = None
        for ln in lines:
            key = self._heading_key(ln.text) if ln.text else None
            if key:
                current = Section(key, ln)
                sections.append(current)
                continue
            if current is None:
                header.append(ln)
            else:
                current.lines.append(ln)
        return header, sections

    # ------------------------------------------------------------ main
    def run(self) -> tuple[ResumeContent, dict, ExtractionReport]:
        if INJECTION_RE.search(self.text):
            self.report.warnings.append("embedded_instructions_detected")
        lines = self._lines()
        header, sections = self._sections(lines)
        self.report.detected_sections = list(dict.fromkeys(s.key for s in sections if s.key != "_ignore"))

        content = ResumeContent()
        content.contact = self._contact(header, lines)

        by_key: dict[str, list[Line]] = {}
        order: list[str] = []
        for s in sections:
            if s.key == "_ignore":
                continue
            by_key.setdefault(s.key, []).extend(s.lines)
            if s.key not in order:
                order.append(s.key)

        if "summary" in by_key:
            content.summary = self._summary(by_key["summary"])
        elif header:
            # an unlabelled paragraph under the contact block is a probable summary
            para = [ln for ln in header[1:] if len(ln.text.split()) >= 12 and not EMAIL_RE.search(ln.text)]
            if para:
                content.summary = " ".join(p.text for p in para)[:3000]
                self._ev("summary", (para[0].start, para[-1].end))
                self.report.confidence["summary"] = 0.5
                self._uncertain("summary", "No 'Summary' heading; paragraph under the name was assumed to be a summary.")

        if "experience" in by_key:
            content.experience = self._entries_experience(by_key["experience"])
        if "education" in by_key:
            content.education = self._education(by_key["education"])
        if "projects" in by_key:
            content.projects = self._projects(by_key["projects"])
        content.skills = self._skills(by_key.get("skills", []))
        if "certifications" in by_key:
            content.certifications = self._certifications(by_key["certifications"])
        if "achievements" in by_key:
            content.achievements = [
                SimpleItem(text=t[:600]) for t in self._items(by_key["achievements"], "achievements")
            ]
        if "languages" in by_key:
            content.languages = self._languages(by_key["languages"])

        # No sections at all (text without headings or line breaks): keep what can honestly be said. Skills
        # named anywhere count as *mentioned* (listed), never as shown in work, and the text is kept as the
        # summary so job matching has something to compare.
        if not (content.experience or content.projects or content.education) and not (
            content.skills.technical or content.skills.soft
        ) and len(self.text.split()) >= 80:
            tech, soft = [], []
            for h in self.tax.find_skills(self.text):
                (soft if self.tax.skills[h.skill].is_soft else tech).append(h.skill)
            content.skills.technical = list(dict.fromkeys(tech))
            content.skills.soft = list(dict.fromkeys(soft))
            if content.skills.technical or content.skills.soft:
                self.report.confidence["skills"] = 0.4
                self._uncertain("skills", "No sections found; skills were picked up from anywhere in the text and "
                                          "are treated as mentioned, not shown in work.")
            if not content.summary:
                body = [ln for ln in lines if ln.text and not EMAIL_RE.search(ln.text)]
                if body:
                    content.summary = " ".join(ln.text for ln in body)[:3000]
                    self._ev("summary", (body[0].start, body[-1].end))
                    self.report.confidence["summary"] = 0.3
                    self._uncertain("summary", "No sections found; the whole text is used as the summary.")
            self.report.warnings.append("no_sections_found")

        # detected-but-empty => "could not reliably extract", not "missing"
        for key in order:
            if not self._has_content(content, key) and any(ln.text for ln in by_key.get(key, [])):
                self.report.unparsed_sections.append(
                    {"section": key, "reason": "Heading found but its contents could not be parsed reliably."}
                )

        content.section_order = order + [k for k in content.section_order if k not in order]
        return content, self.evidence, self.report

    @staticmethod
    def _has_content(c: ResumeContent, key: str) -> bool:
        v = getattr(c, key)
        if key == "skills":
            return bool(v.technical or v.soft or v.other)
        return bool(v)

    # ------------------------------------------------------------ contact
    def _contact(self, header: list[Line], lines: list[Line]) -> Contact:
        c = Contact()
        scan = [ln for ln in (header or lines[:8]) if ln.text][:12]
        top = "\n".join(ln.text for ln in scan)
        m = EMAIL_RE.search(self.text)
        if m:
            c.email = m.group(0)
            self._ev("contact.email", m.span())
            self.report.confidence["contact.email"] = 0.98
        for ln in scan:
            pm = PHONE_RE.search(ln.text)
            if pm and sum(ch.isdigit() for ch in pm.group(1)) >= 9 and not find_range(pm.group(1)):
                c.phone = pm.group(1).strip()
                self._ev("contact.phone", (ln.start + pm.start(1), ln.start + pm.end(1)))
                self.report.confidence["contact.phone"] = 0.9
                break
        seen = set()
        for um in URL_RE.finditer(top):
            url = um.group(1).rstrip(".,;)")
            if c.email and url.lower() in c.email.lower():
                continue
            low = url.lower()
            if low in seen or len(c.links) >= 6:
                continue
            seen.add(low)
            label = "LinkedIn" if "linkedin" in low else "GitHub" if "github" in low else "GitLab" if "gitlab" in low else "Website"
            try:
                c.links.append(Link(label=label, url=url))
            except ValueError:
                continue
        if c.links:
            self.report.confidence["contact.links"] = 0.85

        # name: first short line of letters, before any heading
        for ln in scan[:3]:
            t = ln.text
            if EMAIL_RE.search(t) or any(ch.isdigit() for ch in t) or "|" in t or len(t) > 60:
                continue
            words = t.replace(".", " ").split()
            if 1 < len(words) <= 5 and all(w[:1].isalpha() for w in words) and not self._heading_key(t):
                c.name = t.title() if t.isupper() else t
                self._ev("contact.name", ln)
                self.report.confidence["contact.name"] = 0.8 if ln is scan[0] else 0.55
                if ln is not scan[0]:
                    self._uncertain("contact.name", "Name was not on the first line.")
                break
        if not c.name:
            self._uncertain("contact.name", "Could not identify a name line.")

        loc_re = re.compile(r"\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?,\s?(?:[A-Z]{2}|[A-Z][a-zA-Z]+))\b")
        for ln in scan:
            if c.name and ln.text == c.name:
                continue
            for part in re.split(r"[|•·]", ln.text):
                part = part.strip()
                if EMAIL_RE.search(part) or URL_RE.search(part) or PHONE_RE.search(part):
                    continue
                lm = loc_re.search(part)
                if lm:
                    c.location = lm.group(1)
                    idx = ln.text.find(lm.group(1))
                    self._ev("contact.location", (ln.start + idx, ln.start + idx + len(lm.group(1))))
                    self.report.confidence["contact.location"] = 0.6
                    break
            if c.location:
                break
        return c

    # ------------------------------------------------------------ summary
    def _summary(self, lines: list[Line]) -> str | None:
        ls = [ln for ln in lines if ln.text]
        if not ls:
            return None
        self._ev("summary", (ls[0].start, ls[-1].end))
        self.report.confidence["summary"] = 0.9
        return " ".join(BULLET_RE.sub("", ln.text) for ln in ls)[:3000]

    # ------------------------------------------------------------ experience
    def _blocks(self, lines: list[Line]) -> list[list[Line]]:
        """Split a section into entries. A new entry starts at a non-bullet line that
        contains a date range, or that is immediately followed by a date-range line, after
        bullets have already been seen for the current entry."""
        blocks: list[list[Line]] = []
        cur: list[Line] = []
        seen_bullet = False
        ls = [ln for ln in lines]
        for i, ln in enumerate(ls):
            if not ln.text:
                if cur and seen_bullet:
                    blocks.append(cur)
                    cur, seen_bullet = [], False
                continue
            is_bullet = bool(BULLET_RE.match(ln.text))
            has_date = find_range(ln.text) is not None
            nxt = next((x for x in ls[i + 1 : i + 3] if x.text), None)
            next_has_date = bool(nxt and not BULLET_RE.match(nxt.text) and find_range(nxt.text))
            starts_entry = not is_bullet and (has_date or next_has_date)
            if starts_entry and cur and (seen_bullet or (has_date and any(find_range(x.text) for x in cur))):
                blocks.append(cur)
                cur, seen_bullet = [], False
            cur.append(ln)
            if is_bullet:
                seen_bullet = True
        if cur:
            blocks.append(cur)
        return blocks

    @staticmethod
    def _split_title_org(text: str) -> tuple[str | None, str | None]:
        t = text.strip(" ,|-–—")
        for sep in (" at ", " @ ", " | ", " — ", " – ", " - ", ", "):
            if sep in t:
                a, b = t.split(sep, 1)
                return a.strip(" ,|-–—") or None, b.strip(" ,|-–—") or None
        return t or None, None

    _TITLE_WORDS = re.compile(
        r"\b(engineer|developer|analyst|scientist|intern|manager|lead|consultant|architect|designer|associate|"
        r"specialist|administrator|assistant|researcher|tester|officer|coordinator|director|head|trainee|sde|sdet|programmer|"
        r"teacher|lecturer|professor|instructor|tutor|nurse|accountant|auditor|executive|representative|technician|clerk|"
        r"writer|editor|therapist|pharmacist|physician|chef|supervisor|agent|advisor|adviser|planner|banker|operator|"
        r"recruiter|paralegal|attorney|counsel|founder|owner|president|vp|cto|ceo|cfo|principal|staff|"
        r"secretary|receptionist|cashier|driver|mechanic|electrician|librarian|counsellor|counselor|pilot|fellow)\b",
        re.I,
    )
    # words that mark the employer side of "Company — Title"
    _ORG_WORDS = re.compile(
        r"\b(inc|ltd|llc|llp|plc|gmbh|corp|corporation|company|pvt|limited|labs?|systems|technologies|solutions|"
        r"group|holdings|bank|hospital|clinic|health|university|college|school|schools|institute|academy|agency|"
        r"retail|analytics|fintech|logistics|media|energy|manufacturing|services|software|consulting|partners|"
        r"foundation|ministry|department|council|studio|studios|ventures|capital|enterprises|industries)\b\.?",
        re.I,
    )

    def _entries_experience(self, lines: list[Line]) -> list[Experience]:
        out: list[Experience] = []
        for block in self._blocks(lines):
            head = [ln for ln in block if not BULLET_RE.match(ln.text)][:3]
            bullets = self._bullet_lines(block, skip=head)
            exp = Experience()
            path = f"experience/{exp.id}"
            date_line = next((ln for ln in head if find_range(ln.text)), None)
            if date_line:
                dr = find_range(date_line.text)
                assert dr
                exp.start, exp.end, exp.current = dr.start, dr.end, dr.current
                self._ev(f"{path}/dates", (date_line.start + dr.span[0], date_line.start + dr.span[1]))
                if not dr.month_precision:
                    self._uncertain(f"{path}/dates", "Dates have year precision only.")
            else:
                self._uncertain(f"{path}/dates", "No date range found for this entry.")
            # remove the date text, then split remaining head text into title/org/location
            head_texts = []
            for ln in head:
                t = ln.text
                dr = find_range(t)
                if dr:
                    t = (t[: dr.span[0]] + t[dr.span[1] :]).strip(" ,|-–—()")
                if t:
                    head_texts.append((t, ln))
            if head_texts:
                t0, l0 = head_texts[0]
                a, b = self._split_title_org(t0)
                if len(head_texts) > 1 and b is None:
                    t1, _ = head_texts[1]
                    b2, loc = self._split_title_org(t1)
                    b, exp.location = b2, loc
                if a and b and (
                    (not self._TITLE_WORDS.search(a) and self._TITLE_WORDS.search(b))
                    or (self._ORG_WORDS.search(a) and not self._ORG_WORDS.search(b))
                ):
                    a, b = b, a  # "Company — Title" ordering
                exp.title, exp.organization = a, b
                self._ev(f"{path}/title", l0)
                conf = 0.85 if (exp.title and exp.organization and date_line) else 0.55
                self.report.confidence[path] = conf
                if not exp.organization:
                    self._uncertain(f"{path}/organization", "Could not separate employer from job title.")
            else:
                self.report.confidence[path] = 0.3
                self._uncertain(path, "Entry heading could not be parsed.")
            blob = " ".join(t for t, _ in head_texts)
            if INTERN_RE.search(blob):
                exp.employment_type = "internship"
            elif PARTTIME_RE.search(blob):
                exp.employment_type = "part_time"
            elif CONTRACT_RE.search(blob):
                exp.employment_type = "contract"
            elif exp.title:
                exp.employment_type = "full_time"
            for ln, txt in bullets:
                b = Bullet(text=txt[:800])
                exp.bullets.append(b)
                self._ev(f"{path}/bullets/{b.id}", ln)
            if exp.title or exp.organization or exp.bullets:
                out.append(exp)
        return out

    def _bullet_lines(self, block: list[Line], skip: list[Line]) -> list[tuple[Line, str]]:
        """Bullets with wrapped continuation lines merged."""
        out: list[tuple[Line, str]] = []
        skip_ids = {id(x) for x in skip}
        for ln in block:
            if id(ln) in skip_ids or not ln.text:
                continue
            if BULLET_RE.match(ln.text):
                out.append((ln, BULLET_RE.sub("", ln.text).strip()))
            elif out and (ln.text[:1].islower() or not out[-1][1].rstrip().endswith((".", "!", "?"))) and not TECH_LINE_RE.match(ln.text):
                prev_ln, prev_t = out[-1]
                merged = Line(prev_t + " " + ln.text, prev_ln.start, ln.end, prev_ln.page)
                out[-1] = (merged, prev_t + " " + ln.text)
            elif not TECH_LINE_RE.match(ln.text):
                out.append((ln, ln.text))
        return out

    # ------------------------------------------------------------ education
    def _education(self, lines: list[Line]) -> list[Education]:
        out: list[Education] = []
        blocks: list[list[Line]] = []
        cur: list[Line] = []
        for ln in lines:
            if not ln.text:
                if cur:
                    blocks.append(cur)
                    cur = []
                continue
            starts = (DEGREE_RE.search(ln.text) or INSTITUTION_RE.search(ln.text)) and not BULLET_RE.match(ln.text)
            if starts and cur and any(DEGREE_RE.search(x.text) for x in cur) and DEGREE_RE.search(ln.text):
                blocks.append(cur)
                cur = []
            cur.append(ln)
        if cur:
            blocks.append(cur)
        for block in blocks:
            ed = Education()
            path = f"education/{ed.id}"
            for ln in block:
                t = ln.text
                if BULLET_RE.match(t):
                    ed.details.append(BULLET_RE.sub("", t))
                    continue
                dr = find_range(t)
                if dr:
                    ed.start, ed.end = dr.start, dr.end
                    self._ev(f"{path}/dates", (ln.start + dr.span[0], ln.start + dr.span[1]))
                    t = (t[: dr.span[0]] + t[dr.span[1] :]).strip(" ,|-–—()")
                elif not ed.end:
                    single, sp = find_single(t)
                    if single and sp:
                        ed.end = single
                        t = (t[: sp[0]] + t[sp[1] :]).strip(" ,|-–—()")
                gm = GRADE_RE.search(t)
                if gm:
                    ed.grade = gm.group(1).strip()
                    t = (t[: gm.start()] + t[gm.end() :]).strip(" ,|-–—()")
                parts = [p.strip() for p in re.split(r"\s[|–—-]\s|,\s(?=[A-Z])", t) if p.strip()]
                for part in parts:
                    if not ed.degree and DEGREE_RE.search(part):
                        ed.degree = part
                        self._ev(f"{path}/degree", ln)
                        fm = re.search(r"\b(?:in|of)\s+(.+)$", part)
                        if fm:
                            ed.field_of_study = fm.group(1).strip()
                    elif not ed.institution and INSTITUTION_RE.search(part):
                        ed.institution = part
                        self._ev(f"{path}/institution", ln)
                    elif ed.institution and not ed.location and len(part.split()) <= 3 and part[:1].isupper():
                        ed.location = part
            if ed.degree or ed.institution:
                self.report.confidence[path] = 0.85 if (ed.degree and ed.institution) else 0.5
                if not (ed.degree and ed.institution):
                    self._uncertain(path, "Only part of this education entry could be identified.")
                out.append(ed)
        return out

    # ------------------------------------------------------------ projects
    def _projects(self, lines: list[Line]) -> list[Project]:
        out: list[Project] = []
        cur: Project | None = None
        cur_head: Line | None = None
        pending: list[Line] = []

        def flush():
            nonlocal cur, pending
            if cur is not None:
                for ln, txt in self._bullet_lines(pending, skip=[]):
                    b = Bullet(text=txt[:800])
                    cur.bullets.append(b)
                    self._ev(f"projects/{cur.id}/bullets/{b.id}", ln)
                out.append(cur)
            cur, pending = None, []

        for ln in lines:
            if not ln.text:
                continue
            tm = TECH_LINE_RE.match(ln.text)
            if tm and cur is not None:
                for tok in re.split(r"[,|;/]", tm.group(1)):
                    tok = tok.strip()
                    if tok:
                        cur.technologies.append(self.tax.canonical(tok) or tok)
                continue
            is_bullet = bool(BULLET_RE.match(ln.text))
            looks_title = not is_bullet and len(ln.text) <= 110 and (
                cur is None or pending or "|" in ln.text or find_range(ln.text) is not None
            )
            if looks_title and not (cur is not None and not pending and ln.text[:1].islower()):
                flush()
                t = ln.text
                dr = find_range(t)
                cur = Project(name="untitled")
                if dr:
                    cur.start, cur.end = dr.start, dr.end
                    t = (t[: dr.span[0]] + t[dr.span[1] :]).strip(" ,|-–—()")
                um = URL_RE.search(t)
                if um and ("github" in um.group(1).lower() or "http" in um.group(1).lower()):
                    cur.url = um.group(1)
                    t = t.replace(um.group(1), "").strip(" ,|-–—()")
                name, tech = (t.split("|", 1) + [""])[:2] if "|" in t else (t, "")
                if not tech and " - " in name and len(name.split(" - ", 1)[0]) < 60:
                    name, tech = name.split(" - ", 1)
                cur.name = name.strip(" :-–—") or "Untitled project"
                for tok in re.split(r"[,|;/]", tech):
                    tok = tok.strip()
                    if tok and len(tok) < 40:
                        cur.technologies.append(self.tax.canonical(tok) or tok)
                cur_head = ln
                self._ev(f"projects/{cur.id}/name", ln)
                self.report.confidence[f"projects/{cur.id}"] = 0.75
            else:
                if cur is None:
                    cur = Project(name="Untitled project")
                    self._uncertain(f"projects/{cur.id}", "Project title could not be identified.")
                pending.append(ln)
        flush()
        _ = cur_head
        return out

    # ------------------------------------------------------------ skills
    def _skills(self, lines: list[Line]) -> Skills:
        sk = Skills()
        tech, soft, other = [], [], []
        for ln in lines:
            if not ln.text:
                continue
            t = BULLET_RE.sub("", ln.text)
            if ":" in t and len(t.split(":", 1)[0]) <= 40:
                t = t.split(":", 1)[1]
            tokens = [x.strip(" .") for x in re.split(r"[,|;•·]|\s/\s|\s{2,}", t) if x.strip(" .")]
            for tok in tokens:
                hits = self.tax.find_skills(tok)
                if hits:
                    for h in hits:
                        (soft if self.tax.skills[h.skill].is_soft else tech).append(h.skill)
                    leftover = tok
                    for h in sorted(hits, key=lambda h: -h.start):
                        leftover = leftover[: h.start] + leftover[h.end :]
                    leftover = re.sub(r"[\s()\-&+]+", " ", leftover).strip()
                    if leftover and len(leftover) > 2 and not re.fullmatch(r"(and|with|etc|basics?|advanced)", leftover, re.I):
                        other.append(leftover[:60])
                elif 1 < len(tok) <= 40:
                    other.append(tok)
            self._ev(f"skills/line/{ln.start}", ln)
        sk.technical = list(dict.fromkeys(tech))
        sk.soft = list(dict.fromkeys(soft))
        sk.other = list(dict.fromkeys(o for o in other if o.lower() not in {s.lower() for s in sk.technical}))
        self.report.unrecognized_skills = sk.other[:50]
        if lines and any(ln.text for ln in lines):
            self.report.confidence["skills"] = 0.9 if sk.technical else 0.5
        return sk

    # ------------------------------------------------------------ misc lists
    def _items(self, lines: list[Line], section: str) -> list[str]:
        out = [txt for _, txt in self._bullet_lines(lines, skip=[])]
        for i, ln in enumerate(x for x in lines if x.text):
            if i < len(out):
                self._ev(f"{section}/{i}", ln)
        return [o for o in out if len(o) > 2]

    def _certifications(self, lines: list[Line]) -> list[Certification]:
        out = []
        for txt in self._items(lines, "certifications"):
            date, sp = find_single(txt)
            name = txt
            if sp:
                name = (txt[: sp[0]] + txt[sp[1] :]).strip(" ,|-–—()")
            issuer = None
            for sep in (" — ", " – ", " - ", " | ", ", "):
                if sep in name:
                    name, issuer = [x.strip() for x in name.split(sep, 1)]
                    break
            out.append(Certification(name=name[:200] or txt[:200], issuer=issuer, date=date))
        return out

    def _languages(self, lines: list[Line]) -> list[LanguageItem]:
        out = []
        blob = ", ".join(BULLET_RE.sub("", ln.text) for ln in lines if ln.text)
        for part in re.split(r"[,;|•]", blob):
            part = part.strip()
            if not part:
                continue
            pm = PROFICIENCY_RE.search(part)
            name = re.sub(r"[()\-:]", " ", PROFICIENCY_RE.sub("", part)).strip()
            if name and len(name) <= 40:
                out.append(LanguageItem(name=(name.split()[0] if len(name.split()) > 2 else name)[:60],
                                        proficiency=pm.group(1).title() if pm else None))
        return out


def _clip_to_schema(obj: BaseModel) -> int:
    """Truncate strings and lists that exceed the schema's max_length, so extraction never produces
    content that fails its own validation (e.g. a 200-character education line as `degree`)."""
    clipped = 0
    for name, info in type(obj).model_fields.items():
        val = getattr(obj, name)
        limit = next((m.max_length for m in info.metadata if getattr(m, "max_length", None) is not None), None)
        if isinstance(val, str) and limit is not None and len(val) > limit:
            setattr(obj, name, val[: limit - 1].rstrip() + "…")
            clipped += 1
        elif isinstance(val, list):
            if limit is not None and len(val) > limit:
                setattr(obj, name, val[:limit])
                clipped += 1
            for item in getattr(obj, name):
                if isinstance(item, BaseModel):
                    clipped += _clip_to_schema(item)
        elif isinstance(val, BaseModel):
            clipped += _clip_to_schema(val)
    return clipped


def _pages_for(rec: Recovered, pages: list[dict]) -> list[dict]:
    """Page character ranges re-expressed in the recovered text's positions."""
    out = []
    for p in pages:
        s, e = p.get("char_start", 0), p.get("char_end", 0)
        ns = next((i for i, o in enumerate(rec.index) if o >= s), len(rec.index))
        ne = next((i for i in range(len(rec.index) - 1, -1, -1) if rec.index[i] <= e), ns)
        out.append({**p, "char_start": ns, "char_end": ne})
    return out


def extract(text: str, pages: list[dict]) -> dict:
    rec = recover(text)
    if rec.changed:
        content, evidence, report = Extractor(rec.text, _pages_for(rec, pages)).run()
        for ev in evidence.values():  # point evidence back at the user's original text
            s, e = ev["start"], ev["end"]
            os_, oe = rec.to_original(s), (rec.to_original(e - 1) + 1 if e > s else rec.to_original(s))
            ev.update(start=os_, end=oe, text=text[os_:oe][:300])
        report.warnings.append("layout_recovered")
    else:
        content, evidence, report = Extractor(text, pages).run()
    if _clip_to_schema(content):
        report.warnings.append("fields_truncated")
    return {
        "content": content.model_dump(),
        "evidence": evidence,
        "confidence": report.confidence,
        "uncertain": report.uncertain,
        "detected_sections": report.detected_sections,
        "unparsed_sections": report.unparsed_sections,
        "unrecognized_skills": report.unrecognized_skills,
        "warnings": report.warnings,
        "extractor_version": EXTRACTOR_VERSION,
    }
