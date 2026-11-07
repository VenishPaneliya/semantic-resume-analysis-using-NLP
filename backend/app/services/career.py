"""Career development: roadmap, portfolio projects, interview questions, learning resources.

Learning resources and job listings come only from configured providers. Without one, the
API returns an explicit `unavailable` state — never fabricated links or listings."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.schemas.resume import ResumeContent
from app.services.ml.recommender import skill_gap

DATA = Path(__file__).resolve().parents[2] / "data" / "career"


@lru_cache
def project_catalog() -> dict:
    return json.loads((DATA / "projects_v1.json").read_text(encoding="utf-8"))


def portfolio_projects(gap_skills: list[str], role_id: str | None, limit: int = 4) -> list[dict]:
    cat = project_catalog()["projects"]
    scored = []
    for p in cat:
        overlap = [s for s in p["skills"] if s in gap_skills]
        role_bonus = 1 if role_id and role_id in p["roles"] else 0
        if overlap or role_bonus:
            scored.append((len(overlap) * 2 + role_bonus, p, overlap))
    scored.sort(key=lambda x: -x[0])
    return [{**p, "builds_evidence_for": ov} for _, p, ov in scored[:limit]]


class ResourceProvider:
    name = "none"

    def lookup(self, skill: str) -> dict:
        return {"status": "unavailable", "provider": None,
                "message": "No learning-resource provider is configured, so no resources are shown. "
                           "An administrator can configure LEARNING_RESOURCES_PROVIDER."}


class CuratedFileProvider(ResourceProvider):
    """Reads admin-maintained, verified resources: [{skill, title, url, source, retrieved_on}]."""

    name = "curated_file"

    def __init__(self, path: str) -> None:
        self.items = json.loads(Path(path).read_text(encoding="utf-8"))

    def lookup(self, skill: str) -> dict:
        rows = [r for r in self.items if r.get("skill", "").lower() == skill.lower() and r.get("url") and r.get("retrieved_on")]
        return {"status": "ok" if rows else "empty", "provider": self.name,
                "resources": [{k: r[k] for k in ("title", "url", "source", "retrieved_on") if k in r} for r in rows[:5]]}


def resource_provider() -> ResourceProvider:
    s = get_settings()
    if s.learning_resources_provider == "curated_file" and s.learning_resources_file:
        try:
            return CuratedFileProvider(s.learning_resources_file)
        except (OSError, ValueError):
            return ResourceProvider()
    return ResourceProvider()


def job_listings_status() -> dict:
    return {"status": "unavailable", "provider": None,
            "message": "No job-listings provider is configured. Listings are never generated or simulated."}


def roadmap(content: ResumeContent, role_ids: list[str]) -> dict:
    gaps = skill_gap(content, role_ids)
    prov = resource_provider()
    steps = []
    seen = set()
    for g in gaps:
        ordered = sorted(g["skills"], key=lambda r: (r["importance"] != "required", r["state"] != "listed_only", r["state"] != "gap"))
        for row in ordered:
            if row["state"] == "demonstrated" or row["skill"] in seen:
                continue
            seen.add(row["skill"])
            if row["state"] == "listed_only":
                action = f"You list {row['skill']} but no bullet shows it. If you have used it, describe where and what you did."
                phase = "now"
            elif row["related_evidence"]:
                action = (f"You demonstrate {', '.join(row['related_evidence'])}, which is often used with {row['skill']}. "
                          f"If you have experience with it, add it; otherwise it is a short step to learn.")
                phase = "next"
            else:
                action = f"Learn {row['skill']} and apply it in a small project so you have real evidence."
                phase = "next" if row["importance"] == "required" else "later"
            steps.append({"skill": row["skill"], "importance": row["importance"], "state": row["state"], "for_role": g["title"],
                          "phase": phase, "action": action, "resources": prov.lookup(row["skill"])})
    phase_order = {"now": 0, "next": 1, "later": 2}
    steps.sort(key=lambda s: (phase_order[s["phase"]], s["importance"] != "required"))
    gap_skills = [s["skill"] for s in steps]
    projects = portfolio_projects(gap_skills, role_ids[0] if role_ids else None)
    return {"roles": [{"role_id": g["role_id"], "title": g["title"], "summary": g["summary"]} for g in gaps],
            "steps": steps[:20], "portfolio_projects": projects, "resource_provider": prov.name,
            "catalog_version": project_catalog()["version"]}


def template_interview_questions(content: ResumeContent, gaps: list[str]) -> list[dict]:
    qs = []
    for path, owner, text in content.all_bullets()[:6]:
        qs.append({"question": f"In “{owner}”, you wrote: “{text[:140]}”. What exactly was your role, and what would you do differently?",
                   "why": "Interviewers verify ownership and depth behind resume claims.", "based_on": path})
    for e in content.experience[:2]:
        if e.title:
            qs.append({"question": f"What was the hardest problem you solved as {e.title}?", "why": "Behavioural depth on your most recent roles.",
                       "based_on": f"experience/{e.id}"})
    for s in gaps[:3]:
        qs.append({"question": f"The role mentions {s}, which your resume does not show. How would you approach learning or applying it?",
                   "why": "Prepares you to address a gap honestly.", "based_on": "job_description"})
    return qs
