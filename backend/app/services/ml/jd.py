"""Job description extraction and requirement-by-requirement matching.

Statuses per requirement:
  matched   — resume evidence satisfies it
  partial   — some evidence (e.g. skill listed but not demonstrated, 1 of 3 alternatives,
              experience within a year of the ask)
  missing   — no evidence; split into `genuine_gap` vs `possibly_unlisted` (a related skill
              is demonstrated, so the user may have it but did not write it down)
  unknown   — cannot be assessed from a resume (work authorisation, travel, shifts, …)

The overall indicator is a transparent weighted average and is not a hiring probability.
Advice never suggests adding skills the user does not have.
"""

from __future__ import annotations

import re

from app.schemas.resume import ResumeContent, short_id
from app.services.analysis.experience import build_timeline
from app.services.extraction.extractor import BULLET_RE, DEGREE_RE, INJECTION_RE
from app.services.ml.embeddings import get_embedder
from app.services.ml.features import LISTED_CREDIT, evidence_text, evidence_units, resume_skill_evidence
from app.services.taxonomy import get_taxonomy
from app.versions import JD_MATCHER_VERSION

SECTION_PATTERNS = {
    "responsibilities": r"(responsibilities|what you('| wi)ll do|the role|your role|duties|you will|key responsibilities|day to day|"
                        r"your (mission|tasks|impact)|what the job involves|in this role|role overview)",
    "required": r"(requirements|qualifications|what you('| wi)ll need|must[- ]haves?|required|minimum qualifications|who you are|"
                r"what we('re| are) looking for|skills required|basic qualifications|what you('ll)? bring|about you|"
                r"(the )?ideal candidate|your (experience|profile|skills|background|qualifications|expertise)|you (have|bring|are)|"
                r"skills (and|&) experience|experience (and|&) skills|essential( skills| criteria)?|you should have|we('d| would) love)",
    "preferred": r"(preferred|nice[- ]to[- ]haves?|bonus( points)?|good to have|desired|plus|preferred qualifications|"
                 r"additional qualifications|great to have|even better|extra credit|it('s| is| would be) a plus)",
    # not requirements: company blurb, benefits, hiring boilerplate ("Not your tech stack? We also hire …")
    "about": r"(about (us|the company|the team|our company)|who we are|benefits|perks|what we offer|compensation|"
             r"equal opportunit(y|ies)|eeo|why (join|work)|our (offer|benefits|culture|values|mission|story)|"
             r"not your (tech )?stack|other (roles|positions|openings)|we also hire|how to apply|application process|"
             r"interview process|salary|diversity|life at)",
}
# "Job Requirements", "Candidate Qualifications", "Key Skills": a leading qualifier before a known heading
_HEADING_PREFIX = re.compile(r"^\W*(job|the|key|candidate|core|role|position|technical|your|our|main|general|primary)\s+", re.I)


def _next_section(bare: str, current: str) -> str:
    """Section after a short non-bullet line: a known heading switches to it; an unknown heading-like line
    ("Your main responsibilities will include:", "Profile?") ends a boilerplate section, so "About us" can't
    swallow the rest of the posting."""
    known = _section_of(bare)
    if known:
        return known
    if current == "about" and re.search(r"[:?]\s*$", bare):
        return "intro"
    return current
_PREFERRED_CUE = re.compile(r"\b(preferred|nice[- ]to[- ]have|bonus|a plus|ideally|is a plus|would be great|great to have|advantage|desirable)\b", re.I)
_RECENT_WINDOW = re.compile(r"\b(within|in|during|over) the (last|past)\b", re.I)
_EXPERIENCE_WORDS = re.compile(
    r"experience|exp\b|working|industry|professional|building|developing|designing|managing|leading|writing|"
    r"delivering|hands[- ]on|background|track record|as an?\b|in (an?|the) .{0,30}role", re.I)
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
YEARS_RE = re.compile(
    r"\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\+|plus)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b",
    re.I,
)


def _years_value(token: str) -> int:
    return int(token) if token.isdigit() else _NUM_WORDS[token.lower()]
REMOTE_RE = re.compile(r"\b(fully remote|remote[- ]first|remote|work from home|wfh)\b", re.I)
HYBRID_RE = re.compile(r"\bhybrid\b", re.I)
ONSITE_RE = re.compile(r"\b(on[- ]?site|in[- ]office|office[- ]based)\b", re.I)
LOCATION_RE = re.compile(r"(?:location|based in|office)\s*[:\-]\s*([^\n|]{2,80})", re.I)
CERT_RE = re.compile(r"\b(certifi(ed|cation)|licen[cs]e)\b", re.I)
UNASSESSABLE = re.compile(
    r"\b(authori[sz]ed to work|work authori[sz]ation|visa|sponsorship|background check|travel|relocat|shifts?|"
    r"on[- ]call|weekends?|driver'?s licen[cs]e|security clearance|citizenship)\b", re.I
)
ALTERNATIVE = re.compile(r"\b(or|one of|any of|such as|e\.g\.|similar)\b", re.I)
# Checked in order; the first match wins. Every alternative starts at a word boundary so that
# "Systems" is not "MS" and "time" is not "ME". Two-letter abbreviations that are also English
# words or product names (BE, BA, BS, MS, ME) only count in capitals, and "MS Office" is not a degree.
_MS_PRODUCT = r"(?!\s*(?:office|excel|word|sql|teams|project|access|azure|dynamics|outlook|powerpoint)\b)"
DEGREE_LEVELS = [
    (5, r"\bph\.?\s?d\b|\bdoctorate\b|\bdoctoral\b"),
    (4, rf"\bmaster|\bm\.\s?s\b\.?|(?-i:\bMS\b){_MS_PRODUCT}|\bm\.?\s?sc\b|\bm\.?\s?tech\b|\bmba\b|\bm\.\s?e\b\.?|(?-i:\bME\b)|\bmca\b|\bpost[- ]?graduate\b"
        r"|\bm\.?\s?ed\b|\bm\.?\s?des\b|\bm\.?\s?pharm\b|\bm\.?\s?arch\b|\bllm\b"),
    (2, r"\bassociate'?s?\s+degree\b|\bassociate\s+of\b"),
    (3, r"\bbachelor|\bb\.\s?s\b\.?|(?-i:\bBS\b)|\bb\.?\s?sc\b|\bb\.?\s?tech\b|\bb\.\s?e\b\.?|(?-i:\bBE\b)|\bb\.\s?a\b\.?|(?-i:\bBA\b)"
        r"|\bbca\b|\bbba\b|\bb\.?\s?com\b|\bb\.?\s?ed\b|\bb\.?\s?des\b|\bb\.?\s?pharm\b|\bb\.?\s?arch\b|\bmbbs\b|\bllb\b|\bbds\b|\bdegree in\b|\bundergraduate\b|\bgraduate degree\b"),
    (1, r"\bhigh school\b|\bsecondary school\b|\bhsc\b|\bssc\b"),
    (2, r"\bdiploma\b"),
]


def _degree_level(text: str) -> int | None:
    for lvl, pat in DEGREE_LEVELS:
        if re.search(pat, text, re.I):
            return lvl
    return None


_HEADINGS = "|".join(SECTION_PATTERNS.values())
# "… Django, AWS. Nice to have: Kafka" -> the heading starts a new line. Only after a sentence end and only when
# followed by ":", so ordinary words inside a sentence ("experience with AWS preferred") are left alone.
_INLINE_HEADING = re.compile(rf"(?<=[.!?;])\s+(?=(?:{_HEADINGS})\s*:)", re.I)
# "Nice to have: Kafka, Terraform" on one line -> heading + content
_LEADING_HEADING = re.compile(rf"^\W*(?P<head>(?:{_HEADINGS})[^:\n]{{0,30}}?)\s*[:\-–—]\s+(?P<body>\S.*)$", re.I)
_SENTENCE_END = re.compile(r"(?<!e\.g\.)(?<!i\.e\.)(?<=[.;])\s+(?=[A-Z0-9])")


def _section_of(heading: str) -> str | None:
    if len(heading.split()) > 7:
        return None
    once = _HEADING_PREFIX.sub("", heading)
    for cand in (heading, once, _HEADING_PREFIX.sub("", once)):  # "Your main responsibilities"
        for key, pat in SECTION_PATTERNS.items():
            if re.fullmatch(rf"\W*{pat}\W*.*", cand, re.I):
                return key
    return None


def _items(text: str) -> list[str]:
    """Split pasted prose into requirement-sized items.

    Each sentence is an item; a sentence that is a comma list of short phrases ("5+ years Python, FastAPI or
    Django, PostgreSQL") becomes one item per phrase. Longer clauses stay whole so their meaning survives."""
    out = []
    for sent in _SENTENCE_END.split(text):
        sent = sent.strip().rstrip(".;").strip()
        if not sent:
            continue
        parts = [p.strip() for p in sent.split(",") if p.strip()]
        if len(parts) >= 2 and all(len(p.split()) <= 6 for p in parts):
            out.extend(parts)
        else:
            out.append(sent)
    return out


_NOT_TITLE = re.compile(
    r"^\W*(about|how|our|why|what|who|we|join|overview|description|summary|introduction|company|location|salary|"
    r"apply|the (role|team|company|position|opportunity)|this (role|is)|you|your|hi|hello|welcome)\b", re.I)
_JOB_WORD = re.compile(
    r"\b(engineer|developer|analyst|scientist|manager|lead|consultant|architect|designer|specialist|administrator|"
    r"intern|director|head of|officer|coordinator|associate|technician|writer|copywriter|editor|accountant|nurse|"
    r"teacher|representative|executive|recruiter|sdet|tester|programmer|devops|sre|researcher|agent|advisor|"
    r"strategist|marketer|support)\b", re.I)


def _clean_title(line: str) -> str:
    return line.strip().rstrip(".:;-–— ").strip()[:150]


def extract_jd(text: str) -> dict:
    tax = get_taxonomy()
    text = text.replace("\r", "")
    # flattened text: "Requirements:Demonstrate", "equipment.Conduct" -> restore the spaces so headings and
    # sentences can be found ("Node.js", "ASP.NET" and URLs are left alone)
    text = re.sub(r"(?<=[a-z0-9%)\]])([.;!?])(?=[A-Z][a-z])", r"\1 ", text)
    text = re.sub(r"(?<=[A-Za-z)]):(?=[A-Za-z(])", ": ", text)
    text = _INLINE_HEADING.sub("\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    title = None
    m = re.search(r"(?:job title|position|role)\s*[:\-]\s*(.+)", text, re.I)
    if m:
        title = _clean_title(m.group(1))
    else:
        # first short line that is not a bullet, a section heading ("Requirements") or "Heading: content"
        def can_be_title(ln: str) -> bool:
            if not ln or len(ln) >= 90 or BULLET_RE.match(ln):
                return False
            if _section_of(re.sub(r"[:\-–—*#]+$", "", ln).strip()):
                return False
            if _NOT_TITLE.match(ln) or YEARS_RE.search(ln) or ln.rstrip().endswith((":", "?")) or (
                    ln.rstrip().endswith(".") and len(ln.split()) > 8):
                return False
            lead = _LEADING_HEADING.match(ln)
            return not (lead and _section_of(lead.group("head")))

        cands = [ln for ln in lines[:40] if can_be_title(ln)][:8]
        # prefer a line that names a job ("Senior Back-end Developer") over a tagline or heading
        first = next((ln for ln in cands if _JOB_WORD.search(ln)), cands[0] if cands else None)
        title = _clean_title(first) if first else None
    company = None
    cm = re.search(r"(?:company|employer)\s*[:\-]\s*(.+)", text, re.I)
    if cm:
        company = cm.group(1).strip()[:150]

    section = "intro"
    reqs: list[dict] = []
    responsibilities: list[str] = []
    about_text: list[str] = []   # intro prose, used when the JD has no requirement section at all
    for ln in lines:
        if not ln:
            continue
        is_bullet = bool(BULLET_RE.match(ln))
        lead = None if is_bullet else _LEADING_HEADING.match(ln)
        if lead and _section_of(lead.group("head")):
            # "Nice to have: Kafka, Terraform" -> section "preferred", items Kafka and Terraform
            section = _section_of(lead.group("head")) or section
            items = _items(lead.group("body"))
        else:
            bare = re.sub(r"[:\-–—*#]+$", "", ln).strip()
            if len(bare) < 60 and not is_bullet:
                section = _next_section(ln.strip(), section) if not _section_of(bare) else _section_of(bare)
                if re.fullmatch(rf"\W*({_HEADINGS})\W*", bare, re.I):
                    continue
            item = BULLET_RE.sub("", ln).strip()
            # un-bulleted prose inside a requirements/responsibilities section is split into items
            items = _items(item) if (not is_bullet and section in ("required", "preferred", "responsibilities")) else [item]
        for item in items:
            if len(item) < 4 and not tax.find_skills(item):  # keep short skill lines like "dbt", "AWS", "Go"
                continue
            if section == "responsibilities":
                responsibilities.append(item)
                about_text.append(item)  # a posting with no requirement section lists its stack under duties
                continue
            if section in ("required", "preferred") or (section == "intro" and is_bullet):
                importance = "preferred" if section == "preferred" or _PREFERRED_CUE.search(item) else "required"
                reqs.append(_classify_requirement(item, importance, tax))
            elif section == "intro":
                about_text.append(item)

    # skills mentioned anywhere outside boilerplate count toward keyword coverage
    all_skills = list(dict.fromkeys(h.skill for h in tax.find_skills(_strip_about(text))))
    if not reqs:
        # unstructured JD (prose): read it sentence by sentence. A skill becomes a requirement whose importance
        # follows its sentence ("It is a plus if you know Kafka" -> preferred); years and degree sentences
        # become experience/education requirements.
        seen: set[str] = set()
        for sent in _SENTENCE_END.split("\n".join(about_text)):
            sent = sent.strip()
            if not sent:
                continue
            importance = "preferred" if _PREFERRED_CUE.search(sent) else "required"
            ym = YEARS_RE.search(sent)
            if (ym and _EXPERIENCE_WORDS.search(sent)) or DEGREE_RE.search(sent):
                r = _classify_requirement(sent, importance, tax)
                if r["kind"] in ("experience", "education"):
                    if r["kind"] == "experience":
                        r["skills"] = []  # years in a prose sentence are about overall experience
                    reqs.append(r)
            for s in dict.fromkeys(h.skill for h in tax.find_skills(sent)):
                if s not in seen:
                    seen.add(s)
                    reqs.append({"id": short_id(), "text": s, "kind": "skill", "importance": importance, "skills": [s], "any_of": False})
    years = _main_years(reqs)
    arrangement = "remote" if REMOTE_RE.search(text) else "hybrid" if HYBRID_RE.search(text) else "onsite" if ONSITE_RE.search(text) else None
    if HYBRID_RE.search(text) and REMOTE_RE.search(text):
        arrangement = "hybrid"
    lm = LOCATION_RE.search(text)
    return {
        "title": title,
        "company": company,
        "responsibilities": responsibilities[:30],
        "requirements": reqs[:60],
        "skills": all_skills,
        "years_required": years,
        "education": next((r["text"] for r in reqs if r["kind"] == "education"), None),
        "location": lm.group(1).strip() if lm else None,
        "work_arrangement": arrangement,
        "warnings": ["embedded_instructions_detected"] if INJECTION_RE.search(text) else [],
        "matcher_version": JD_MATCHER_VERSION,
    }


def _strip_about(text: str) -> str:
    """The JD text without its boilerplate sections (benefits, about us, "we also hire …")."""
    keep, section = [], "intro"
    for ln in text.split("\n"):
        bare = re.sub(r"[:\-–—*#]+$", "", ln.strip()).strip()
        if bare and len(bare) < 60 and not BULLET_RE.match(ln.strip()):
            section = _section_of(bare) or _next_section(ln.strip(), section)
        if section != "about":
            keep.append(ln)
    return "\n".join(keep)


def _main_years(reqs: list[dict]) -> int | None:
    """The headline years requirement: the largest *required* one ("5+ years Go … 1+ year with AI tools" -> 5),
    falling back to preferred ones. Recency windows ("within the last three years") are not requirements."""
    exp = [r for r in reqs if r["kind"] == "experience" and r.get("years_min") is not None]
    req = [r["years_min"] for r in exp if r["importance"] == "required"]
    pref = [r["years_min"] for r in exp if r["importance"] != "required"]
    return max(req) if req else (max(pref) if pref else None)


def _classify_requirement(item: str, importance: str, tax) -> dict:
    skills = list(dict.fromkeys(h.skill for h in tax.find_skills(item)))
    req = {"id": short_id(), "text": item[:400], "importance": importance, "skills": skills, "any_of": False}
    ym = YEARS_RE.search(item)
    if UNASSESSABLE.search(item):
        req["kind"] = "unassessable"
    elif ym and not _RECENT_WINDOW.search(item[max(0, ym.start() - 25):ym.end()]) and (skills or _EXPERIENCE_WORDS.search(item)):
        # "5+ years Python" / "at least five years of Python": a years requirement tied to the skills named
        req["kind"] = "experience"
        req["years_min"] = _years_value(ym.group(1))
    elif DEGREE_RE.search(item) or re.search(r"\bdegree\b", item, re.I):
        req["kind"] = "education"
        req["degree_level"] = _degree_level(item)
    elif CERT_RE.search(item) and not skills:
        req["kind"] = "certification"
    elif skills:
        req["kind"] = "skill"
        req["any_of"] = len(skills) > 1 and bool(ALTERNATIVE.search(item))
    else:
        req["kind"] = "other"
    return req


def prepare_resume(content: dict | ResumeContent, as_of: str | None = None) -> dict:
    """Resume-side work that is the same for every job description. Compute once, pass to `match`
    as `prepared` when ranking one resume against many openings."""
    c = content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)
    return {"c": c, "ev": resume_skill_evidence(c), "units": evidence_units(c), "tl": build_timeline(c, as_of)}


def match(content: dict | ResumeContent, jd: dict, as_of: str | None = None, prepared: dict | None = None) -> dict:
    prep = prepared or prepare_resume(content, as_of)
    c, ev, units, tl = prep["c"], prep["ev"], prep["units"], prep["tl"]
    tax = get_taxonomy()
    emb = get_embedder()
    reqs = jd.get("requirements", [])
    unit_texts = [u[1] for u in units] or [" "]
    sim = emb.similarity([r["text"] for r in reqs] or [" "], unit_texts) if reqs else None

    rows = []
    for i, r in enumerate(reqs):
        best = []
        if sim is not None and units:
            order = sim[i].argsort()[::-1][:2]
            best = [{"path": units[j][0], "text": units[j][1][:220], "similarity": round(float(emb.normalise(float(sim[i][j]))), 3)} for j in order]
        row = {**r, "status": "unknown", "explanation": "", "evidence": [], "gap_type": None}
        kind = r["kind"]
        if kind == "skill":
            demo = [s for s in r["skills"] if s in ev.demonstrated]
            listed = [s for s in r["skills"] if s in ev.listed and s not in ev.demonstrated]
            missing = [s for s in r["skills"] if s not in ev.all]
            row["evidence"] = [e for s in demo for e in ev.evidence.get(s, [])[:1]]
            need_all = not r.get("any_of")
            if (need_all and not missing and not listed) or (not need_all and demo):
                row["status"] = "matched"
                row["explanation"] = f"Demonstrated: {', '.join(demo)}."
            elif demo or listed:
                row["status"] = "partial"
                parts = []
                if demo:
                    parts.append(f"demonstrated {', '.join(demo)}")
                if listed:
                    parts.append(f"listed but not shown in experience: {', '.join(listed)}")
                if missing and need_all:
                    parts.append(f"not found: {', '.join(missing)}")
                row["explanation"] = "; ".join(parts).capitalize() + "."
            else:
                row["status"] = "missing"
                related = sorted({d for s in missing for d in ev.demonstrated if s in tax.skills[d].related or d in tax.skills[s].related})
                if related:
                    row["gap_type"] = "possibly_unlisted"
                    row["explanation"] = (f"Not found in the resume. You demonstrate related skills ({', '.join(related[:3])}); "
                                          "if you have used it, add it where you used it.")
                else:
                    row["gap_type"] = "genuine_gap"
                    row["explanation"] = "Not found in the resume and no closely related evidence."
        elif kind == "experience":
            need = r.get("years_min") or 0
            have = tl.effective_years
            row["evidence"] = [{"path": "experience", "text": f"{have} effective years (internships at half weight)"}]
            if have >= need:
                row["status"] = "matched"
            elif have >= need - 1:
                row["status"] = "partial"
            else:
                row["status"] = "missing"
                row["gap_type"] = "genuine_gap"
            row["explanation"] = f"Requires about {need}+ years; resume shows about {have}."
            if tl.undated_entries:
                row["status"] = "unknown" if row["status"] == "missing" else row["status"]
                row["explanation"] += " Some roles are undated, so this is uncertain."
            if r.get("skills"):
                # "5+ years Python": the skill must be in the resume; years per skill can't be measured reliably,
                # so overall experience stands in for it and the explanation says so
                demo = [s for s in r["skills"] if s in ev.demonstrated]
                found = [s for s in r["skills"] if s in ev.all]
                need_all = not r.get("any_of")
                missing_sk = [s for s in r["skills"] if s not in ev.all]
                if not found or (need_all and missing_sk):
                    row["status"] = "missing" if not found else "partial"
                    row["gap_type"] = "genuine_gap" if not found else None
                    row["explanation"] = f"Not found in the resume: {', '.join(missing_sk)}. " + row["explanation"]
                else:
                    if not demo and row["status"] == "matched":
                        row["status"] = "partial"  # listed but never shown in work
                    row["evidence"] = [e for s in demo for e in ev.evidence.get(s, [])[:1]] + row["evidence"]
                    row["explanation"] = (f"{', '.join(found)} {'shown in your work' if demo else 'listed only'}; "
                                          f"about {have} years of experience overall (years per skill can't be measured). "
                                          f"Requires about {need}+ years.")
        elif kind == "education":
            need_lvl = r.get("degree_level")
            have_lvl = max((_degree_level(f"{e.degree or ''}") or 0 for e in c.education), default=0)
            if not c.education:
                row["status"] = "missing"
                row["gap_type"] = "possibly_unlisted"
                row["explanation"] = "No education entries in the resume."
            elif need_lvl is None or have_lvl == 0:
                row["status"] = "unknown"
                row["explanation"] = "Could not compare degree levels reliably."
            elif have_lvl >= need_lvl:
                row["status"] = "matched"
                row["explanation"] = "Degree level meets the stated requirement."
            else:
                row["status"] = "partial" if re.search(r"equivalent|or (relevant|related) experience", r["text"], re.I) else "missing"
                row["gap_type"] = None if row["status"] == "partial" else "genuine_gap"
                row["explanation"] = "Stated degree level is higher than the resume shows" + (" (equivalent experience accepted)." if row["status"] == "partial" else ".")
            row["evidence"] = [{"path": f"education/{e.id}", "text": e.degree or ""} for e in c.education[:2]]
        elif kind == "certification":
            words = {w for w in re.findall(r"[a-z]{3,}", r["text"].lower())} - {"certification", "certified", "certificate", "preferred", "required", "with", "and"}
            hit = [cert for cert in c.certifications if words & set(re.findall(r"[a-z]{3,}", cert.name.lower()))]
            if hit:
                row["status"] = "matched"
                row["evidence"] = [{"path": f"certifications/{x.id}", "text": x.name} for x in hit[:2]]
                row["explanation"] = "Matching certification found."
            else:
                row["status"] = "missing"
                row["gap_type"] = "possibly_unlisted" if not c.certifications else "genuine_gap"
                row["explanation"] = "No matching certification found."
        elif kind == "unassessable":
            row["status"] = "unknown"
            row["explanation"] = "This cannot be assessed from a resume; answer it directly in your application."
        else:  # other / soft
            top = best[0] if best else None
            if top and top["similarity"] >= 0.55:
                row["status"] = "partial"
                row["evidence"] = [top]
                row["explanation"] = "Possibly related evidence found by text similarity; check whether it really meets the requirement."
            else:
                row["status"] = "unknown"
                row["explanation"] = "No clear evidence either way."
        row["closest_evidence"] = best
        rows.append(row)

    def score(rs):
        pts = {"matched": 1.0, "partial": LISTED_CREDIT, "missing": 0.0}
        num = den = 0.0
        for x in rs:
            if x["status"] == "unknown":
                continue
            w = 1.0 if x["importance"] == "required" else 0.5
            num += pts[x["status"]] * w
            den += w
        return (num / den) if den else None

    req_score = score(rows)
    jd_sk = jd.get("skills", [])
    kw_present = [s for s in jd_sk if s in ev.all]
    kw_cov = len(kw_present) / len(jd_sk) if jd_sk else None
    jd_text = " ".join([jd.get("title") or ""] + jd.get("responsibilities", []) + [r["text"] for r in reqs])
    sem_raw = float(emb.similarity([evidence_text(c) or " "], [jd_text or " "])[0][0])
    sem = float(emb.normalise(sem_raw))
    parts = [(0.6, req_score), (0.2, kw_cov), (0.2, sem)]
    avail = [(w, v) for w, v in parts if v is not None]
    overall = round(100 * sum(w * v for w, v in avail) / sum(w for w, _ in avail)) if avail else None
    counts = {k: sum(1 for x in rows if x["status"] == k) for k in ("matched", "partial", "missing", "unknown")}
    exp_rows = [x for x in rows if x["kind"] == "experience"]
    return {
        "matcher_version": JD_MATCHER_VERSION,
        "embedding_model": emb.name,
        "overall": overall,
        "overall_label": "Compatibility indicator — not a hiring probability or ATS score",
        "formula": "60% requirement coverage (required=1, preferred=0.5 weight; matched=1, partial=0.5, unknown excluded) + 20% keyword coverage + 20% semantic alignment",
        "components": {
            "requirement_coverage": None if req_score is None else round(req_score, 3),
            "keyword_coverage": None if kw_cov is None else round(kw_cov, 3),
            "semantic_alignment": round(sem, 3),
            "semantic_raw_cosine": round(sem_raw, 4),
            "experience_alignment": exp_rows[0]["status"] if exp_rows else "not_stated",
        },
        "counts": counts,
        "requirements": rows,
        "keywords": {"present": kw_present, "absent": [s for s in jd_sk if s not in ev.all]},
        "genuine_gaps": [x["text"] for x in rows if x["gap_type"] == "genuine_gap"],
        "possibly_unlisted": [x["text"] for x in rows if x["gap_type"] == "possibly_unlisted"],
        "guidance": ("Address genuine gaps through learning or projects. For 'possibly unlisted' items, add them only if "
                     "you have real experience, and describe where you used them. Do not add keywords you cannot support."),
        # "requirements": scored mainly on checkable requirements; "similarity_only": nothing in the JD could be
        # checked against the resume (no recognised skills, years or degree), so the number is text similarity alone
        "basis": "requirements" if req_score is not None else "similarity_only",
        "jd_warnings": jd.get("warnings", []) + ([] if req_score is not None else ["no_assessable_requirements"]),
    }
