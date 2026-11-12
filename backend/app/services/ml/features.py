"""Feature extraction for ranking and matching.

FAIRNESS CONSTRAINT: ranking features are built only from job titles, bullet text, project
names/technologies/bullets, the skills section and degree field of study. Contact details
(name, email, phone, location, links), employer and institution names, photos, and any
protected attribute are deliberately excluded — employer/institution names can act as
proxies for protected attributes. Location is used only as a user-stated preference.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.schemas.resume import ResumeContent
from app.services.taxonomy import get_taxonomy


@dataclass
class SkillEvidence:
    listed: set[str] = field(default_factory=set)
    demonstrated: set[str] = field(default_factory=set)
    evidence: dict[str, list[dict]] = field(default_factory=dict)  # skill -> [{path, text}]

    @property
    def all(self) -> set[str]:
        return self.listed | self.demonstrated


def resume_skill_evidence(c: ResumeContent) -> SkillEvidence:
    tax = get_taxonomy()
    ev = SkillEvidence()
    for s in c.skills.technical + c.skills.soft:
        canon = tax.canonical(s) or (s if s in tax.skills else None)
        if canon:
            ev.listed.add(canon)
    for s in c.skills.other:
        canon = tax.canonical(s)
        if canon:
            ev.listed.add(canon)
    for path, _owner, text in c.all_bullets():
        for h in tax.find_skills(text):
            ev.demonstrated.add(h.skill)
            ev.evidence.setdefault(h.skill, []).append({"path": path, "text": text[:220]})
    for p in c.projects:
        for t in p.technologies:
            canon = tax.canonical(t)
            if canon:
                ev.demonstrated.add(canon)
                ev.evidence.setdefault(canon, []).append({"path": f"projects/{p.id}", "text": f"Project '{p.name}' uses {t}"})
    for e in c.experience:
        for h in tax.find_skills(e.title or ""):
            ev.demonstrated.add(h.skill)
            ev.evidence.setdefault(h.skill, []).append({"path": f"experience/{e.id}", "text": f"Job title: {e.title}"})
    # propagate implications from demonstrated skills only (Tableau => Data Visualization)
    frontier = list(ev.demonstrated)
    while frontier:
        s = frontier.pop()
        for imp in tax.skills[s].implies:
            if imp not in ev.demonstrated:
                ev.demonstrated.add(imp)
                frontier.append(imp)
            src = ev.evidence.get(s, [])[:1]
            ev.evidence.setdefault(imp, []).extend({**e, "via": s} for e in src)
    return ev


# One rule for "how much does this skill count", used by the rubric, the role recommender and job matching:
# shown in experience/projects = 1, only listed in the skills section = half, absent = 0.
LISTED_CREDIT = 0.5


def skill_credit(skill: str, ev: SkillEvidence) -> float:
    return 1.0 if skill in ev.demonstrated else LISTED_CREDIT if skill in ev.listed else 0.0


def coverage(skills: list[str], ev: SkillEvidence) -> float | None:
    return sum(skill_credit(s, ev) for s in skills) / len(skills) if skills else None


def evidence_text(c: ResumeContent) -> str:
    """Text used for semantic embedding — see FAIRNESS CONSTRAINT above."""
    parts: list[str] = []
    if c.summary:
        parts.append(c.summary)
    for e in c.experience:
        if e.title:
            parts.append(e.title)
        parts.extend(b.text for b in e.bullets)
    for p in c.projects:
        parts.append(p.name)
        if p.technologies:
            parts.append(", ".join(p.technologies))
        parts.extend(b.text for b in p.bullets)
    for ed in c.education:
        if ed.field_of_study:
            parts.append(ed.field_of_study)
    skills = c.skills.technical + c.skills.soft
    if skills:
        parts.append("Skills: " + ", ".join(skills))
    for cert in c.certifications:
        parts.append(cert.name)
    return "\n".join(parts)


def evidence_units(c: ResumeContent) -> list[tuple[str, str]]:
    """(path, text) units used to find the best evidence for a requirement."""
    units: list[tuple[str, str]] = []
    for path, _owner, text in c.all_bullets():
        units.append((path, text))
    for e in c.experience:
        if e.title:
            units.append((f"experience/{e.id}", f"{e.title}"))
    for p in c.projects:
        if p.technologies:
            units.append((f"projects/{p.id}", f"{p.name}: {', '.join(p.technologies)}"))
    if c.summary:
        units.append(("summary", c.summary))
    for cert in c.certifications:
        units.append((f"certifications/{cert.id}", cert.name))
    for ed in c.education:
        units.append((f"education/{ed.id}", " ".join(x for x in [ed.degree, ed.field_of_study] if x)))
    return units
