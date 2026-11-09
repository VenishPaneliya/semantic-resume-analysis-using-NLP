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
from app.services.ml.features import evidence_text, evidence_units, resume_skill_evidence
from app.services.taxonomy import get_taxonomy
from app.versions import JD_MATCHER_VERSION

SECTION_PATTERNS = {
    "responsibilities": r"(responsibilities|what you('| wi)ll do|the role|your role|duties|you will|key responsibilities|day to day)",
    "required": r"(requirements|qualifications|what you('| wi)ll need|must have|required|minimum qualifications|who you are|what we('re| are) looking for|skills required|basic qualifications)",
    "preferred": r"(preferred|nice to have|bonus|good to have|desired|plus|preferred qualifications|additional qualifications)",
    "about": r"(about (us|the company|the team)|who we are|benefits|perks|what we offer|compensation|equal opportunity)",
}
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
    (4, rf"\bmaster|\bm\.\s?s\b\.?|(?-i:\bMS\b){_MS_PRODUCT}|\bm\.?\s?sc\b|\bm\.?\s?tech\b|\bmba\b|\bm\.\s?e\b\.?|(?-i:\bME\b)|\bmca\b|\bpost[- ]?graduate\b"),
    (2, r"\bassociate'?s?\s+degree\b|\bassociate\s+of\b"),
    (3, r"\bbachelor|\bb\.\s?s\b\.?|(?-i:\bBS\b)|\bb\.?\s?sc\b|\bb\.?\s?tech\b|\bb\.\s?e\b\.?|(?-i:\bBE\b)|\bb\.\s?a\b\.?|(?-i:\bBA\b)"
        r"|\bbca\b|\bbba\b|\bb\.?\s?com\b|\bdegree in\b|\bundergraduate\b|\bgraduate degree\b"),
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
    for key, pat in SECTION_PATTERNS.items():
        if re.fullmatch(rf"\W*{pat}\W*.*", heading, re.I) and len(heading.split()) <= 7:
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


def _clean_title(line: str) -> str:
    return line.strip().rstrip(".:;-–— ").strip()[:150]


def extract_jd(text: str) -> dict:
    tax = get_taxonomy()
    text = _INLINE_HEADING.sub("\n", text.replace("\r", ""))
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
            lead = _LEADING_HEADING.match(ln)
            return not (lead and _section_of(lead.group("head")))

        first = next((ln for ln in lines if can_be_title(ln)), None)
        title = _clean_title(first) if first else None
    company = None
    cm = re.search(r"(?:company|employer)\s*[:\-]\s*(.+)", text, re.I)
    if cm:
        company = cm.group(1).strip()[:150]

    section = "intro"
    reqs: list[dict] = []
    responsibilities: list[str] = []
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
                section = _section_of(bare) or section
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
                continue
            if section in ("required", "preferred") or (section == "intro" and is_bullet):
                importance = "preferred" if section == "preferred" or re.search(r"\b(preferred|nice to have|bonus|plus|ideally)\b", item, re.I) else "required"
                reqs.append(_classify_requirement(item, importance, tax))

    # skills mentioned anywhere count toward keyword coverage
    all_skills = list(dict.fromkeys(h.skill for h in tax.find_skills(text)))
    if not reqs:
        # unstructured JD: fall back to one requirement per recognised skill
        for s in all_skills:
            reqs.append({"id": short_id(), "text": s, "kind": "skill", "importance": "required", "skills": [s], "any_of": False})
    years = None
    for r in reqs:
        if r["kind"] == "experience" and r.get("years_min") is not None:
            years = r["years_min"] if years is None else min(years, r["years_min"])
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


def _classify_requirement(item: str, importance: str, tax) -> dict:
    skills = list(dict.fromkeys(h.skill for h in tax.find_skills(item)))
    req = {"id": short_id(), "text": item[:400], "importance": importance, "skills": skills, "any_of": False}
    ym = YEARS_RE.search(item)
    if UNASSESSABLE.search(item):
        req["kind"] = "unassessable"
    elif ym and (skills or re.search(r"experience|exp\b|working|industry|professional", item, re.I)):
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


def match(content: dict | ResumeContent, jd: dict, as_of: str | None = None) -> dict:
    c = content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)
    tax = get_taxonomy()
    emb = get_embedder()
    ev = resume_skill_evidence(c)
    units = evidence_units(c)
    tl = build_timeline(c, as_of)
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
        pts = {"matched": 1.0, "partial": 0.5, "missing": 0.0}
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
        "jd_warnings": jd.get("warnings", []),
    }
