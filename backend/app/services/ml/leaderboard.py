"""Leaderboards and relevance-gated tailoring tips.

A. Role leaderboard      — every taxonomy role ranked for one resume (hybrid recommender).
B. Opening leaderboard   — open vacancies posted by HR staff, ranked for one resume (JD matcher).
C. Standing              — a candidate's position among applicants to one opening. Only the
                           candidate's own rank, the applicant count and an anonymous score
                           distribution are revealed; never other people's identities or scores.
D. Tailoring tips        — concrete resume changes for one role/opening, **only when the
                           resume is already related to it** (fit >= TIPS_MIN). Below that, the
                           honest answer is a learning path, not resume edits.

Tiers come from fixed score bands (see TIERS). They were chosen by looking at how the
synthetic personas score: a persona's true role scores 60–96, adjacent roles 35–57, and
unrelated roles below 25. They are heuristic bands, not probabilities.
"""

from __future__ import annotations

import re

import numpy as np

from app.schemas.resume import ResumeContent
from app.services.ml.embeddings import get_embedder
from app.services.ml.features import resume_skill_evidence
from app.services.ml.recommender import recommend
from app.services.taxonomy import get_taxonomy
from app.services.text import clip
from app.versions import LEADERBOARD_VERSION

TIERS = [
    (60.0, "strong", "Strong match"),
    (40.0, "good", "Good match"),
    (25.0, "stretch", "Stretch"),
    (0.0, "unrelated", "Not a match yet"),
]
TIPS_MIN = 40.0
# second floor: at least a third of the target's core (required) skills must already be shown,
# so a high overall score driven by generic signals (years, degree, wording) can't unlock tips
CORE_MIN = 1 / 3
MIN_STANDING_POOL = 3  # don't reveal a rank among fewer than 3 applicants
TIER_HELP = {
    "strong": "Your resume already shows most of what this needs.",
    "good": "A solid base. Targeted resume changes can make your fit clearer.",
    "stretch": "Related, but key skills are missing. Build them first; resume edits alone won't close this gap.",
    "unrelated": "Your current experience points elsewhere. This would be a career change, not a resume tweak.",
}


def tier_for(score: float | None) -> dict:
    if score is None:
        return {"id": "unknown", "label": "Not enough information", "help": "This could not be scored from the resume.",
                "tips_available": False}
    for lo, tid, label in TIERS:
        if score >= lo:
            return {"id": tid, "label": label, "help": TIER_HELP[tid], "tips_available": score >= TIPS_MIN}
    raise AssertionError("unreachable")


def eligibility(score: float | None, core_coverage: float | None) -> tuple[bool, str | None]:
    if score is None:
        return False, "This target could not be scored from your resume."
    if score < TIPS_MIN:
        return False, f"score {score:.0f}, tips start at {TIPS_MIN:.0f}"
    if core_coverage is not None and core_coverage < CORE_MIN - 1e-9:
        return False, f"only {round(core_coverage * 100)}% of its core skills are shown (tips need about a third)"
    return True, None


def core_coverage_from_match(m: dict) -> float | None:
    rs = [r for r in m.get("requirements", []) if r["kind"] == "skill" and r["importance"] == "required"]
    if not rs:
        return None
    return sum({"matched": 1.0, "partial": 0.5}.get(r["status"], 0.0) for r in rs) / len(rs)


def fit_for_role(content: dict | ResumeContent, role_id: str) -> tuple[float | None, float | None]:
    lb = role_leaderboard(content)
    row = next((r for r in lb["rows"] if r["role_id"] == role_id), None)
    return (row["score"], row["core_coverage"]) if row else (None, None)


def fit_for_opening(content: dict | ResumeContent, extracted: dict) -> tuple[float | None, float | None, dict]:
    from app.services.ml.jd import match

    m = match(content, extracted)
    return m["overall"], core_coverage_from_match(m), m


def _content(content: dict | ResumeContent) -> ResumeContent:
    return content if isinstance(content, ResumeContent) else ResumeContent.model_validate(content)


# ---------------------------------------------------------------- A. roles


def role_leaderboard(content: dict | ResumeContent, preferences: dict | None = None, as_of: str | None = None) -> dict:
    tax = get_taxonomy()
    rec = recommend(content, preferences, top_k=len(tax.roles), as_of=as_of)
    base = {"leaderboard_version": LEADERBOARD_VERSION, "embedding_model": rec["embedding_model"],
            "taxonomy_version": rec["taxonomy_version"], "weights": rec["weights"], "tips_min_score": TIPS_MIN,
            "tips_min_core_coverage": round(CORE_MIN, 3), "tiers": [{"min": lo, "id": i, "label": lb} for lo, i, lb in TIERS],
            "seniority": rec["seniority"],
            "disclaimer": rec["disclaimer"]}
    if rec["status"] != "ok":
        return {**base, "status": rec["status"], "message": rec["message"], "rows": []}
    rows = []
    for r in rec["recommendations"]:
        cov = r["components"]["required_coverage"]
        ok, why = eligibility(r["fit_score"], cov)
        rows.append({
            "rank": r["rank"], "role_id": r["role_id"], "title": r["title"], "description": r["description"],
            "score": r["fit_score"], "tier": tier_for(r["fit_score"]), "confidence": r["confidence"],
            "core_coverage": cov, "tips_available": ok, "tips_blocked_reason": why,
            "components": r["components"],
            "keywords_matched": [m["skill"] for m in r["matched_skills"]],
            "keywords_weak": [w["skill"] for w in r["weak_skills"]],
            "keywords_missing": r["missing_required"] + r["missing_preferred"],
            "missing_required": r["missing_required"],
            "possibly_unlisted": [{"skill": h["skill"], "because_you_have": h["because_you_have"]} for h in r["possibly_unlisted"]],
            "reasons": r["reasons"],
            "next_steps": r["next_steps"],
            # rows are ordered by score + this adjustment (target roles / domains chosen by the user)
            "preference_adjustment": r["preference_adjustment"],
            "preference_reasons": r["preference_reasons"],
        })
    return {**base, "status": "ok", "rows": rows}


# ---------------------------------------------------------------- B. openings


def infer_role(extracted: dict) -> str | None:
    """Closest taxonomy role for an opening, by skill overlap then title words."""
    tax = get_taxonomy()
    skills = set(extracted.get("skills", []))
    title = (extracted.get("title") or "").lower()
    best, best_score = None, 0.0
    for r in tax.roles.values():
        rs = set(r.required_skills) | set(r.preferred_skills)
        overlap = len(skills & rs) / max(1, len(rs))
        title_hit = any(t.lower() in title for t in [r.title, *r.related_titles])
        s = overlap + (0.5 if title_hit else 0.0)
        if s > best_score:
            best, best_score = r.id, s
    return best if best_score >= 0.15 else None


def opening_row(match_result: dict) -> dict:
    score = match_result.get("overall")
    cov = core_coverage_from_match(match_result)
    ok, why = eligibility(score, cov)
    return {
        "score": score, "tier": tier_for(score), "core_coverage": None if cov is None else round(cov, 3),
        "tips_available": ok, "tips_blocked_reason": why,
        "keywords_matched": match_result["keywords"]["present"],
        "keywords_missing": match_result["keywords"]["absent"],
        "counts": match_result["counts"],
        "genuine_gaps": match_result["genuine_gaps"][:5],
        "possibly_unlisted": match_result["possibly_unlisted"][:5],
    }


# ---------------------------------------------------------------- C. standing


def standing(my_score: float, all_scores: list[float]) -> dict:
    """Position of `my_score` among applicants. Ties share the better rank."""
    n = len(all_scores)
    if n < MIN_STANDING_POOL:
        return {"available": False, "applicants": n, "min_pool": MIN_STANDING_POOL,
                "message": f"Your position appears once at least {MIN_STANDING_POOL} people have applied."}
    rank = 1 + sum(1 for s in all_scores if s > my_score)
    top_pct = max(1, round(100 * rank / n))
    buckets = [0] * 10
    for s in all_scores:
        buckets[min(9, int(max(0.0, s) // 10))] += 1
    return {
        "available": True, "rank": rank, "applicants": n, "top_percent": top_pct,
        "my_score": my_score, "median": float(np.median(all_scores)),
        # anonymous histogram of scores in 10-point bands; no individual scores are exposed
        "distribution": [{"from": i * 10, "to": i * 10 + 9, "count": c} for i, c in enumerate(buckets)],
        "note": "Ranked by the same compatibility indicator you see. Recruiters make the final decision, "
                "and they also consider things a resume can't show.",
    }


# ---------------------------------------------------------------- D. tailoring tips


def _target_spec(role_id: str | None = None, opening: dict | None = None) -> dict:
    tax = get_taxonomy()
    if role_id:
        r = tax.roles[role_id]
        return {"kind": "role", "id": r.id, "title": r.title, "required": list(r.required_skills),
                "preferred": list(r.preferred_skills), "text": r.profile_text(), "title_words": [r.title, *r.related_titles]}
    assert opening is not None
    ex = opening["extracted"]
    req, pref = [], []
    for q in ex.get("requirements", []):
        if q.get("kind") == "skill":
            (pref if q.get("importance") == "preferred" else req).extend(q.get("skills", []))
    req = list(dict.fromkeys(req)) or list(ex.get("skills", []))
    pref = [s for s in dict.fromkeys(pref) if s not in req]
    text = " ".join([opening["title"], *ex.get("responsibilities", []), *(q["text"] for q in ex.get("requirements", []))])
    return {"kind": "opening", "id": opening["id"], "title": opening["title"], "required": req, "preferred": pref,
            "text": text, "title_words": [opening["title"]]}


def tailoring_tips(content: dict | ResumeContent, score: float | None, *, core_coverage: float | None = None,
                   role_id: str | None = None, opening: dict | None = None) -> dict:
    c = _content(content)
    tax = get_taxonomy()
    t = _target_spec(role_id, opening)
    tier = tier_for(score)
    ok, why = eligibility(score, core_coverage)
    ev = resume_skill_evidence(c)
    target_skills = t["required"] + t["preferred"]
    missing_req = [s for s in t["required"] if s not in ev.all]
    learning_path = [
        {"skill": s, "importance": "required" if s in t["required"] else "preferred",
         "why": f"{t['title']} asks for {s}, and your resume doesn't show it yet."}
        for s in target_skills if s not in ev.all
    ][:8]
    out = {
        "leaderboard_version": LEADERBOARD_VERSION,
        "target": {"kind": t["kind"], "id": t["id"], "title": t["title"]},
        "score": score, "tier": tier, "eligible": ok, "tips_min_score": TIPS_MIN,
        "core_coverage": None if core_coverage is None else round(core_coverage, 3),
        "learning_path": learning_path,
        "honesty_note": "Only add skills and results you really have. These tips help you show your existing "
                        "experience clearly; they never ask you to add keywords you can't back up.",
    }
    if not ok:
        out["gate_message"] = (
            f"{t['title']} isn't closely related to your current resume ({why}). Rewording can't honestly close "
            "this gap, so we're not suggesting resume changes for it. If you want to move toward it, start with the "
            "skills below, then come back."
        )
        out["tips"] = []
        return out

    tips: list[dict] = []

    def add(kind: str, priority: str, title: str, detail: str, **extra) -> None:
        tips.append({"id": f"{kind}-{len(tips)}", "kind": kind, "priority": priority, "title": title, "detail": detail, **extra})

    # 1. skills listed but never shown in experience/projects
    for s in [s for s in target_skills if s in ev.listed and s not in ev.demonstrated][:3]:
        imp = "required" if s in t["required"] else "preferred"
        add("show_listed_skill", "high" if imp == "required" else "medium", f"Show where you used {s}",
            f"{s} is in your skills list but none of your experience or project bullets mention it. "
            f"Add it to the bullet where you actually used it, so it counts as demonstrated.", skill=s)

    # 2. missing skills with related evidence — maybe the person has it but didn't write it
    for s in missing_req[:6]:
        rel = sorted(d for d in ev.demonstrated if s in tax.skills[d].related or d in tax.skills[s].related)
        if rel:
            add("possibly_unlisted", "medium", f"Do you have {s} experience?",
                f"This needs {s}. You show related skills ({', '.join(rel[:3])}), so you may have used {s} without writing it down. "
                f"If you have, add it where you used it. If you haven't, leave it out.", skill=s, related=rel[:3])

    # 3. use the job's exact wording for skills the resume already has
    wording: dict[str, str] = {}
    for _path, _owner, text in c.all_bullets():
        for h in tax.find_skills(text):
            if h.skill in target_skills and h.matched.lower() != h.skill.lower():
                wording.setdefault(h.skill, h.matched)
    for s, used in list(wording.items())[:3]:
        add("use_target_wording", "low", f"Write “{s}” as well as “{used}”",
            f"You wrote “{used}”. The target uses “{s}”. Some screening tools match exact words, so using the "
            "standard name once helps you get found.", skill=s, current=used)

    # 4/5. most relevant bullets: lead with them, and quantify them
    bullets = c.all_bullets()
    if bullets:
        emb = get_embedder()
        sims = emb.similarity([t["text"]], [b[2] for b in bullets])[0]
        order = list(np.argsort(sims)[::-1])
        top = [bullets[i] for i in order[:3]]
        first_by_entry: dict[str, str] = {}
        for path, _o, _t in bullets:
            first_by_entry.setdefault(path.rsplit("/bullets/", 1)[0], path)
        for path, owner, text in top:
            entry = path.rsplit("/bullets/", 1)[0]
            if first_by_entry.get(entry) != path:
                add("lead_with_relevant", "medium", f"Move this bullet to the top of “{owner}”",
                    f"This is one of your most relevant points for {t['title']}, but it's not the first thing a reader sees "
                    f"in that entry: “{clip(text, 140)}”", path=path)
                break
        for path, _owner, text in top:
            if not re.search(r"\d", text):
                add("quantify", "high", "Add a real result to a key bullet",
                    f"One of your most relevant bullets has no measurable outcome: “{clip(text, 140)}”. If you know the "
                    "result (time saved, users, accuracy, revenue), add it. The AI editor can insert a placeholder for you to fill in.",
                    path=path, action={"type": "ai", "operation": "rewrite_bullet", "target_path": path})
                break
        best_path = bullets[order[0]][0]
        add("tailor_wording", "low", f"Tailor your strongest bullet for {t['title']}",
            "Use the AI editor to reword your most relevant bullet in the target's language. It can only emphasise "
            "skills you already show, and nothing changes until you accept it.",
            path=best_path, action={"type": "ai", "operation": "tailor", "target_path": best_path,
                                    **({"target_role": t["id"]} if t["kind"] == "role" else {"opening_id": t["id"]})})

    # 6. summary that points at the target
    summary = (c.summary or "").lower()
    title_hit = any(w.lower() in summary for w in t["title_words"])
    shown = [s for s in target_skills if s in ev.demonstrated]
    if not c.summary:
        add("summary", "high", "Add a short summary",
            f"A two-line summary at the top lets a recruiter see straight away that you fit {t['title']}.",
            action={"type": "ai", "operation": "improve_summary", "target_path": "summary"})
    elif not title_hit and not any(s.lower() in summary for s in shown):
        add("summary", "medium", f"Point your summary at {t['title']}",
            f"Your summary doesn't mention this kind of role or the matching skills you already show "
            f"({', '.join(shown[:3]) or 'see your matched skills'}).",
            action={"type": "ai", "operation": "improve_summary", "target_path": "summary"})

    order_p = {"high": 0, "medium": 1, "low": 2}
    tips.sort(key=lambda x: order_p[x["priority"]])
    out["tips"] = tips
    if not tips:
        out["message"] = "Your resume already presents this well. Keep your bullets specific and current."
    return out
