"""Deterministic grounding verification for generated text.

A generated claim is *grounded* if it appears in the user's confirmed resume content or in
facts the user explicitly confirmed. Checked claim types:

  number      — any figure (12, 40%, $3k, 2x) outside a [ADD: …] placeholder
  year        — four-digit years
  skill       — taxonomy skills mentioned in the output
  credential  — degree / certification words (PhD, Master's, certified, AWS Certified …)
  entity      — capitalised tokens that look like organisation or product names

Anything else is treated as wording. This is intentionally strict: false positives are
surfaced to the user as questions, never silently accepted.
"""

from __future__ import annotations

import re

from app.schemas.resume import ResumeContent
from app.services.taxonomy import get_taxonomy
from app.versions import GROUNDING_VERSION

PLACEHOLDER_RE = re.compile(r"\[(?:ADD|TODO|CONFIRM)[^\]]*\]", re.I)
NUM_RE = re.compile(r"(?<![A-Za-z])(?:[$₹€£]\s?)?\d+(?:[.,]\d+)*\s?(?:%|x|k|m|bn|\+)?(?![A-Za-z])", re.I)
YEAR_RE = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")
CREDENTIAL_RE = re.compile(
    r"\b(ph\.?\s?d|doctorate|master'?s|bachelor'?s|mba|m\.?sc|b\.?sc|b\.?tech|m\.?tech|degree|certified|certification|"
    r"certificate|licensed|chartered|cpa|pmp|cfa)\b", re.I
)
WORD_NUMS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8",
             "nine": "9", "ten": "10", "dozen": "12", "hundred": "100", "thousand": "1000", "million": "1000000"}
NUMWORD_RE = re.compile(r"\b(" + "|".join(WORD_NUMS) + r")\b", re.I)

# common capitalised words that are not entities
_COMMON = set("""
I A An The And Or But For With To In On At By Of From As Is Are Was Were Be Been This That These Those It Its
Our We You Your My Me He She They Their Led Built Designed Developed Created Managed Improved Reduced Increased
Delivered Implemented Automated Analysed Analyzed Supported Contributed Handled Owned Drove Launched Optimized
Optimised Migrated Wrote Tested Deployed Maintained Collaborated Partnered Mentored Trained Presented Researched
Shipped Scaled Streamlined Established Defined Coordinated Organised Organized Ran Monitored Resolved Achieved
Dear Sincerely Regards Hiring Manager Team Thank Thanks Additionally Also However Moreover Furthermore Currently
Previously Recently Most Over Across Within During While Using Through Including Such Example For Each Every New
Senior Junior Lead Engineer Developer Analyst Scientist Intern Manager Data Software Machine Learning Product
Monday Tuesday Wednesday Thursday Friday January February March April May June July August September October
November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Present Experience Summary Skills Projects
Education Certifications Achievements Languages Role Company Position Job Application Interview Question
""".split())


def _norm_num(s: str) -> str:
    s = s.lower().replace(",", "").replace(" ", "")
    s = re.sub(r"^[$₹€£]", "", s)
    return s.rstrip("+")


def _is_sentence_starter(word: str) -> bool:
    """Verbs and function words that commonly open a sentence are not entities."""
    from app.services.analysis.rubric import _is_action_verb

    w = word.lower()
    return _is_action_verb(w) or w.endswith(("ed", "ing", "ised", "ized")) or word in _COMMON


def _flat(s: str) -> str:
    return re.sub(r"[^a-z0-9+#]+", " ", s.lower()).strip()


def fact_text(content: ResumeContent, extra_facts: list[str] | None = None) -> str:
    c = content
    parts = [c.summary or ""]
    for e in c.experience:
        parts += [e.title or "", e.organization or "", e.location or "", e.start or "", e.end or ""]
        parts += [b.text for b in e.bullets]
    for ed in c.education:
        parts += [ed.degree or "", ed.field_of_study or "", ed.institution or "", ed.grade or "", ed.start or "", ed.end or ""]
        parts += ed.details
    for p in c.projects:
        parts += [p.name, *(p.technologies), *(b.text for b in p.bullets)]
    parts += c.skills.technical + c.skills.soft + c.skills.other
    for cert in c.certifications:
        parts += [cert.name, cert.issuer or "", cert.date or ""]
    parts += [a.text for a in c.achievements]
    parts += [lang.name for lang in c.languages]
    parts += extra_facts or []
    return "\n".join(x for x in parts if x)


def verify(output: str, content: ResumeContent, extra_facts: list[str] | None = None, source_text: str | None = None) -> dict:
    """`source_text` = the original text being rewritten; its claims are always allowed."""
    tax = get_taxonomy()
    facts = fact_text(content, extra_facts) + "\n" + (source_text or "")
    facts_low = facts.lower()
    placeholders = PLACEHOLDER_RE.findall(output)
    # placeholder *contents* are still checked so a placeholder cannot smuggle in claims;
    # only the marker word is removed
    body = re.sub(r"\[(?:ADD|TODO|CONFIRM)\s*:?", "[", output, flags=re.I)
    unsupported: list[dict] = [{"type": "placeholder", "value": p[:60] + "…"} for p in placeholders if len(p) > 100]

    fact_nums = {_norm_num(m.group(0)) for m in NUM_RE.finditer(facts)}
    for m in NUM_RE.finditer(body):
        raw = m.group(0).strip()
        v = _norm_num(raw)
        # a bare 4-digit year is checked by the year rule below; "2,000" is a number, not a year
        if v and v not in fact_nums and not YEAR_RE.fullmatch(raw):
            unsupported.append({"type": "number", "value": raw})
    for m in NUMWORD_RE.finditer(body):
        w = m.group(0).lower()
        if w not in facts_low and WORD_NUMS[w] not in fact_nums:
            unsupported.append({"type": "number", "value": m.group(0)})
    for m in YEAR_RE.finditer(body):
        if m.group(0) not in facts:
            unsupported.append({"type": "year", "value": m.group(0)})

    fact_skills = {h.skill for h in tax.find_skills(facts)}
    for h in tax.find_skills(body):
        if h.skill not in fact_skills:
            unsupported.append({"type": "skill", "value": h.matched})

    # credentials are checked as phrases ("certified AWS architect"), because the bare word
    # "certified" may legitimately appear in a different certification's name
    facts_flat = _flat(facts)
    for m in CREDENTIAL_RE.finditer(body):
        phrase = " ".join(re.findall(r"[\w'+#.]+", body[m.start():])[:3])
        if _flat(phrase) not in facts_flat:
            unsupported.append({"type": "credential", "value": phrase})

    skill_terms = {t.lower() for s in tax.skills.values() for t in (s.name, *s.aliases)}
    for sent in re.split(r"(?<=[.!?])\s+|\n", body):
        tokens = re.findall(r"[A-Za-z][\w&.+#-]*", sent)
        for i, tok in enumerate(tokens):
            clean = tok.rstrip(".")
            if not clean[:1].isupper() or clean in _COMMON or clean.lower() in skill_terms:
                continue
            if i == 0 and _is_sentence_starter(clean):
                continue
            if len(clean) < 2 or clean.lower() in facts_low:
                continue
            unsupported.append({"type": "entity", "value": clean})

    seen = set()
    uniq = []
    for u in unsupported:
        k = (u["type"], u["value"].lower())
        if k not in seen:
            seen.add(k)
            uniq.append(u)
    return {"grounded": not uniq, "unsupported": uniq, "placeholders": placeholders, "version": GROUNDING_VERSION}
