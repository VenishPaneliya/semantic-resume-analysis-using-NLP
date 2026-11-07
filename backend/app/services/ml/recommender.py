"""Hybrid, transparent role recommender.

fit = 100 × (0.40·required_coverage + 0.20·preferred_coverage + 0.25·semantic + 0.15·title_signal)

- coverage weights: demonstrated in experience/projects = 1.0, listed only = 0.6, absent = 0
- semantic: embedding similarity between resume evidence text and the role profile,
  mapped to [0,1] with fixed anchors (heuristic, not a probability)
- title_signal: 1 if a job title matches the role title/related titles, 0.5 if a project
  name does, else 0

User preferences (target roles, domains) add a separately reported adjustment that affects
ordering but is never folded into the fit score. The fit score is a *relative* indicator
for comparing roles for this resume; it is not a hiring probability.
"""

from __future__ import annotations

import re

from app.schemas.resume import ResumeContent
from app.services.analysis.experience import build_timeline
from app.services.ml.embeddings import get_embedder
from app.services.ml.features import evidence_text, resume_skill_evidence
from app.services.taxonomy import Role, get_taxonomy
from app.versions import RECOMMENDER_VERSION

W_REQ, W_PREF, W_SEM, W_TITLE = 0.40, 0.20, 0.25, 0.15
LISTED_ONLY = 0.6
MIN_SKILLS = 4
MIN_EVIDENCE_UNITS = 2

_SENIOR_TITLE = re.compile(r"\b(senior|sr\.?|lead|principal|staff|head|manager|architect)\b", re.I)


def _title_tokens(t: str) -> set[str]:
    stop = {"the", "and", "of", "/", "-", "(", ")"}
    return {w for w in re.findall(r"[a-z+#.]+", t.lower()) if w not in stop and len(w) > 1}


def _title_signal(c: ResumeContent, role: Role) -> tuple[float, dict | None]:
    names = [role.title, *role.related_titles]
    role_full = {n.lower() for n in names}
    role_tokens = [(_title_tokens(n), n) for n in names]
    for e in c.experience:
        t = (e.title or "").lower()
        if not t:
            continue
        clean = re.sub(r"\b(senior|sr\.?|junior|jr\.?|lead|intern|trainee|associate|principal|staff)\b", "", t).strip(" ,-")
        if clean in role_full or any(tok and tok <= _title_tokens(clean) for tok, _ in role_tokens):
            return 1.0, {"path": f"experience/{e.id}", "text": f"Job title: {e.title}"}
    for p in c.projects:
        pt = _title_tokens(p.name)
        if any(tok and tok <= pt for tok, _ in role_tokens):
            return 0.5, {"path": f"projects/{p.id}", "text": f"Project: {p.name}"}
    return 0.0, None


def estimate_seniority(c: ResumeContent, as_of: str | None = None) -> dict:
    tax = get_taxonomy()
    tl = build_timeline(c, as_of)
    years = tl.effective_years
    precise = all(e.start and len(e.start) == 7 for e in c.experience) if c.experience else False
    margin = 0.5 if precise else 1.0
    if tl.undated_entries:
        margin += 1.0
    lo, hi = max(0.0, years - margin), years + margin
    bands = [b for b in tax.seniority_bands if b["min_years"] <= hi and b["max_years"] >= lo]
    centre = next((b for b in tax.seniority_bands if b["min_years"] <= years <= b["max_years"]), tax.seniority_bands[0])
    senior_titles = [e.title for e in c.experience if e.title and _SENIOR_TITLE.search(e.title)]
    basis = [f"{tl.professional_years} years of non-internship experience (overlaps merged)"]
    if tl.internship_months:
        basis.append(f"{tl.internship_months} months of internships counted at half weight")
    if senior_titles:
        basis.append(f"senior-level title(s): {', '.join(senior_titles[:2])}")
    if tl.undated_entries:
        basis.append(f"{len(tl.undated_entries)} undated role(s) widen the uncertainty")
    return {
        "estimate": centre["id"],
        "label": centre["label"],
        "plausible_range": [b["id"] for b in bands] or [centre["id"]],
        "effective_years": years,
        "years_range": [round(lo, 1), round(hi, 1)],
        "basis": basis,
        "uncertainty": "high" if len(bands) > 2 or tl.undated_entries else "medium" if len(bands) == 2 else "low",
        "note": "Estimated from dated experience only; responsibilities and employer expectations vary widely.",
    }


def recommend(content: dict | ResumeContent, preferences: dict | None = None, top_k: int = 6, as_of: str | None = None) -> dict:
    c = content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)
    prefs = preferences or {}
    tax = get_taxonomy()
    emb = get_embedder()
    ev = resume_skill_evidence(c)
    text = evidence_text(c)
    n_units = len(c.all_bullets()) + len(c.projects) + sum(1 for e in c.experience if e.title)
    seniority = estimate_seniority(c, as_of)

    base = {
        "recommender_version": RECOMMENDER_VERSION,
        "embedding_model": emb.name,
        "taxonomy_version": tax.version,
        "weights": {"required": W_REQ, "preferred": W_PREF, "semantic": W_SEM, "title": W_TITLE},
        "disclaimer": (
            "Fit scores compare roles relative to each other for this resume. They are not hiring probabilities "
            "and do not use your name, contact details, employer or school names, or any protected attribute."
        ),
        "seniority": seniority,
        "preferences_applied": {k: prefs.get(k) for k in ("target_roles", "domains", "locations", "work_arrangements") if prefs.get(k)},
    }

    insufficient = len(ev.all) < MIN_SKILLS or n_units < MIN_EVIDENCE_UNITS or len(text.split()) < 40
    roles = list(tax.roles.values())
    sims = emb.similarity([text or " "], [r.profile_text() for r in roles])[0]

    results = []
    for role, cos in zip(roles, sims, strict=True):
        def cov(skills: list[str]) -> tuple[float, list, list, list]:
            matched, weak, missing = [], [], []
            total = 0.0
            for s in skills:
                if s in ev.demonstrated:
                    total += 1
                    matched.append({"skill": s, "evidence": ev.evidence.get(s, [])[:2]})
                elif s in ev.listed:
                    total += LISTED_ONLY
                    weak.append({"skill": s, "reason": "Listed in skills but not shown in experience or projects."})
                else:
                    missing.append(s)
            return (total / len(skills) if skills else 0.0), matched, weak, missing

        req, req_m, req_w, req_miss = cov(role.required_skills)
        pref, pref_m, pref_w, pref_miss = cov(role.preferred_skills)
        sem = float(emb.normalise(float(cos)))
        title, title_ev = _title_signal(c, role)
        fit = 100 * (W_REQ * req + W_PREF * pref + W_SEM * sem + W_TITLE * title)

        adj = 0.0
        adj_reasons = []
        if role.id in (prefs.get("target_roles") or []):
            adj += 5
            adj_reasons.append("You listed this as a target role (+5 to ordering).")
        if set(role.domains) & set(prefs.get("domains") or []):
            adj += 3
            adj_reasons.append("Matches a preferred domain (+3 to ordering).")

        related_hints = []
        for s in req_miss + pref_miss:
            rel = [d for d in ev.demonstrated if s in tax.skills[d].related or d in tax.skills[s].related]
            if rel:
                related_hints.append({"skill": s, "because_you_have": sorted(rel)[:3]})

        reasons = []
        reasons.append(
            f"Shows {len(req_m)} of {len(role.required_skills)} core skills in experience or projects"
            + (f" (e.g. {req_m[0]['skill']}: “{req_m[0]['evidence'][0]['text'][:90]}”)" if req_m and req_m[0]["evidence"] else "")
            + "."
        )
        if req_w:
            reasons.append(f"{len(req_w)} core skill(s) are listed but not demonstrated: {', '.join(x['skill'] for x in req_w)}.")
        if title_ev:
            reasons.append(f"Relevant title/project: {title_ev['text']}.")
        reasons.append(f"Text similarity to the role profile is {'high' if sem > 0.66 else 'moderate' if sem > 0.33 else 'low'} ({emb.name}).")

        confidence = "high" if (len(req_m) / max(1, len(role.required_skills)) >= 0.6 and n_units >= 6) else "medium" if req >= 0.4 else "low"
        if insufficient:
            confidence = "low"

        next_steps = []
        for s in req_miss[:2]:
            hint = next((h for h in related_hints if h["skill"] == s), None)
            if hint:
                next_steps.append(f"If you have used {s} (common alongside {', '.join(hint['because_you_have'])}), describe where you used it.")
            else:
                next_steps.append(f"Build evidence for {s}: a small project or course work that uses it, then describe it in a bullet.")
        for w in req_w[:2]:
            next_steps.append(f"Show where you used {w['skill']} in an experience or project bullet.")
        if not next_steps:
            next_steps.append("Strengthen bullets for this role with outcomes you can verify.")

        results.append({
            "role_id": role.id,
            "title": role.title,
            "description": role.description,
            "related_titles": role.related_titles,
            "fit_score": round(fit, 1),
            "preference_adjustment": adj,
            "preference_reasons": adj_reasons,
            "confidence": confidence,
            "components": {"required_coverage": round(req, 3), "preferred_coverage": round(pref, 3),
                           "semantic": round(sem, 3), "semantic_raw_cosine": round(float(cos), 4), "title_signal": title},
            "matched_skills": req_m + pref_m,
            "weak_skills": req_w + pref_w,
            "missing_required": req_miss,
            "missing_preferred": pref_miss,
            "possibly_unlisted": related_hints,
            "reasons": reasons,
            "next_steps": next_steps,
        })

    results.sort(key=lambda r: (-(r["fit_score"] + r["preference_adjustment"]), r["role_id"]))
    for i, r in enumerate(results, 1):
        r["rank"] = i

    if insufficient:
        needed = []
        if len(ev.all) < MIN_SKILLS:
            needed.append(f"at least {MIN_SKILLS} recognised skills (found {len(ev.all)})")
        if n_units < MIN_EVIDENCE_UNITS:
            needed.append("experience or project entries with bullet points")
        if len(text.split()) < 40:
            needed.append("more descriptive text about what you did")
        return {**base, "status": "insufficient_evidence",
                "message": "There is not enough evidence in this resume to recommend roles with confidence. Add: " + "; ".join(needed) + ".",
                "recommendations": [], "tentative": [{k: r[k] for k in ("role_id", "title", "fit_score", "confidence")} for r in results[:3]]}
    return {**base, "status": "ok", "recommendations": results[:top_k], "all_scores": [
        {"role_id": r["role_id"], "title": r["title"], "fit_score": r["fit_score"]} for r in results]}


def skill_gap(content: dict | ResumeContent, role_ids: list[str]) -> list[dict]:
    """Skill gap dashboard data for selected roles."""
    c = content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)
    tax = get_taxonomy()
    ev = resume_skill_evidence(c)
    out = []
    for rid in role_ids:
        role = tax.roles.get(rid)
        if not role:
            continue
        rows = []
        for s, importance in [(s, "required") for s in role.required_skills] + [(s, "preferred") for s in role.preferred_skills]:
            state = "demonstrated" if s in ev.demonstrated else "listed_only" if s in ev.listed else "gap"
            rel = sorted(d for d in ev.demonstrated if s in tax.skills[d].related or d in tax.skills[s].related) if state == "gap" else []
            rows.append({"skill": s, "importance": importance, "state": state, "related_evidence": rel[:3],
                         "evidence": ev.evidence.get(s, [])[:2]})
        out.append({"role_id": rid, "title": role.title, "skills": rows,
                    "summary": {k: sum(1 for r in rows if r["state"] == k) for k in ("demonstrated", "listed_only", "gap")}})
    return out
