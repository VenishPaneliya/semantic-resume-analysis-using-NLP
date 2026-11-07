"""Skill & role taxonomy loading plus alias-aware skill extraction with evidence spans."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "taxonomy"


@dataclass(frozen=True)
class Skill:
    name: str
    category: str
    aliases: tuple[str, ...]
    related: tuple[str, ...]
    implies: tuple[str, ...] = ()

    @property
    def is_soft(self) -> bool:
        return self.category == "soft"


@dataclass
class Role:
    id: str
    title: str
    description: str
    required_skills: list[str]
    preferred_skills: list[str]
    responsibilities: list[str]
    related_titles: list[str]
    domains: list[str]

    def profile_text(self) -> str:
        return (
            f"{self.title}. {self.description} Responsibilities: {'; '.join(self.responsibilities)}. "
            f"Skills: {', '.join(self.required_skills + self.preferred_skills)}."
        )


@dataclass
class SkillHit:
    skill: str
    matched: str
    start: int
    end: int


@dataclass
class Taxonomy:
    skills_version: str
    roles_version: str
    skills: dict[str, Skill]
    roles: dict[str, Role]
    seniority_bands: list[dict]
    _patterns: list[tuple[re.Pattern, str]] = field(default_factory=list, repr=False)

    @property
    def version(self) -> str:
        return f"{self.skills_version}+{self.roles_version}"

    def canonical(self, name: str) -> str | None:
        key = name.strip().lower()
        for s in self.skills.values():
            if key == s.name.lower() or key in (a.lower() for a in s.aliases):
                return s.name
        return None

    def find_skills(self, text: str) -> list[SkillHit]:
        """All skill mentions with character spans. Longest alias wins on overlap."""
        hits: list[SkillHit] = []
        taken: list[tuple[int, int]] = []
        for pat, canonical in self._patterns:
            for m in pat.finditer(text):
                s, e = m.start(1), m.end(1)
                if any(not (e <= a or s >= b) for a, b in taken):
                    continue
                taken.append((s, e))
                hits.append(SkillHit(canonical, m.group(1), s, e))
        hits.sort(key=lambda h: h.start)
        return hits


def _build_patterns(skills: dict[str, Skill]) -> list[tuple[re.Pattern, str]]:
    terms: list[tuple[str, str]] = []
    for s in skills.values():
        for t in (s.name, *s.aliases):
            terms.append((t, s.name))
    # longest first so "react native" beats "react", "c++" beats "c"
    terms.sort(key=lambda x: -len(x[0]))
    pats = []
    for term, canonical in terms:
        esc = re.escape(term)
        # token boundary that tolerates symbols like + # . in skill names
        pattern = rf"(?<![A-Za-z0-9+#])({esc})(?![A-Za-z0-9+#]|\.[A-Za-z0-9])"
        # very short terms (Go, R, C, ML) are matched case-sensitively to avoid prose hits
        flags = 0 if len(term) <= 2 else re.IGNORECASE
        if term in ("C", "R"):
            # require list-like context: preceded/followed by comma, slash, pipe, colon or line edge
            pattern = rf"(?:(?<=[,:/|(•])\s*|^\s*)({esc})(?=\s*(?:[,/|)]|$))"
            flags = re.MULTILINE
        pats.append((re.compile(pattern, flags), canonical))
    return pats


@lru_cache
def get_taxonomy() -> Taxonomy:
    sk = json.loads((DATA_DIR / "skills_v1.json").read_text(encoding="utf-8"))
    rl = json.loads((DATA_DIR / "roles_v1.json").read_text(encoding="utf-8"))
    skills = {
        s["name"]: Skill(s["name"], s["category"], tuple(s.get("aliases", [])), tuple(s.get("related", [])), tuple(s.get("implies", [])))
        for s in sk["skills"]
    }
    roles = {r["id"]: Role(**r) for r in rl["roles"]}
    for r in roles.values():
        for name in r.required_skills + r.preferred_skills:
            if name not in skills:
                raise ValueError(f"Role {r.id} references unknown skill {name!r}")
    t = Taxonomy(sk["version"], rl["version"], skills, roles, rl["seniority_bands"])
    t._patterns = _build_patterns(skills)
    return t
