"""Published, deterministic resume rubric.

Scores are advisory indicators of how clearly a resume communicates evidence. They are not
an ATS score and do not predict hiring outcomes. Every deduction references a rule in
RULES (with its rationale) and cites resume evidence where it exists.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from app.schemas.resume import ResumeContent
from app.services.analysis.experience import build_timeline
from app.services.taxonomy import get_taxonomy
from app.versions import RUBRIC_VERSION

CATEGORIES = {
    "completeness": {"name": "Section completeness", "weight": 15},
    "bullet_quality": {"name": "Bullet-point quality", "weight": 20},
    "quantification": {"name": "Quantified achievements", "weight": 15},
    "action_verbs": {"name": "Action verbs & repetition", "weight": 10},
    "clarity": {"name": "Clarity & readability", "weight": 10},
    "skill_evidence": {"name": "Skill coverage & evidence", "weight": 15},
    "dates": {"name": "Dates & timeline consistency", "weight": 10},
    "parsing": {"name": "Document parsing quality", "weight": 5},
}

# rule id -> definition. points = maximum deduction within its category (0-100 scale).
RULES: dict[str, dict] = {
    "missing_email": {"cat": "completeness", "points": 20, "effort": "low",
        "why": "Recruiters need a reliable way to contact you.", "fix": "Add a professional email address to the header."},
    "missing_phone": {"cat": "completeness", "points": 8, "effort": "low",
        "why": "Many recruiters call shortlisted candidates.", "fix": "Add a phone number, or note your preferred contact method."},
    "missing_experience_and_projects": {"cat": "completeness", "points": 35, "effort": "high",
        "why": "Without work or project entries there is no evidence of applied skills.",
        "fix": "Add work, internship, or project entries describing what you built and the outcome."},
    "missing_experience": {"cat": "completeness", "points": 8, "effort": "medium",
        "why": "Work or internship history is the strongest evidence for most roles; projects partly substitute for early-career candidates.",
        "fix": "If you have internships, part-time or volunteer technical work, add it as experience."},
    "missing_education": {"cat": "completeness", "points": 12, "effort": "low",
        "why": "Many postings screen on education or equivalent experience.", "fix": "Add your highest qualification with institution and year."},
    "missing_skills": {"cat": "completeness", "points": 12, "effort": "low",
        "why": "A skills section helps readers and keyword search find your core tools quickly.",
        "fix": "Add a concise skills section grouped by category (e.g. Languages, Frameworks, Tools)."},
    "missing_summary": {"cat": "completeness", "points": 8, "effort": "low",
        "why": "A 2–3 line summary frames the rest of the resume for a specific role.",
        "fix": "Add a short summary stating your focus area and strongest evidence."},
    "missing_links": {"cat": "completeness", "points": 5, "effort": "low",
        "why": "Technical reviewers often look for a portfolio, GitHub or LinkedIn.", "fix": "Add relevant professional links if you have them."},
    "bullet_too_short": {"cat": "bullet_quality", "points": 0, "effort": "low",
        "why": "Very short bullets rarely explain what you did or why it mattered.",
        "fix": "Expand to: action + what you did + tool/method + outcome."},
    "bullet_too_long": {"cat": "bullet_quality", "points": 0, "effort": "low",
        "why": "Bullets over ~35 words are hard to scan.", "fix": "Split into two bullets or remove secondary detail."},
    "bullet_weak_opening": {"cat": "bullet_quality", "points": 0, "effort": "low",
        "why": "Phrases like 'responsible for' describe duties rather than contributions.",
        "fix": "Start with what you did, e.g. 'Built', 'Reduced', 'Led'."},
    "bullet_no_outcome": {"cat": "bullet_quality", "points": 0, "effort": "medium",
        "why": "Bullets that show a result or purpose are more persuasive than task lists.",
        "fix": "Add the result or purpose (e.g. 'so that…', 'which reduced…'). Only state outcomes you can verify."},
    "few_bullets": {"cat": "bullet_quality", "points": 15, "effort": "medium",
        "why": "Entries with no bullets give no evidence of what you did.", "fix": "Add 2–5 bullets for each role or project."},
    "low_quantification": {"cat": "quantification", "points": 0, "effort": "medium",
        "why": "Numbers (scale, time saved, users, accuracy) make impact concrete and comparable.",
        "fix": "Where you have real figures, add them. If you do not know a number, describe scale qualitatively — do not estimate."},
    "weak_action_verbs": {"cat": "action_verbs", "points": 0, "effort": "low",
        "why": "Strong verbs make your contribution explicit.", "fix": "Begin bullets with a specific past-tense verb."},
    "repeated_verb": {"cat": "action_verbs", "points": 10, "effort": "low",
        "why": "Repeating the same opening verb reads as monotonous and hides variety in your work.",
        "fix": "Vary verbs to reflect what you actually did (designed, migrated, analysed…)."},
    "repeated_phrase": {"cat": "action_verbs", "points": 8, "effort": "low",
        "why": "Repeated phrases waste space.", "fix": "Rephrase or merge bullets that repeat the same wording."},
    "first_person": {"cat": "action_verbs", "points": 10, "effort": "low",
        "why": "Resume convention omits 'I/my'; it saves space.", "fix": "Remove first-person pronouns from bullets."},
    "long_summary": {"cat": "clarity", "points": 15, "effort": "low",
        "why": "Summaries over ~80 words are often skipped.", "fix": "Cut the summary to 2–3 sentences."},
    "cliches": {"cat": "clarity", "points": 15, "effort": "low",
        "why": "Generic self-descriptions ('hardworking', 'team player') carry no evidence.",
        "fix": "Replace with a concrete example that demonstrates the trait."},
    "passive_voice": {"cat": "clarity", "points": 15, "effort": "low",
        "why": "Passive phrasing obscures who did the work.", "fix": "Rewrite in active voice with you as the actor."},
    "long_sentences": {"cat": "clarity", "points": 15, "effort": "low",
        "why": "Long sentences reduce readability.", "fix": "Keep sentences under ~30 words."},
    "skills_not_demonstrated": {"cat": "skill_evidence", "points": 0, "effort": "medium",
        "why": "Skills that appear only in a list are weaker evidence than skills shown in work or projects.",
        "fix": "Where true, mention the skill in the bullet describing where you used it."},
    "undated_entry": {"cat": "dates", "points": 15, "effort": "low",
        "why": "Missing dates make it hard to judge recency and duration.", "fix": "Add month and year for start and end."},
    "invalid_dates": {"cat": "dates", "points": 25, "effort": "low",
        "why": "An end date before a start date looks like an error.", "fix": "Check and correct these dates."},
    "future_dates": {"cat": "dates", "points": 15, "effort": "low",
        "why": "Start dates in the future may be a typo.", "fix": "Correct the date, or label the role as 'incoming'."},
    "overlapping_roles": {"cat": "dates", "points": 10, "effort": "low",
        "why": "Overlapping full-time roles can prompt questions; it may be legitimate (e.g. a side role).",
        "fix": "If one role was part-time or contract, label it; otherwise check the dates."},
    "employment_gap": {"cat": "dates", "points": 0, "effort": "low",
        "why": "Informational only — gaps are common and not a defect. Some readers ask about them.",
        "fix": "Optionally note relevant activity (study, caregiving, projects) if you want to address it."},
    "year_only_dates": {"cat": "dates", "points": 5, "effort": "low",
        "why": "Year-only dates make durations ambiguous.", "fix": "Use month and year where you know them."},
    "uncertain_extraction": {"cat": "parsing", "points": 0, "effort": "low",
        "why": "Parts of the document could not be read reliably; automated screening tools may have similar trouble.",
        "fix": "Review the flagged fields. Simple single-column layouts with standard headings parse most reliably."},
    "unparsed_section": {"cat": "parsing", "points": 20, "effort": "medium",
        "why": "A section heading was found but its contents could not be parsed.",
        "fix": "Check the section in the review screen; avoid tables or text boxes for core content."},
    "ocr_used": {"cat": "parsing", "points": 30, "effort": "medium",
        "why": "The document has no text layer, so text came from OCR and may contain errors. Many screening systems cannot read image-only PDFs.",
        "fix": "Export your resume as a text-based PDF from your editor."},
    "header_content": {"cat": "parsing", "points": 10, "effort": "low",
        "why": "Content in the page header/footer is skipped by some parsers.", "fix": "Move contact details into the main body."},
    "many_fonts": {"cat": "parsing", "points": 10, "effort": "low",
        "why": "The document embeds many distinct fonts (measured from the file).", "fix": "Use one or two font families."},
    "embedded_instructions": {"cat": "parsing", "points": 40, "effort": "low",
        "why": "The document contains text that looks like instructions to an AI system. It was ignored, but many screeners treat this as manipulation.",
        "fix": "Remove hidden or instruction-like text from your resume."},
}

ACTION_VERBS = set("""
accelerated achieved acquired adapted addressed administered advised advocated analysed analyzed annotated
applied architected arranged assembled assessed audited authored automated balanced benchmarked boosted
briefed budgeted built calculated campaigned captured catalogued championed clarified classified coached
coded collaborated collected compiled completed composed computed conceived conceptualized conducted
configured consolidated constructed consulted containerized contributed converted coordinated corrected
created cultivated curated customized cut debugged decreased defined delivered deployed derived designed
detected determined developed devised diagnosed directed discovered documented doubled drafted drove
edited educated eliminated enabled engineered enhanced established estimated evaluated examined executed
expanded expedited experimented explored extended extracted facilitated fixed forecasted formalized
formulated founded generated grew guided halved handled harmonized identified implemented improved
increased influenced initiated innovated inspected installed instituted instrumented integrated interpreted
interviewed introduced investigated launched led leveraged maintained managed mapped measured mentored
merged migrated minimized modeled modelled modernized monitored motivated negotiated normalized onboarded
operated optimized orchestrated organized outperformed overhauled oversaw parallelized partnered performed
piloted pioneered planned predicted prepared presented prioritized processed produced profiled programmed
promoted prototyped provisioned published queried raised ran rebuilt redesigned reduced refactored
refined regulated reorganized replaced reported researched resolved restructured retrained revamped
reviewed revised scaled scheduled scoped scraped secured segmented selected served shipped simplified
solved sourced spearheaded standardized streamlined strengthened structured supervised supported
surveyed synthesized taught tested tracked trained transformed translated tuned unified upgraded validated
visualized won wrote
""".split())
WEAK_OPENINGS = re.compile(
    r"^(responsible for|worked on|working on|helped( to)?|assisted (in|with)|involved in|duties included|"
    r"tasked with|participated in|in charge of|handled various|did|was part of)\b", re.I
)
CLICHES = re.compile(
    r"\b(hard[- ]?working|team player|go[- ]getter|self[- ]starter|results[- ]driven|detail[- ]oriented|"
    r"think outside the box|synergy|dynamic individual|passionate about|quick learner|highly motivated|"
    r"proven track record|out of the box)\b", re.I
)
PASSIVE = re.compile(r"\b(was|were|been|being|is|are)\s+(\w+ed|built|made|done|given|taken|written|run)\b(\s+by\b)?", re.I)
NUMBER = re.compile(r"(\d+(\.\d+)?\s?(%|x|k|m|\+)?|\$\s?\d|₹\s?\d|€\s?\d|£\s?\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million)\b)", re.I)
OUTCOME = re.compile(
    r"\b(result(ing|ed)? in|leading to|which|so that|to (reduce|improve|increase|enable|support|cut|speed)|"
    r"reduc|improv|increas|sav|cut|faster|enabl|boost|grew|growth|accuracy|latency|revenue|cost|users?|customers?)",
    re.I,
)
FIRST_PERSON = re.compile(r"\b(I|my|me|I'm|I've)\b")


@dataclass
class Finding:
    rule: str
    message: str
    evidence: list[dict] = field(default_factory=list)
    points: float = 0.0

    def as_dict(self) -> dict:
        r = RULES[self.rule]
        return {
            "rule": self.rule,
            "message": self.message,
            "points": round(self.points, 1),
            "why": r["why"],
            "suggestion": r["fix"],
            "effort": r["effort"],
            "evidence": self.evidence[:6],
        }


def _words(t: str) -> list[str]:
    return re.findall(r"[A-Za-z][A-Za-z'+#.-]*", t)


def _first_verb(t: str) -> str:
    w = _words(t)
    return w[0].lower() if w else ""


def _is_action_verb(v: str) -> bool:
    # accept base/present forms of listed past-tense verbs ("forecast", "build" -> "built" is listed)
    return v in ACTION_VERBS or f"{v}ed" in ACTION_VERBS or f"{v}d" in ACTION_VERBS or (
        v.endswith("s") and (f"{v[:-1]}ed" in ACTION_VERBS or f"{v[:-1]}d" in ACTION_VERBS)
    ) or v in {"build", "lead", "run", "write", "drive", "grow", "win", "forecast", "cut", "set", "own", "owned"}


def _ev(path: str, text: str) -> dict:
    return {"path": path, "text": text[:220]}


def published_rubric() -> dict:
    return {
        "version": RUBRIC_VERSION,
        "disclaimer": (
            "Advisory indicators of how clearly the resume communicates evidence. Not an ATS score; "
            "does not predict interviews or hiring decisions."
        ),
        "categories": [{"id": k, **v} for k, v in CATEGORIES.items()],
        "rules": [{"id": k, "category": v["cat"], "max_points": v["points"] or "proportional", "why": v["why"],
                   "suggestion": v["fix"], "effort": v["effort"]} for k, v in RULES.items()],
        "scoring": (
            "Each category starts at 100. Fixed rules subtract their points once; proportional rules subtract "
            "in proportion to the share of bullets affected. Category scores are clamped to 0–100. The overall "
            "indicator is the weight-averaged score over categories that had enough data; categories without "
            "data are reported as 'insufficient data' and excluded rather than scored as zero."
        ),
    }


def analyse(content: dict | ResumeContent, extraction: dict | None = None, target_role: str | None = None) -> dict:
    c = content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)
    ex = extraction or {}
    tax = get_taxonomy()
    findings: dict[str, list[Finding]] = {k: [] for k in CATEGORIES}
    status: dict[str, str] = {k: "scored" for k in CATEGORIES}
    notes: dict[str, list[str]] = {k: [] for k in CATEGORIES}
    unparsed = {u["section"] for u in ex.get("unparsed_sections", [])}
    not_extracted: list[dict] = []

    def add(rule: str, message: str, evidence=None, points=None):
        f = Finding(rule, message, evidence or [], RULES[rule]["points"] if points is None else points)
        findings[RULES[rule]["cat"]].append(f)

    # ---------------- completeness (missing vs. not extracted)
    def missing_or_unparsed(section: str, rule: str, msg: str):
        if section in unparsed:
            not_extracted.append({"section": section, "message": f"A '{section}' heading was found but its contents could not be extracted reliably. Please review it."})
        else:
            add(rule, msg)

    if not c.contact.email:
        add("missing_email", "No email address was found.")
    if not c.contact.phone:
        add("missing_phone", "No phone number was found.")
    if not c.contact.links:
        add("missing_links", "No professional links (LinkedIn, GitHub, portfolio) were found.")
    if not c.experience and not c.projects:
        if {"experience", "projects"} & unparsed:
            missing_or_unparsed("experience" if "experience" in unparsed else "projects", "missing_experience_and_projects", "")
        else:
            add("missing_experience_and_projects", "No work experience or project entries were found.")
    elif not c.experience:
        missing_or_unparsed("experience", "missing_experience", "No work or internship entries; projects are present.")
    if not c.education:
        missing_or_unparsed("education", "missing_education", "No education entry was found.")
    if not (c.skills.technical or c.skills.other):
        missing_or_unparsed("skills", "missing_skills", "No skills section was found.")
    if not c.summary:
        missing_or_unparsed("summary", "missing_summary", "No summary or profile was found.")

    # ---------------- bullets
    bullets = c.all_bullets()
    if not bullets:
        for k in ("bullet_quality", "quantification", "action_verbs"):
            status[k] = "insufficient_data"
            notes[k].append("No bullet points were found to evaluate.")
    else:
        n = len(bullets)
        short, long_, weak, no_outcome, unquant, weakverb = [], [], [], [], [], []
        for path, _owner, text in bullets:
            wc = len(_words(text))
            if wc < 6:
                short.append(_ev(path, text))
            if wc > 35:
                long_.append(_ev(path, text))
            if WEAK_OPENINGS.match(text.strip()):
                weak.append(_ev(path, text))
            if not NUMBER.search(text) and not OUTCOME.search(text):
                no_outcome.append(_ev(path, text))
            if not NUMBER.search(text):
                unquant.append(_ev(path, text))
            v = _first_verb(text)
            if not _is_action_verb(v) and not WEAK_OPENINGS.match(text.strip()):
                weakverb.append(_ev(path, text))

        def prop(rule, items, weight, label):
            if items:
                add(rule, f"{len(items)} of {n} bullets {label}.", items, points=weight * len(items) / n)

        prop("bullet_too_short", short, 30, "are very short (under 6 words)")
        prop("bullet_too_long", long_, 25, "are long (over 35 words)")
        prop("bullet_weak_opening", weak, 35, "open with duty phrases such as 'responsible for'")
        prop("bullet_no_outcome", no_outcome, 30, "state a task without a result or purpose")
        empty_entries = [e for e in c.experience if not e.bullets] + [p for p in c.projects if not p.bullets]
        if empty_entries:
            add("few_bullets", f"{len(empty_entries)} entr{'y has' if len(empty_entries) == 1 else 'ies have'} no bullet points.",
                [_ev(f"experience/{e.id}" if hasattr(e, "organization") else f"projects/{e.id}",
                     getattr(e, "title", None) or getattr(e, "name", "") or "") for e in empty_entries])

        share = 1 - len(unquant) / n
        target = 0.5
        if share < target:
            add("low_quantification", f"{n - len(unquant)} of {n} bullets ({share:.0%}) include a number; the rubric target is {target:.0%}.",
                unquant, points=100 * (1 - share / target))
        else:
            notes["quantification"].append(f"{share:.0%} of bullets include a number (target {target:.0%}).")

        prop("weak_action_verbs", weakverb, 50, "do not begin with a recognised action verb")
        starters = Counter(_first_verb(t) for _, _, t in bullets if _first_verb(t) in ACTION_VERBS)
        rep = [(v, k) for v, k in starters.items() if k >= 3 and k / n > 0.25]
        for v, k in rep:
            add("repeated_verb", f"'{v.capitalize()}' starts {k} of {n} bullets.",
                [_ev(p, t) for p, _, t in bullets if _first_verb(t) == v])
        grams: Counter[str] = Counter()
        for _, _, t in bullets:
            w = [x.lower() for x in _words(t)]
            grams.update({" ".join(w[i:i + 3]) for i in range(len(w) - 2)})
        stop = {"of the", "in the", "and the", "to the"}
        reps = [g for g, k in grams.most_common(5) if k >= 3 and not any(s in g for s in stop)]
        if reps:
            add("repeated_phrase", f"Phrases repeated across 3+ bullets: {', '.join(repr(r) for r in reps[:3])}.",
                [_ev(p, t) for p, _, t in bullets if any(r in t.lower() for r in reps)])
        fp = [_ev(p, t) for p, _, t in bullets if FIRST_PERSON.search(t)]
        if fp:
            add("first_person", f"{len(fp)} bullets use first-person pronouns.", fp)

    # ---------------- clarity
    texts = [(p, t) for p, _, t in bullets]
    if c.summary:
        texts.append(("summary", c.summary))
        if len(_words(c.summary)) > 80:
            add("long_summary", f"The summary is {len(_words(c.summary))} words.", [_ev("summary", c.summary)])
    if not texts:
        status["clarity"] = "insufficient_data"
        notes["clarity"].append("No summary or bullet text to evaluate.")
    else:
        cl = [_ev(p, t) for p, t in texts if CLICHES.search(t)]
        if cl:
            add("cliches", f"Generic self-descriptions found in {len(cl)} place(s).", cl)
        pv = [_ev(p, t) for p, t in texts if PASSIVE.search(t)]
        if pv:
            add("passive_voice", f"Passive phrasing found in {len(pv)} place(s).", pv)
        ls = [_ev(p, s) for p, t in texts for s in re.split(r"(?<=[.!?])\s+", t) if len(_words(s)) > 30]
        if ls:
            add("long_sentences", f"{len(ls)} sentence(s) exceed 30 words.", ls)

    # ---------------- skill evidence
    listed = list(dict.fromkeys(c.skills.technical))
    if not listed:
        status["skill_evidence"] = "insufficient_data"
        notes["skill_evidence"].append("No recognised technical skills were listed.")
    else:
        evidence_text = " \n".join(t for _, _, t in bullets) + " \n" + " ".join(
            tech for p in c.projects for tech in p.technologies
        ) + " " + " ".join(f"{e.title or ''}" for e in c.experience)
        demonstrated = {h.skill for h in tax.find_skills(evidence_text)}
        undemo = [s for s in listed if s not in demonstrated]
        share = 1 - len(undemo) / len(listed)
        notes["skill_evidence"].append(f"{len(listed) - len(undemo)} of {len(listed)} listed technical skills appear in experience or project evidence.")
        if share < 0.6:
            add("skills_not_demonstrated", f"{len(undemo)} listed skills are not shown in any experience or project: {', '.join(undemo[:8])}.",
                [{"path": "skills", "text": s} for s in undemo], points=100 * (0.6 - share) / 0.6)

    # ---------------- dates
    tl = build_timeline(c)
    if not c.experience and not c.education:
        status["dates"] = "insufficient_data"
        notes["dates"].append("No dated entries to evaluate.")
    else:
        label = {e.id: f"{e.title or 'Role'} @ {e.organization or '?'}" for e in c.experience}
        label.update({e.id: f"{e.degree or 'Education'} — {e.institution or '?'}" for e in c.education})
        if tl.undated_entries:
            add("undated_entry", f"{len(tl.undated_entries)} experience entr{'y is' if len(tl.undated_entries) == 1 else 'ies are'} missing dates.",
                [_ev(f"experience/{i}", label.get(i, i)) for i in tl.undated_entries])
        if tl.invalid:
            add("invalid_dates", "Some entries have an end date before the start date.", [_ev(i, f"{label.get(i, i)}: {m}") for i, m in tl.invalid])
        if tl.future:
            add("future_dates", "Some roles start in the future.", [_ev(f"experience/{i}", label.get(i, i)) for i in tl.future])
        for a, b, months in tl.overlaps:
            add("overlapping_roles", f"Two full-time roles overlap by about {months} months.", [_ev(f"experience/{a}", label[a]), _ev(f"experience/{b}", label[b])])
        for a, b, months in tl.gaps:
            add("employment_gap", f"About {months} months between roles (informational).", [_ev(f"experience/{a}", label[a]), _ev(f"experience/{b}", label[b])])
        yo = [e for e in c.experience if (e.start and len(e.start) == 4) or (e.end and len(e.end) == 4)]
        if yo:
            add("year_only_dates", f"{len(yo)} entr{'y uses' if len(yo) == 1 else 'ies use'} year-only dates.", [_ev(f"experience/{e.id}", label[e.id]) for e in yo])

    # ---------------- parsing (measured only)
    if not ex:
        status["parsing"] = "not_applicable"
        notes["parsing"].append("No source document (content was entered manually).")
    else:
        unc = ex.get("uncertain", [])
        if unc:
            add("uncertain_extraction", f"{len(unc)} field(s) were extracted with low confidence.",
                [{"path": u["path"], "text": u["reason"]} for u in unc], points=min(40, 5 * len(unc)))
        for u in ex.get("unparsed_sections", []):
            add("unparsed_section", f"The '{u['section']}' section could not be parsed.", [{"path": u["section"], "text": u["reason"]}])
        if ex.get("ocr_used"):
            add("ocr_used", "Text was obtained by OCR.")
        warnings = set(ex.get("warnings", []))
        if "content_in_page_header" in warnings:
            add("header_content", "Some content is in the page header.")
        if "embedded_instructions_detected" in warnings:
            add("embedded_instructions", "Instruction-like text aimed at AI systems was detected and ignored.")
        layout = ex.get("layout", {})
        if layout.get("distinct_font_count", 0) > 4:
            add("many_fonts", f"{layout['distinct_font_count']} distinct fonts are embedded.")
        if layout.get("page_count"):
            notes["parsing"].append(f"Measured: {layout['page_count']} page(s); body font size ≈ {layout.get('body_font_size_pt')} pt.")

    # ---------------- scoring
    categories = []
    total_w = 0.0
    total = 0.0
    for key, meta in CATEGORIES.items():
        fs = findings[key]
        if status[key] != "scored":
            score = None
        else:
            score = max(0.0, min(100.0, 100 - sum(f.points for f in fs)))
            total += score * meta["weight"]
            total_w += meta["weight"]
        categories.append({
            "id": key, "name": meta["name"], "weight": meta["weight"], "status": status[key],
            "score": None if score is None else round(score),
            "findings": [f.as_dict() for f in sorted(fs, key=lambda f: -f.points)],
            "notes": notes[key],
        })

    role_cov = role_keyword_coverage(c, target_role) if target_role else None

    improvements = []
    for cat in categories:
        for f in cat["findings"]:
            if f["rule"] == "employment_gap":  # informational, never a to-do
                continue
            weighted = f["points"] * CATEGORIES[cat["id"]]["weight"] / 100
            priority = "high" if weighted >= 3 else "medium" if weighted >= 1 else "low"
            improvements.append({
                "issue": f["message"], "category": cat["name"], "rule": f["rule"], "why": f["why"],
                "evidence": f["evidence"][:3], "suggestion": f["suggestion"], "priority": priority,
                "effort": f["effort"], "impact": round(weighted, 2),
            })
    order = {"high": 0, "medium": 1, "low": 2}
    effort_order = {"low": 0, "medium": 1, "high": 2}
    improvements.sort(key=lambda i: (order[i["priority"]], effort_order[i["effort"]], -i["impact"]))

    return {
        "rubric_version": RUBRIC_VERSION,
        "taxonomy_version": tax.version,
        "overall": round(total / total_w) if total_w else None,
        "overall_label": "Advisory indicator (not an ATS score)",
        "categories": categories,
        "not_extracted": not_extracted,
        "improvements": improvements,
        "role_keyword_coverage": role_cov,
        "timeline": {
            "professional_years": tl.professional_years,
            "internship_months": tl.internship_months,
            "effective_years": tl.effective_years,
        },
        "stats": {
            "bullets": len(bullets),
            "experience_entries": len(c.experience),
            "project_entries": len(c.projects),
            "listed_technical_skills": len(c.skills.technical),
        },
    }


def role_keyword_coverage(c: ResumeContent, role_id: str) -> dict | None:
    tax = get_taxonomy()
    role = tax.roles.get(role_id)
    if not role:
        return None
    from app.services.ml.features import resume_skill_evidence

    ev = resume_skill_evidence(c)
    def status_of(s):
        if s in ev.demonstrated:
            return "demonstrated"
        if s in ev.listed:
            return "listed_only"
        return "absent"
    req = [{"skill": s, "status": status_of(s)} for s in role.required_skills]
    pref = [{"skill": s, "status": status_of(s)} for s in role.preferred_skills]
    present = sum(1 for x in req if x["status"] != "absent")
    return {
        "role_id": role.id, "role_title": role.title,
        "required": req, "preferred": pref,
        "required_coverage": round(present / len(req), 2) if req else None,
        "preferred_coverage": round(sum(1 for x in pref if x["status"] != "absent") / len(pref), 2) if pref else None,
        "note": "Keyword coverage shows which role terms appear in your resume. Only add skills you genuinely have.",
    }
