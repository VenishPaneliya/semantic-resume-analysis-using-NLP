"""Evaluation on synthetic dataset v2 (eval/synthetic_v2.py).

    python -m eval.run_eval_v2 [--seed 20261110] [--per-profile 6] [--embedding tfidf|sentence-transformers]

End to end: every resume is rendered to PDF/DOCX, parsed and extracted, and the downstream
metrics (skills, roles, seniority, job matching) use the EXTRACTED content, as the product does.
The same metrics on the generator's ground-truth content are reported alongside, so parsing
errors and matching errors can be told apart. Nothing in app/ was tuned on this set.

Writes eval/reports/<date>_synthetic_v2_<embedding>.{json,md}.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0, "tp": tp, "fp": fp, "fn": fn}


def bootstrap(values, stat=lambda v: sum(v) / len(v), n=1000, seed=7):
    """95% percentile CI over items (persona-level resampling)."""
    if not values:
        return None
    rng = random.Random(seed)
    sims = sorted(stat([values[rng.randrange(len(values))] for _ in values]) for _ in range(n))
    return [round(sims[int(0.025 * n)], 3), round(sims[int(0.975 * n) - 1], 3)]


def auc(pos, neg):
    if not pos or not neg:
        return None
    wins = sum(1.0 if p > q else 0.5 if p == q else 0.0 for p in pos for q in neg)
    return round(wins / (len(pos) * len(neg)), 3)


def spearman(x, y):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2
            i = j + 1
        return r
    rx, ry = ranks(x), ranks(y)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry, strict=True))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return round(num / den, 3) if den else None


def ndcg(ranked, rel, k):
    dcg = sum((2 ** rel.get(r, 0) - 1) / math.log2(i + 2) for i, r in enumerate(ranked[:k]))
    ideal = sorted(rel.values(), reverse=True)[:k]
    idcg = sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg else None


def closure(skills, tax):
    out, frontier = set(skills), list(skills)
    while frontier:
        s = frontier.pop()
        for imp in tax.skills[s].implies:
            if imp not in out:
                out.add(imp)
                frontier.append(imp)
    return out


# ------------------------------------------------------------------ 1. parsing + extraction
def eval_extraction(personas, layouts):
    from app.services.extraction.extractor import extract
    from app.services.parsing.parsers import parse_document
    from eval.synthetic_v2 import LAYOUTS, render

    fields = defaultdict(lambda: defaultdict(list))   # layout -> field -> [0/1]
    extracted = {}                                      # (persona, layout) -> content
    failures = []
    for p in personas:
        gt = p["content"]
        for lay in layouts:
            kind, data = render(p, lay)
            try:
                parsed = parse_document(kind, data)
                ex = extract(parsed["text"], parsed["pages"])["content"]
            except Exception as e:  # noqa: BLE001
                failures.append({"persona": p["id"], "layout": lay, "error": f"{type(e).__name__}: {str(e)[:120]}"})
                continue
            extracted[(p["id"], lay)] = ex
            year_only = LAYOUTS[lay]["date"] == "YYYY"
            f = fields[lay]
            f["contact.name"].append(int(_norm(ex["contact"]["name"]) == _norm(gt["contact"]["name"])))
            f["contact.email"].append(int((ex["contact"]["email"] or "").lower() == gt["contact"]["email"].lower()))
            f["contact.phone"].append(int(re.sub(r"\D", "", ex["contact"]["phone"] or "") == re.sub(r"\D", "", gt["contact"]["phone"])))
            f["experience.count"].append(int(len(ex["experience"]) == len(gt["experience"])))
            for i, ge in enumerate(gt["experience"]):
                ee = ex["experience"][i] if i < len(ex["experience"]) else {}
                f["experience.title"].append(int(_norm(ee.get("title")) == _norm(ge["title"])))
                f["experience.organization"].append(int(_norm(ee.get("organization")) == _norm(ge["organization"])))
                s_ok = (ee.get("start") or "")[:4] == ge["start"][:4] if year_only else ee.get("start") == ge["start"]
                f["experience.start"].append(int(s_ok))
                if ge.get("current"):
                    f["experience.end/current"].append(int(bool(ee.get("current"))))
                else:
                    e_ok = (ee.get("end") or "")[:4] == ge["end"][:4] if year_only else ee.get("end") == ge["end"]
                    f["experience.end/current"].append(int(e_ok))
                got_b = {_norm(b["text"]) for b in ee.get("bullets", [])}
                for b in ge["bullets"]:
                    f["experience.bullet_recall"].append(int(_norm(b) in got_b))
            f["education.count"].append(int(len(ex["education"]) == len(gt["education"])))
            ed = ex["education"][0] if ex["education"] else {}
            f["education.degree"].append(int(bool(ed.get("degree")) and _norm(gt["education"][0]["degree"]) in _norm(ed.get("degree"))))
            f["education.institution"].append(int(_norm(ed.get("institution")) == _norm(gt["education"][0]["institution"])))
    by_layout = {lay: {k: round(sum(v) / len(v), 3) for k, v in sorted(fl.items())} for lay, fl in fields.items()}
    overall = defaultdict(list)
    for fl in fields.values():
        for k, v in fl.items():
            overall[k] += v
    return {"fields": {k: {"accuracy": round(sum(v) / len(v), 3), "n": len(v)} for k, v in sorted(overall.items())},
            "by_layout": by_layout, "failures": failures}, extracted


# ------------------------------------------------------------------ 2. skills
def eval_skills(personas, contents, tax):
    from app.schemas.resume import ResumeContent
    from app.services.ml.features import resume_skill_evidence

    tp = fp = fn = 0
    dtp = dfp = dfn = 0
    fp_c, fn_c = Counter(), Counter()
    per = []
    by_profile = defaultdict(lambda: [0, 0, 0])
    for p in personas:
        c = contents.get(p["id"])
        if c is None:
            continue
        ev = resume_skill_evidence(ResumeContent.model_validate(c))
        # implications (Tableau => Data Visualization) apply to skills shown in work, not to listed-only ones
        gt_demo = closure(p["labels"]["skills_demonstrated"], tax)
        gt_all = gt_demo | set(p["labels"]["skills_all"])
        got = set(ev.all)
        a, b, d = len(gt_all & got), len(got - gt_all), len(gt_all - got)
        tp, fp, fn = tp + a, fp + b, fn + d
        bp = by_profile[p["profile"]]
        bp[0] += a
        bp[1] += b
        bp[2] += d
        fp_c.update(got - gt_all)
        fn_c.update(gt_all - got)
        gd = set(ev.demonstrated)
        dtp, dfp, dfn = dtp + len(gt_demo & gd), dfp + len(gd - gt_demo), dfn + len(gt_demo - gd)
        f1 = 2 * a / (2 * a + b + d) if a + b + d else 1.0
        per.append(f1)
    return {"all_skills": prf(tp, fp, fn), "demonstrated_vs_listed": prf(dtp, dfp, dfn),
            "per_resume_f1_mean": round(sum(per) / len(per), 3) if per else None, "per_resume_f1_ci95": bootstrap(per),
            "by_profile": {k: prf(*v) for k, v in sorted(by_profile.items())},
            "top_false_positives": fp_c.most_common(10), "top_misses": fn_c.most_common(10)}


# ------------------------------------------------------------------ 3. roles + seniority
def eval_roles(personas, contents, as_of):
    from app.services.ml.recommender import recommend

    rows = []
    for p in personas:
        c = contents.get(p["id"])
        if c is None:
            continue
        r = recommend(c, as_of=as_of)
        ranked = [x["role_id"] for x in r.get("all_scores", [])] or [x["role_id"] for x in r.get("tentative", [])]
        scores = r.get("all_scores") or r.get("tentative") or []
        top = scores[0]["fit_score"] if scores else 0.0
        rel = p["labels"]["relevance"]
        sen = r["seniority"]
        row = {"persona": p["id"], "profile": p["profile"], "in_catalog": p["labels"]["in_catalog"], "status": r["status"],
               "top3": ranked[:3], "top_fit": top, "seniority_label": p["labels"]["seniority"],
               "seniority_estimate": sen["estimate"], "seniority_in_range": p["labels"]["seniority"] in sen["plausible_range"]}
        if p["labels"]["in_catalog"]:
            primary = max(rel, key=rel.get)
            row.update({"hit@1_primary": int(bool(ranked) and ranked[0] == primary),
                        "hit@1_relevant": int(bool(ranked) and rel.get(ranked[0], 0) >= 2),
                        "hit@3_primary": int(primary in ranked[:3]),
                        "ndcg@5": round(ndcg(ranked, rel, 5) or 0.0, 3)})
        rows.append(row)
    inn = [r for r in rows if r["in_catalog"]]
    out = [r for r in rows if not r["in_catalog"]]

    def mean(k, rs=inn):
        v = [r[k] for r in rs]
        return {"value": round(sum(v) / len(v), 3), "ci95": bootstrap(v), "n": len(v)} if v else None
    by_profile = defaultdict(list)
    for r in inn:
        by_profile[r["profile"]].append(r)
    sen_conf = Counter((r["seniority_label"], r["seniority_estimate"]) for r in rows)
    thresholds = {}
    for t in (30, 40, 50, 60):
        thresholds[t] = {"in_catalog_above": round(sum(r["top_fit"] >= t for r in inn) / len(inn), 3),
                         "out_of_catalog_above": round(sum(r["top_fit"] >= t for r in out) / len(out), 3) if out else None}
    return {
        "in_catalog": {"hit@1_primary": mean("hit@1_primary"), "hit@1_relevant(grade>=2)": mean("hit@1_relevant"),
                       "hit@3_primary": mean("hit@3_primary"), "ndcg@5": mean("ndcg@5"),
                       "insufficient_evidence_rate": round(sum(r["status"] != "ok" for r in inn) / len(inn), 3)},
        "by_profile": {k: {"hit@1": round(sum(x["hit@1_primary"] for x in v) / len(v), 3), "hit@3": round(sum(x["hit@3_primary"] for x in v) / len(v), 3),
                           "ndcg@5": round(sum(x["ndcg@5"] for x in v) / len(v), 3), "n": len(v)} for k, v in sorted(by_profile.items())},
        "out_of_catalog": {"n": len(out), "insufficient_evidence_rate": round(sum(r["status"] != "ok" for r in out) / len(out), 3) if out else None,
                           "mean_top_fit": round(sum(r["top_fit"] for r in out) / len(out), 1) if out else None,
                           "mean_top_fit_in_catalog": round(sum(r["top_fit"] for r in inn) / len(inn), 1),
                           "auc_top_fit_separates_in_vs_out": auc([r["top_fit"] for r in inn], [r["top_fit"] for r in out]),
                           "share_above_threshold": thresholds,
                           "examples": [{k: r[k] for k in ("persona", "profile", "status", "top3", "top_fit")} for r in out[:6]]},
        "seniority": {"exact": round(sum(r["seniority_label"] == r["seniority_estimate"] for r in rows) / len(rows), 3),
                      "within_plausible_range": round(sum(r["seniority_in_range"] for r in rows) / len(rows), 3),
                      "confusion(label->estimate)": {f"{a}->{b}": n for (a, b), n in sorted(sen_conf.items())}, "n": len(rows)},
        "misses": [{k: r[k] for k in ("persona", "profile", "top3")} for r in inn if not r["hit@3_primary"]][:15],
    }


# ------------------------------------------------------------------ 4. job descriptions
def eval_jd_extraction(jds, tax):
    from app.services.ml.jd import extract_jd

    rtp = rfp = rfn = ptp = pfp = pfn = 0
    years_ok = title_ok = 0
    by_style = defaultdict(lambda: [0, 0, 0, 0])  # tp fp fn years_ok
    parsed = {}
    issues = []
    for jd in jds:
        x = extract_jd(jd["text"])
        parsed[jd["id"]] = x
        req = {s for r in x["requirements"] if r["importance"] == "required" for s in r.get("skills", [])}
        pref = {s for r in x["requirements"] if r["importance"] == "preferred" for s in r.get("skills", [])}
        gr, gp = set(jd["labels"]["required_skills"]), set(jd["labels"]["preferred_skills"])
        rtp, rfp, rfn = rtp + len(gr & req), rfp + len(req - gr), rfn + len(gr - req)
        ptp, pfp, pfn = ptp + len(gp & pref), pfp + len(pref - gp), pfn + len(gp - pref)
        y = x.get("years_required")
        yo = int(y == jd["labels"]["years_min"])
        years_ok += yo
        title_ok += int(_norm(x.get("title")) == _norm(jd["labels"]["title"]))
        s = by_style[jd["style"]]
        s[0] += len(gr & req) + len(gp & pref)
        s[1] += len(req - gr) + len(pref - gp)
        s[2] += len(gr - req) + len(gp - pref)
        s[3] += yo
        if gr - req or gp - pref or req - gr or pref - gp or not yo:
            issues.append({"jd": jd["id"], "style": jd["style"], "missed_required": sorted(gr - req), "missed_preferred": sorted(gp - pref),
                           "extra_required": sorted(req - gr), "extra_preferred": sorted(pref - gp), "years": [jd["labels"]["years_min"], y]})
    n = len(jds)
    style_counts = Counter(j["style"] for j in jds)
    return {"required_skills": prf(rtp, rfp, rfn), "preferred_skills": prf(ptp, pfp, pfn),
            "years_accuracy": round(years_ok / n, 3), "title_accuracy": round(title_ok / n, 3), "n": n,
            "by_style": {k: {**prf(v[0], v[1], v[2]), "years_accuracy": round(v[3] / style_counts[k], 3)} for k, v in by_style.items()},
            "issues": issues[:15]}, parsed


def eval_matching(personas, contents, jds, parsed, tax, as_of):
    from app.services.ml.jd import match, prepare_resume

    conf = defaultdict(Counter)
    pairs = []
    t0 = time.time()
    for p in personas:
        c = contents.get(p["id"])
        if c is None:
            continue
        prep = prepare_resume(c, as_of)
        demo = closure(p["labels"]["skills_demonstrated"], tax)
        allk = demo | set(p["labels"]["skills_all"])
        for jd in jds:
            m = match(c, parsed[jd["id"]], as_of=as_of, prepared=prep)
            grade = p["labels"]["relevance"].get(jd["role"], 0)
            pairs.append({"persona": p["id"], "jd": jd["id"], "grade": grade, "overall": m["overall"] or 0})
            for r in m["requirements"]:
                if r["kind"] == "skill" and len(r["skills"]) == 1:
                    s = r["skills"][0]
                    exp = "matched" if s in demo else "partial" if s in allk else "missing"
                elif r["kind"] == "experience" and not r.get("skills"):
                    need = r.get("years_min") or 0
                    exp = "matched" if p["years"] >= need else "partial" if p["years"] >= need - 1 else "missing"
                else:
                    continue
                conf[f"{r['kind']}:{exp}"][r["status"]] += 1
    seconds = round(time.time() - t0, 1)
    req_acc = {}
    tot = ok = 0
    for k, v in conf.items():
        exp = k.split(":")[1]
        n = sum(v.values())
        req_acc[k] = {"accuracy": round(v[exp] / n, 3), "n": n, "got": dict(v)}
        tot += n
        ok += v[exp]
    # pair level: is the overall score higher for better-fitting pairs?
    good = [x["overall"] for x in pairs if x["grade"] == 3]
    related = [x["overall"] for x in pairs if x["grade"] in (1, 2)]
    none_ = [x["overall"] for x in pairs if x["grade"] == 0]
    # recruiter view: rank every resume for each JD
    by_jd = defaultdict(list)
    for x in pairs:
        by_jd[x["jd"]].append(x)
    nd, p5, p10 = [], [], []
    for _jid, xs in by_jd.items():
        xs.sort(key=lambda x: -x["overall"])
        rel = {x["persona"]: x["grade"] for x in xs}
        nd.append(ndcg([x["persona"] for x in xs], rel, 10) or 0.0)
        p5.append(sum(x["grade"] == 3 for x in xs[:5]) / 5)
        p10.append(sum(x["grade"] == 3 for x in xs[:10]) / 10)
    # score bands used in the product (services/ml/leaderboard.py TIERS): what each band contains
    from app.services.ml.leaderboard import TIERS
    bands = {}
    for lo, tid, _label in TIERS:
        hi = min([x for x, *_ in TIERS if x > lo], default=101)
        xs = [x for x in pairs if lo <= x["overall"] < hi]
        bands[tid] = {"range": [lo, hi - 1], "pairs": len(xs),
                      **{f"share_grade_{g}": round(sum(x["grade"] == g for x in xs) / len(xs), 3) if xs else None for g in (3, 2, 1, 0)}}
    return {"tier_calibration": bands, "requirement_status": {"accuracy": round(ok / tot, 3) if tot else None, "n": tot, "by_kind_and_expected": req_acc},
            "pair_score": {"mean_overall_by_grade": {"3 (same role)": round(sum(good) / len(good), 1), "1-2 (related)": round(sum(related) / len(related), 1),
                                                     "0 (unrelated or non-tech)": round(sum(none_) / len(none_), 1)},
                           "auc_same_role_vs_unrelated": auc(good, none_), "auc_same_role_vs_related": auc(good, related),
                           "spearman_overall_vs_grade": spearman([x["overall"] for x in pairs], [x["grade"] for x in pairs]), "pairs": len(pairs)},
            "ranking_per_jd": {"ndcg@10": {"value": round(sum(nd) / len(nd), 3), "ci95": bootstrap(nd)},
                               "precision@5_same_role": round(sum(p5) / len(p5), 3), "precision@10_same_role": round(sum(p10) / len(p10), 3),
                               "jds": len(by_jd)}, "seconds": seconds}, pairs


def tfidf_baseline(personas, contents, jds, pairs):
    """Plain TF-IDF cosine between the resume's text and the JD text, for comparison."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    from app.schemas.resume import ResumeContent
    from app.services.ml.features import evidence_text

    ids = [p["id"] for p in personas if p["id"] in contents]
    rtext = [evidence_text(ResumeContent.model_validate(contents[i])) for i in ids]
    jtext = [j["text"] for j in jds]
    v = TfidfVectorizer(sublinear_tf=True, ngram_range=(1, 2), min_df=1).fit(rtext + jtext)
    sim = cosine_similarity(v.transform(rtext), v.transform(jtext))
    idx = {i: k for k, i in enumerate(ids)}
    jidx = {j["id"]: k for k, j in enumerate(jds)}
    scored = [{**x, "overall": float(sim[idx[x["persona"]], jidx[x["jd"]]])} for x in pairs]
    good = [x["overall"] for x in scored if x["grade"] == 3]
    none_ = [x["overall"] for x in scored if x["grade"] == 0]
    by_jd = defaultdict(list)
    for x in scored:
        by_jd[x["jd"]].append(x)
    nd, p5 = [], []
    for xs in by_jd.values():
        xs.sort(key=lambda x: -x["overall"])
        nd.append(ndcg([x["persona"] for x in xs], {x["persona"]: x["grade"] for x in xs}, 10) or 0.0)
        p5.append(sum(x["grade"] == 3 for x in xs[:5]) / 5)
    return {"auc_same_role_vs_unrelated": auc(good, none_), "ndcg@10": round(sum(nd) / len(nd), 3), "precision@5_same_role": round(sum(p5) / len(p5), 3),
            "spearman_overall_vs_grade": spearman([x["overall"] for x in scored], [x["grade"] for x in scored])}


# ------------------------------------------------------------------ report
def to_markdown(r):
    m = r["meta"]
    L = [f"# Evaluation report — synthetic dataset v2 ({m['embedding_model']})", "", f"> **Synthetic data.** {m['notice']}", "",
         f"{m['personas']} resumes ({m['in_catalog']} in-catalog, {m['out_of_catalog']} non-tech), {m['jds']} job descriptions, "
         f"{len(m['layouts'])} layouts, seed {m['seed']}, as_of {m['as_of']}, {m['seconds']} s.", ""]
    e = r["extraction"]
    L += ["## 1. Parsing and field extraction", "", "| Field | Accuracy | n |", "|---|---|---|"]
    L += [f"| {k} | {v['accuracy']:.3f} | {v['n']} |" for k, v in e["fields"].items()]
    lays = sorted(e["by_layout"])
    L += ["", "| Field | " + " | ".join(lays) + " |", "|---|" + "---|" * len(lays)]
    for k in sorted(e["fields"]):
        L.append(f"| {k} | " + " | ".join(f"{e['by_layout'][x].get(k, float('nan')):.2f}" for x in lays) + " |")
    if e["failures"]:
        L += ["", f"Parse failures: {len(e['failures'])} — {e['failures'][:5]}"]
    for tag in ("extracted", "ground_truth"):
        s = r["skills"][tag]
        a = s["all_skills"]
        L += ["", f"## 2. Skill recognition ({tag.replace('_', ' ')} content)", "",
              f"Precision **{a['precision']}**, recall **{a['recall']}**, F1 **{a['f1']}** (tp {a['tp']}, fp {a['fp']}, fn {a['fn']}); "
              f"mean per-resume F1 {s['per_resume_f1_mean']} (95% CI {s['per_resume_f1_ci95']}). "
              f"Shown-in-work vs only-listed: P {s['demonstrated_vs_listed']['precision']}, R {s['demonstrated_vs_listed']['recall']}.", "",
              f"Most frequent false skills: {s['top_false_positives']}", "", f"Most frequent misses: {s['top_misses']}"]
        if tag == "extracted":
            L += ["", "| Profile | P | R | F1 |", "|---|---|---|---|"]
            L += [f"| {k} | {v['precision']} | {v['recall']} | {v['f1']} |" for k, v in s["by_profile"].items()]
    for tag in ("extracted", "ground_truth"):
        ro = r["roles"][tag]
        ic = ro["in_catalog"]
        L += ["", f"## 3. Role recommendation ({tag.replace('_', ' ')} content)", "",
              "| Metric | Value | 95% CI | n |", "|---|---|---|---|"]
        for k in ("hit@1_primary", "hit@1_relevant(grade>=2)", "hit@3_primary", "ndcg@5"):
            L.append(f"| {k} | {ic[k]['value']} | {ic[k]['ci95']} | {ic[k]['n']} |")
        L.append(f"| insufficient-evidence rate (in-catalog) | {ic['insufficient_evidence_rate']} | | |")
        if tag == "extracted":
            L += ["", "| Profile | hit@1 | hit@3 | nDCG@5 | n |", "|---|---|---|---|---|"]
            L += [f"| {k} | {v['hit@1']} | {v['hit@3']} | {v['ndcg@5']} | {v['n']} |" for k, v in ro["by_profile"].items()]
        o = ro["out_of_catalog"]
        L += ["", f"**Non-tech resumes (no catalog role fits):** insufficient-evidence {o['insufficient_evidence_rate']}, mean top fit "
              f"{o['mean_top_fit']} vs {o['mean_top_fit_in_catalog']} for tech resumes; AUC separating them by top fit "
              f"{o['auc_top_fit_separates_in_vs_out']}. Share with top fit ≥ threshold: {json.dumps(o['share_above_threshold'])}", "",
              f"**Seniority:** exact band {ro['seniority']['exact']}, within plausible range {ro['seniority']['within_plausible_range']} "
              f"(n={ro['seniority']['n']}). Confusion: {ro['seniority']['confusion(label->estimate)']}"]
        if ro["misses"] and tag == "extracted":
            L += ["", "Primary role not in top 3: " + "; ".join(f"{x['persona']} ({x['profile']}) → {x['top3']}" for x in ro["misses"])]
    j = r["jd_extraction"]
    L += ["", "## 4. Job-description parsing", "",
          f"Required skills P/R/F1 {j['required_skills']['precision']}/{j['required_skills']['recall']}/{j['required_skills']['f1']}; "
          f"preferred {j['preferred_skills']['precision']}/{j['preferred_skills']['recall']}/{j['preferred_skills']['f1']}; "
          f"years {j['years_accuracy']}; title {j['title_accuracy']} (n={j['n']}).", "", "| Style | P | R | F1 | Years |", "|---|---|---|---|---|"]
    L += [f"| {k} | {v['precision']} | {v['recall']} | {v['f1']} | {v['years_accuracy']} |" for k, v in sorted(j["by_style"].items())]
    if j["issues"]:
        L += ["", "Issues:"] + [f"- {x}" for x in j["issues"][:10]]
    for tag in ("extracted", "ground_truth"):
        mt = r["matching"][tag]
        L += ["", f"## 5. Resume ↔ job matching ({tag.replace('_', ' ')} content)", "",
              f"Requirement status accuracy **{mt['requirement_status']['accuracy']}** over {mt['requirement_status']['n']} requirement checks.", "",
              "| Requirement (expected) | Accuracy | n | Got |", "|---|---|---|---|"]
        L += [f"| {k} | {v['accuracy']} | {v['n']} | {v['got']} |" for k, v in sorted(mt["requirement_status"]["by_kind_and_expected"].items())]
        ps = mt["pair_score"]
        rk = mt["ranking_per_jd"]
        L += ["", f"Mean overall score by fit grade: {ps['mean_overall_by_grade']}. AUC same-role vs unrelated **{ps['auc_same_role_vs_unrelated']}**, "
              f"same-role vs related {ps['auc_same_role_vs_related']}, Spearman {ps['spearman_overall_vs_grade']} ({ps['pairs']} pairs).", "",
              f"Recruiter ranking (all resumes per JD): nDCG@10 **{rk['ndcg@10']['value']}** (95% CI {rk['ndcg@10']['ci95']}), "
              f"precision@5 {rk['precision@5_same_role']}, precision@10 {rk['precision@10_same_role']} over {rk['jds']} JDs."]
    tc = r["matching"]["extracted"]["tier_calibration"]
    L += ["", "**Score bands (extracted content):** share of resume–job pairs in each band by fit grade "
          "(3 same role, 2 closely related, 1 loosely related, 0 unrelated/non-tech).", "",
          "| Band | Range | Pairs | Same role | Close | Loose | Unrelated |", "|---|---|---|---|---|---|---|"]
    L += [f"| {k} | {v['range'][0]}–{v['range'][1]} | {v['pairs']} | {v['share_grade_3']} | {v['share_grade_2']} | {v['share_grade_1']} | {v['share_grade_0']} |"
          for k, v in tc.items()]
    b = r["baseline_tfidf"]
    L += ["", "## 6. Baseline: plain TF-IDF cosine (resume text vs JD text)", "",
          f"AUC same-role vs unrelated {b['auc_same_role_vs_unrelated']}, nDCG@10 {b['ndcg@10']}, precision@5 {b['precision@5_same_role']}, "
          f"Spearman {b['spearman_overall_vs_grade']}.", "",
          "## Limits", "",
          "- Generated data: clean single-column text, fictional names, one writer's phrasing templates. Real resumes are messier.",
          "- Skill labels use the taxonomy's canonical names and alias forms, so skill recall is an upper bound for real resumes.",
          "- Requirement-status labels follow the product's documented rules (shown in work = matched, only listed = partial).",
          "- Relevance grades between roles were assigned by the dataset author.", ""]
    return "\n".join(L)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261110)
    ap.add_argument("--per-profile", type=int, default=6)
    ap.add_argument("--embedding", default=None, choices=["tfidf", "sentence-transformers"])
    a = ap.parse_args()
    if a.embedding:
        os.environ["EMBEDDING_BACKEND"] = a.embedding
    os.environ.setdefault("DATABASE_URL", "sqlite://")
    from app.config import get_settings

    get_settings.cache_clear()
    from app.services.ml.embeddings import get_embedder
    from app.services.taxonomy import get_taxonomy
    from eval.synthetic_v2 import LAYOUTS, generate

    t0 = time.time()
    data = generate(a.seed, a.per_profile)
    personas, jds, as_of = data["personas"], data["jds"], data["as_of"]
    tax = get_taxonomy()
    layouts = list(LAYOUTS)
    extraction, extracted = eval_extraction(personas, layouts)
    # downstream uses one layout per resume (rotating), as a user uploads one file
    ex_content = {p["id"]: extracted.get((p["id"], layouts[i % len(layouts)])) for i, p in enumerate(personas)}
    ex_content = {k: v for k, v in ex_content.items() if v is not None}
    gt_content = {p["id"]: p["content"] for p in personas}
    jd_ex, parsed = eval_jd_extraction(jds, tax)
    m_ex, pairs = eval_matching(personas, ex_content, jds, parsed, tax, as_of)
    m_gt, _ = eval_matching(personas, gt_content, jds, parsed, tax, as_of)
    report = {
        "meta": {"dataset": data["version"], "seed": a.seed, "as_of": as_of, "personas": len(personas),
                 "in_catalog": sum(p["labels"]["in_catalog"] for p in personas), "out_of_catalog": sum(not p["labels"]["in_catalog"] for p in personas),
                 "jds": len(jds), "layouts": layouts, "embedding_model": get_embedder().name, "notice": data["notice"],
                 "generated_at": datetime.now(UTC).isoformat(timespec="seconds")},
        "extraction": extraction,
        "skills": {"extracted": eval_skills(personas, ex_content, tax), "ground_truth": eval_skills(personas, gt_content, tax)},
        "roles": {"extracted": eval_roles(personas, ex_content, as_of), "ground_truth": eval_roles(personas, gt_content, as_of)},
        "jd_extraction": jd_ex,
        "matching": {"extracted": m_ex, "ground_truth": m_gt},
        "baseline_tfidf": tfidf_baseline(personas, ex_content, jds, pairs),
    }
    report["meta"]["seconds"] = round(time.time() - t0, 1)
    out = ROOT / "eval" / "reports"
    out.mkdir(parents=True, exist_ok=True)
    stem = f"{datetime.now(UTC):%Y%m%d}_synthetic_v2_{report['meta']['embedding_model'].replace('/', '-').replace(':', '-')}"
    (out / f"{stem}.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    (out / f"{stem}.md").write_text(to_markdown(report), encoding="utf-8")
    print(to_markdown(report))
    print(f"\nWritten: {out / stem}.md/.json")


if __name__ == "__main__":
    main()
