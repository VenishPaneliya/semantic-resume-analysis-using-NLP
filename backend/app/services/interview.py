"""Mock interview feedback.

Two layers, always labelled separately in the API:
- `checks`: deterministic, rule-based structure checks (STAR elements, ownership, measurable results,
  length, links to the resume). Always available, no AI.
- `ai`: optional coaching from the configured provider (consent + quota apply). It may only point out
  what is missing or unclear and ask the candidate to add details they really have; it never writes
  claims for them.
"""

from __future__ import annotations

import re

from app.schemas.resume import ResumeContent
from app.services.ml.features import resume_skill_evidence
from app.services.taxonomy import get_taxonomy

SITUATION = re.compile(r"\b(when|while|at (my|our|the)|our team|the (project|problem|issue|client|goal|challenge)|we (had|needed|were)|there was)\b", re.I)
ACTION_I = re.compile(r"\bI\s+(built|designed|led|wrote|created|implemented|fixed|reduced|improved|analy[sz]ed|set up|migrated|automated|"
                      r"owned|decided|proposed|investigated|debugged|refactored|trained|tested|deployed|organi[sz]ed|negotiated|"
                      r"presented|mentored|coordinated|developed|introduced|chose|started|delivered)\b", re.I)
RESULT = re.compile(r"\b(result(ed)?|so that|which (cut|reduced|increased|improved|saved)|reduc|increas|improv|saved|cut|grew|"
                    r"launched|shipped|achiev|outcome|impact)\w*", re.I)
NUMBER = re.compile(r"\d")
WE = re.compile(r"\bwe\b", re.I)
I_ = re.compile(r"\bI\b")


def rule_checks(question: str, answer: str, content: ResumeContent) -> dict:
    words = len(answer.split())
    tax = get_taxonomy()
    ev = resume_skill_evidence(content)
    mentioned = {h.skill for h in tax.find_skills(answer)}
    items = [
        {"id": "situation", "ok": bool(SITUATION.search(answer)), "label": "Sets the scene",
         "tip": "Start with one sentence of context: where you were and what problem you faced."},
        {"id": "action", "ok": bool(ACTION_I.search(answer)), "label": "Says what *you* did",
         "tip": "Describe your own actions with 'I …' (built, decided, fixed), not only what the team did."},
        {"id": "result", "ok": bool(RESULT.search(answer)), "label": "Ends with a result",
         "tip": "Finish with the outcome: what changed because of your work."},
        {"id": "measurable", "ok": bool(NUMBER.search(answer)), "label": "Has a measurable detail",
         "tip": "If you know a real number (time saved, users, accuracy), include it. Don't estimate one you don't know."},
        {"id": "length", "ok": 60 <= words <= 300, "label": "Good length (60–300 words)",
         "tip": "Too short sounds vague; too long loses the interviewer. Aim for about 1–2 minutes spoken."
                if words < 60 else "Trim to the key steps and the result; about 1–2 minutes spoken."},
        {"id": "ownership", "ok": len(I_.findall(answer)) >= len(WE.findall(answer)), "label": "Clear ownership",
         "tip": "You used 'we' more than 'I'. Interviewers want to know your part."},
        {"id": "evidence", "ok": bool(mentioned & ev.all) or len(mentioned) == 0, "label": "Consistent with your resume",
         "tip": "You mention skills your resume doesn't show: "
                + ", ".join(sorted(mentioned - ev.all)[:4]) + ". Be ready for follow-up questions on them."},
    ]
    passed = sum(1 for i in items if i["ok"])
    return {"kind": "rule_based", "label": "Structure checks (rule-based, not AI)", "words": words,
            "score": round(1 + 4 * passed / len(items), 1), "items": items,
            "skills_mentioned": sorted(mentioned)}
