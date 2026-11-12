"""Evaluation 2: resume category -> role recommendation (ahmedheakl/resume-atlas).

Only categories with a clear counterpart in the role catalogue are mapped. A category may map to
more than one relevant role (binary relevance). Other technical categories with no clear
counterpart are skipped; non-technical categories are used as out-of-scope controls.
"""

from __future__ import annotations

import math
import random
import statistics
import time
from collections import defaultdict

from eval.real.common import DATA, SEED, auc, bootstrap, lenient_content, r3, repair_content, text_pages

MAPPING = {
    "Java Developer": ["backend_developer", "fullstack_developer"],
    "Python Developer": ["backend_developer", "fullstack_developer"],
    "DotNet Developer": ["backend_developer", "fullstack_developer"],
    "React Developer": ["frontend_developer", "fullstack_developer"],
    "Web Designing": ["frontend_developer"],
    "Data Science": ["data_scientist", "ml_engineer"],
    "DevOps": ["devops_engineer"],
    "Testing": ["qa_automation_engineer"],
    "ETL Developer": ["data_engineer"],
    "Business Analyst": ["data_analyst"],
}
NOT_MAPPED_TECH = ["SQL Developer", "Database", "Information Technology", "Network Security Engineer", "SAP Developer", "Blockchain"]
OUT_OF_SCOPE = ["Accountant", "Advocate", "Agriculture", "Apparel", "Arts", "Automobile", "Aviation", "Banking", "BPO",
                "Building and Construction", "Civil Engineer", "Food and Beverages", "Health and Fitness", "Human Resources",
                "Public Relations", "Sales"]
PER_CATEGORY = 100
PER_OOS_CATEGORY = 20


def load() -> tuple[list[dict], dict]:
    import pyarrow.parquet as pq

    rows = pq.read_table(DATA / "atlas" / "train.parquet").to_pylist()
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r["Category"]].append(r["Text"])
    rng = random.Random(SEED)
    sample = []
    for cat, n in [(c, PER_CATEGORY) for c in MAPPING] + [(c, PER_OOS_CATEGORY) for c in OUT_OF_SCOPE]:
        texts = sorted(set(by_cat[cat]))
        for t in rng.sample(texts, min(n, len(texts))):
            sample.append({"category": cat, "text": t, "in_scope": cat in MAPPING})
    return sample, {c: len(v) for c, v in by_cat.items()}


def _rank_metrics(ranked: list[str], rel: set[str]) -> dict:
    dcg = sum(1 / math.log2(i + 2) for i, r in enumerate(ranked[:5]) if r in rel)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(rel), 5)))
    return {"hit@1": int(bool(ranked) and ranked[0] in rel), "hit@3": int(bool(rel & set(ranked[:3]))),
            "ndcg@5": dcg / idcg if idcg else 0.0}


def evaluate() -> dict:
    from sklearn.feature_extraction.text import TfidfVectorizer

    from app.services.extraction.extractor import extract
    from app.services.ml.recommender import recommend
    from app.services.taxonomy import get_taxonomy

    tax = get_taxonomy()
    roles = list(tax.roles.values())
    sample, cat_sizes = load()
    t0 = time.time()
    errors, schema_fixes = [], 0
    # TF-IDF baseline: resume text vs role profile text, vectoriser fit on role profiles + sample texts (unsupervised)
    vec = TfidfVectorizer(sublinear_tf=True, stop_words="english").fit([r.profile_text() for r in roles] + [s["text"] for s in sample])
    prof = vec.transform([r.profile_text() for r in roles])
    for s in sample:
        out = {}
        for variant in ("pipeline", "lenient"):
            try:
                if variant == "pipeline":
                    content, fixed = repair_content(extract(s["text"], text_pages(s["text"]))["content"])
                    schema_fixes += int(bool(fixed))
                else:
                    content = lenient_content(s["text"])
                rec = recommend(content)
            except Exception as e:  # noqa: BLE001
                errors.append({"variant": variant, "category": s["category"], "error": f"{type(e).__name__}: {e}"[:200]})
                out[variant] = None
                continue
            if rec["status"] == "ok":
                ranked = [x["role_id"] for x in rec["all_scores"]]
                top_fit = rec["all_scores"][0]["fit_score"]
            else:
                ranked = [x["role_id"] for x in rec["tentative"]]  # top-3 only
                top_fit = rec["tentative"][0]["fit_score"] if rec["tentative"] else 0.0
            out[variant] = {"status": rec["status"], "ranked": ranked, "top_fit": top_fit}
        sims = (vec.transform([s["text"]]) @ prof.T).toarray()[0]
        out["tfidf"] = {"status": "ok", "ranked": [roles[i].id for i in sims.argsort()[::-1]], "top_fit": float(sims.max())}
        s["out"] = out
    seconds = time.time() - t0

    inscope = [s for s in sample if s["in_scope"]]

    def summarise(variant: str, rows: list[dict]) -> dict:
        rs = [s for s in rows if s["out"].get(variant)]
        if not rs:
            return {"n": 0}
        strict, ok_only = [], []
        for s in rs:
            o = s["out"][variant]
            rel = set(MAPPING[s["category"]])
            m = _rank_metrics(o["ranked"], rel)
            if o["status"] == "ok":
                ok_only.append(m)
                strict.append(m)
            else:
                strict.append({"hit@1": 0, "hit@3": 0, "ndcg@5": 0.0})
            s.setdefault("m", {})[variant] = {"strict": strict[-1], "ungated_hit@1": m["hit@1"], "ungated_hit@3": m["hit@3"]}
        n = len(rs)
        res = {"n": n, "insufficient_evidence_rate": r3(sum(1 for s in rs if s["out"][variant]["status"] != "ok") / n)}
        for k in ("hit@1", "hit@3", "ndcg@5"):
            res[k] = r3(statistics.mean(m[k] for m in strict))
        res["n_ok"] = len(ok_only)
        for k in ("hit@1", "hit@3", "ndcg@5"):
            res[f"{k}_given_ok"] = r3(statistics.mean(m[k] for m in ok_only)) if ok_only else None
        # ranking quality ignoring the insufficient-evidence gate (top-3 from the tentative list)
        res["ungated_hit@1"] = r3(statistics.mean(s["m"][variant]["ungated_hit@1"] for s in rs))
        res["ungated_hit@3"] = r3(statistics.mean(s["m"][variant]["ungated_hit@3"] for s in rs))
        return res

    overall, ci = {}, {}
    groups = [[s] for s in inscope]
    for v in ("pipeline", "lenient", "tfidf"):
        overall[v] = summarise(v, inscope)
        for k in ("hit@1", "hit@3", "ndcg@5"):
            ci[f"{v}.{k}"] = bootstrap(lambda rs, v=v, k=k: statistics.mean(s["m"][v]["strict"][k] for s in rs if v in s.get("m", {})), groups)
        for k in ("ungated_hit@1", "ungated_hit@3"):
            ci[f"{v}.{k}"] = bootstrap(lambda rs, v=v, k=k: statistics.mean(s["m"][v][k] for s in rs if v in s.get("m", {})), groups)
    per_cat = {c: {v: summarise(v, [s for s in inscope if s["category"] == c]) for v in ("pipeline", "lenient", "tfidf")} for c in MAPPING}
    random_baseline = {"hit@1": r3(statistics.mean(len(MAPPING[s["category"]]) / len(roles) for s in inscope)),
                       "hit@3": r3(statistics.mean(1 - math.comb(len(roles) - len(MAPPING[s["category"]]), 3) / math.comb(len(roles), 3) for s in inscope))}

    # most frequent wrong top-1 per category (lenient + pipeline-when-ok)
    confusions = {}
    for c in MAPPING:
        cnt = defaultdict(int)
        for s in inscope:
            o = s["out"].get("lenient")
            if s["category"] == c and o and o["ranked"] and o["ranked"][0] not in MAPPING[c]:
                cnt[o["ranked"][0]] += 1
        confusions[c] = sorted(cnt.items(), key=lambda x: -x[1])[:3]

    # out-of-scope control: does the top fit score separate mapped tech resumes from non-tech ones?
    oos = [s for s in sample if not s["in_scope"]]
    scope = {}
    for v in ("pipeline", "lenient"):
        a = [s for s in sample if s["out"].get(v)]
        scope[v] = {
            "n_in_scope": sum(1 for s in a if s["in_scope"]), "n_out_of_scope": sum(1 for s in a if not s["in_scope"]),
            "mean_top_fit_in_scope": r3(statistics.mean(s["out"][v]["top_fit"] for s in a if s["in_scope"])),
            "mean_top_fit_out_of_scope": r3(statistics.mean(s["out"][v]["top_fit"] for s in a if not s["in_scope"])),
            "auc_top_fit_in_vs_out": r3(auc([int(s["in_scope"]) for s in a], [s["out"][v]["top_fit"] for s in a])),
            "insufficient_rate_out_of_scope": r3(sum(1 for s in a if not s["in_scope"] and s["out"][v]["status"] != "ok") / max(1, len(oos))),
            "out_of_scope_top1_counts": dict(sorted(defaultdict(int, {}).items())),
        }
        top = defaultdict(int)
        for s in a:
            if not s["in_scope"] and s["out"][v]["ranked"]:
                top[s["out"][v]["ranked"][0]] += 1
        scope[v]["out_of_scope_top1_counts"] = dict(sorted(top.items(), key=lambda x: -x[1]))
    return {
        "dataset": "ahmedheakl/resume-atlas", "category_sizes": cat_sizes, "mapping": MAPPING,
        "not_mapped_technical": NOT_MAPPED_TECH, "out_of_scope_controls": OUT_OF_SCOPE,
        "sampling": f"up to {PER_CATEGORY} per mapped category and {PER_OOS_CATEGORY} per out-of-scope category, seed {SEED}, de-duplicated texts",
        "n_in_scope": len(inscope), "n_out_of_scope": len(oos), "overall": overall, "ci95": ci, "per_category": per_cat,
        "random_baseline": random_baseline, "top1_confusions_lenient": confusions, "scope_control": scope,
        "pipeline_content_schema_repairs": schema_fixes, "errors": errors[:20], "n_errors": len(errors), "seconds": round(seconds, 1),
    }
