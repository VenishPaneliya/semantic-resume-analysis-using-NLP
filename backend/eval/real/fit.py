"""Evaluation 1: resume–job-description fit (cnamuangtoun/resume-job-description-fit, test split).

The product's match score (`jd.match(...)["overall"]`) is treated as a classifier score against
the dataset's labels (No Fit < Potential Fit < Good Fit). Resumes are plain text, so they go
through `extract(text, pages)` exactly as text from a parsed document would.
"""

from __future__ import annotations

import csv
import random
import re
import statistics
import time
from collections import Counter

from eval.real.common import (
    DATA,
    SEED,
    auc,
    bootstrap,
    lenient_content,
    r3,
    repair_content,
    spearman,
    text_pages,
)

LABELS = {"No Fit": 0, "Potential Fit": 1, "Good Fit": 2}
INV = {v: k for k, v in LABELS.items()}


def load(max_pairs: int | None = None) -> list[dict]:
    csv.field_size_limit(10**9)
    with (DATA / "fit" / "test.csv").open(encoding="utf-8") as f:
        rows = [{"resume": r["resume_text"], "jd": r["job_description_text"], "y": LABELS[r["label"]]} for r in csv.DictReader(f)]
    if max_pairs and len(rows) > max_pairs:
        rows = random.Random(SEED).sample(rows, max_pairs)
    return rows


def _extract_stats(contents: dict) -> dict:
    from app.schemas.resume import ResumeContent
    from app.services.ml.features import resume_skill_evidence

    exp, bullets, skills, edu, demo = [], [], [], [], []
    for c in contents.values():
        rc = ResumeContent.model_validate(c)
        ev = resume_skill_evidence(rc)
        exp.append(len(rc.experience))
        bullets.append(len(rc.all_bullets()))
        skills.append(len(ev.all))
        demo.append(len(ev.demonstrated))
        edu.append(len(rc.education))
    n = len(exp)
    return {"n_resumes": n, "share_ge1_experience": r3(sum(1 for x in exp if x) / n), "mean_experience_entries": r3(statistics.mean(exp)),
            "share_ge1_bullet": r3(sum(1 for x in bullets if x) / n), "mean_bullets": r3(statistics.mean(bullets)),
            "mean_recognised_skills": r3(statistics.mean(skills)), "mean_demonstrated_skills": r3(statistics.mean(demo)),
            "share_ge1_education": r3(sum(1 for x in edu if x) / n)}


def _binary_metrics(rows: list[dict], key: str, thr: float) -> dict:
    tp = sum(1 for r in rows if r[key] >= thr and r["y"] > 0)
    fp = sum(1 for r in rows if r[key] >= thr and r["y"] == 0)
    fn = sum(1 for r in rows if r[key] < thr and r["y"] > 0)
    tn = sum(1 for r in rows if r[key] < thr and r["y"] == 0)
    p = tp / (tp + fp) if tp + fp else 0.0
    rc = tp / (tp + fn) if tp + fn else 0.0
    return {"accuracy": (tp + tn) / len(rows), "precision": p, "recall": rc, "f1": 2 * p * rc / (p + rc) if p + rc else 0.0}


def _best_threshold(rows: list[dict], key: str) -> float:
    cands = sorted({r[key] for r in rows})
    return max(cands, key=lambda t: (_binary_metrics(rows, key, t)["f1"], -t))


def _three_class(rows: list[dict], key: str, t1: float, t2: float) -> list[int]:
    return [0 if r[key] < t1 else 1 if r[key] < t2 else 2 for r in rows]


def _macro_f1(y: list[int], p: list[int]) -> float:
    f = []
    for c in (0, 1, 2):
        tp = sum(1 for a, b in zip(y, p, strict=True) if a == c and b == c)
        fp = sum(1 for a, b in zip(y, p, strict=True) if a != c and b == c)
        fn = sum(1 for a, b in zip(y, p, strict=True) if a == c and b != c)
        pr = tp / (tp + fp) if tp + fp else 0.0
        rc = tp / (tp + fn) if tp + fn else 0.0
        f.append(2 * pr * rc / (pr + rc) if pr + rc else 0.0)
    return sum(f) / 3


def _best_two_thresholds(rows: list[dict], key: str) -> tuple[float, float]:
    vals = sorted(r[key] for r in rows)
    qs = sorted({vals[int(q * (len(vals) - 1))] for q in [i / 40 for i in range(1, 40)]})
    y = [r["y"] for r in rows]
    best, arg = -1.0, (qs[0], qs[-1])
    for i, t1 in enumerate(qs):
        for t2 in qs[i:]:
            m = _macro_f1(y, _three_class(rows, key, t1, t2))
            if m > best:
                best, arg = m, (t1, t2)
    return arg


def evaluate(max_pairs: int | None = None) -> dict:
    from sklearn.feature_extraction.text import TfidfVectorizer

    from app.services.extraction.extractor import extract
    from app.services.ml.embeddings import get_embedder
    from app.services.ml.jd import extract_jd, match, prepare_resume

    emb = get_embedder()
    data = load(max_pairs)
    t0 = time.time()
    resumes = sorted({r["resume"] for r in data})
    jds = sorted({r["jd"] for r in data})
    contents, lenient, errors, invalid = {}, {}, [], []
    for t in resumes:
        try:
            c, fixed = repair_content(extract(t, text_pages(t))["content"])
            contents[t] = c
            if fixed:
                invalid.append(fixed)
        except Exception as e:  # noqa: BLE001
            errors.append({"stage": "extract", "error": f"{type(e).__name__}: {e}"[:200]})
            contents[t] = None
        lenient[t] = lenient_content(t)
    jd_ex = {}
    for t in jds:
        try:
            jd_ex[t] = extract_jd(t)
        except Exception as e:  # noqa: BLE001
            errors.append({"stage": "extract_jd", "error": f"{type(e).__name__}: {e}"[:200]})
            jd_ex[t] = None
    prep = {t: prepare_resume(c) for t, c in contents.items() if c is not None}
    prep_len = {t: prepare_resume(c) for t, c in lenient.items()}
    t_extract = time.time() - t0

    jd_ids = {t: i for i, t in enumerate(jds)}
    rows = []
    t1 = time.time()
    for r in data:
        jd = jd_ex.get(r["jd"])
        if jd is None or r["resume"] not in prep:
            continue
        try:
            m = match(None, jd, prepared=prep[r["resume"]])
            ml = match(None, jd, prepared=prep_len[r["resume"]])
        except Exception as e:  # noqa: BLE001
            errors.append({"stage": "match", "error": f"{type(e).__name__}: {e}"[:200]})
            continue
        comp = m["components"]
        rows.append({"y": r["y"], "jd_id": jd_ids[r["jd"]], "resume": r["resume"], "jd": r["jd"],
                     "system": float(m["overall"]), "system_lenient": float(ml["overall"]),
                     "c_requirement": comp["requirement_coverage"] if comp["requirement_coverage"] is not None else 0.0,
                     "c_keyword": comp["keyword_coverage"] if comp["keyword_coverage"] is not None else 0.0,
                     "c_semantic": comp["semantic_alignment"], "counts": m["counts"], "jd_title": jd.get("title"),
                     "n_req": len(jd["requirements"])})
    t_match = time.time() - t1

    # baselines: TF-IDF cosine (vectoriser fit on dev-half texts only) and raw embedding cosine of full texts
    jd_list = sorted({r["jd_id"] for r in rows})
    random.Random(SEED).shuffle(jd_list)
    dev_ids = set(jd_list[: len(jd_list) // 2])
    for r in rows:
        r["split"] = "dev" if r["jd_id"] in dev_ids else "heldout"
    dev_texts = list({r["resume"] for r in rows if r["split"] == "dev"} | {r["jd"] for r in rows if r["split"] == "dev"})
    vec = TfidfVectorizer(sublinear_tf=True, stop_words="english", ngram_range=(1, 2), min_df=2).fit(dev_texts)
    for r in rows:
        a, b = vec.transform([r["resume"]]), vec.transform([r["jd"]])
        r["tfidf_cosine"] = float((a @ b.T).toarray()[0][0])
    res_u = sorted({r["resume"] for r in rows})
    jd_u = sorted({r["jd"] for r in rows})
    sim = emb.similarity(res_u, jd_u)  # the encoder truncates long texts to its own window
    ri, ji = {t: i for i, t in enumerate(res_u)}, {t: i for i, t in enumerate(jd_u)}
    for r in rows:
        r["embedding_cosine"] = float(sim[ri[r["resume"]]][ji[r["jd"]]])

    def groups_of(rs):
        g: dict[int, list] = {}
        for r in rs:
            g.setdefault(r["jd_id"], []).append(r)
        return list(g.values())

    def auc_good_no(rs, k):
        sub = [r for r in rs if r["y"] in (0, 2)]
        return auc([int(r["y"] == 2) for r in sub], [r[k] for r in sub])

    def auc_any(rs, k):
        return auc([int(r["y"] > 0) for r in rs], [r[k] for r in rs])

    def rho(rs, k):
        return spearman([r[k] for r in rs], [r["y"] for r in rs])

    scores = ["system", "system_lenient", "tfidf_cosine", "embedding_cosine", "c_requirement", "c_keyword", "c_semantic"]
    G = groups_of(rows)
    ranking = {}
    for k in scores:
        ranking[k] = {
            "auc_good_vs_no": r3(auc_good_no(rows, k)), "auc_good_vs_no_ci95": bootstrap(lambda rs, k=k: auc_good_no(rs, k), G),
            "auc_fit_vs_no": r3(auc_any(rows, k)), "auc_fit_vs_no_ci95": bootstrap(lambda rs, k=k: auc_any(rs, k), G),
            "spearman": r3(rho(rows, k)), "spearman_ci95": bootstrap(lambda rs, k=k: rho(rs, k), G),
        }

    dev = [r for r in rows if r["split"] == "dev"]
    ho = [r for r in rows if r["split"] == "heldout"]
    Gho = groups_of(ho)
    classify = {}
    for k in ("system", "system_lenient", "tfidf_cosine", "embedding_cosine"):
        thr = _best_threshold(dev, k)
        m = _binary_metrics(ho, k, thr)
        out = {"threshold_from_dev": r3(thr), **{x: r3(v) for x, v in m.items()}}
        for x in ("accuracy", "f1"):
            out[f"{x}_ci95"] = bootstrap(lambda rs, k=k, thr=thr, x=x: _binary_metrics(rs, k, thr)[x], Gho)
        t_lo, t_hi = _best_two_thresholds(dev, k)
        pred = _three_class(ho, k, t_lo, t_hi)
        y = [r["y"] for r in ho]
        conf = {INV[a]: {INV[b]: sum(1 for yy, pp in zip(y, pred, strict=True) if yy == a and pp == b) for b in (0, 1, 2)} for a in (0, 1, 2)}
        out["three_class"] = {"thresholds_from_dev": [r3(t_lo), r3(t_hi)], "accuracy": r3(sum(int(a == b) for a, b in zip(y, pred, strict=True)) / len(y)),
                              "macro_f1": r3(_macro_f1(y, pred)), "confusion_rows_true_cols_pred": conf}
        classify[k] = out
    maj_dev = Counter(r["y"] for r in dev).most_common(1)[0][0]
    y_ho = [r["y"] for r in ho]
    majority = {"majority_class_from_dev": INV[maj_dev], "binary_accuracy": r3(sum(1 for y in y_ho if (y > 0) == (maj_dev > 0)) / len(y_ho)),
                "binary_f1_fit": 0.0 if maj_dev == 0 else None, "three_class_accuracy": r3(sum(1 for y in y_ho if y == maj_dev) / len(y_ho)),
                "three_class_macro_f1": r3(_macro_f1(y_ho, [maj_dev] * len(y_ho)))}

    by_label = {INV[c]: {k: r3(statistics.mean(r[k] for r in rows if r["y"] == c)) for k in ("system", "system_lenient", "tfidf_cosine")}
                for c in (0, 1, 2)}
    rows_sorted = sorted(rows, key=lambda r: r["system"])
    fp_examples = [{"jd_title": r["jd_title"], "label": INV[r["y"]], "score": r["system"], "counts": r["counts"]}
                   for r in reversed(rows_sorted) if r["y"] == 0][:5]
    fn_examples = [{"jd_title": r["jd_title"], "label": INV[r["y"]], "score": r["system"], "counts": r["counts"]}
                   for r in rows_sorted if r["y"] == 2][:5]
    req_counts = [len(j["requirements"]) for j in jd_ex.values() if j]
    kinds = Counter(k["kind"] for j in jd_ex.values() if j for k in j["requirements"])
    status = Counter()
    for r in rows:
        status.update(r["counts"])
    return {
        "dataset": "cnamuangtoun/resume-job-description-fit (test.csv)",
        "n_pairs": len(rows), "n_unique_resumes": len(resumes), "n_unique_jds": len(jds),
        "label_counts": {INV[c]: sum(1 for r in rows if r["y"] == c) for c in (0, 1, 2)},
        "split": {"rule": "job descriptions shuffled (seed) and halved; all pairs of a JD go to one half",
                  "dev_pairs": len(dev), "heldout_pairs": len(ho), "dev_jds": len(dev_ids), "heldout_jds": len(jd_list) - len(dev_ids)},
        "bootstrap": "1000 resamples of job descriptions (cluster bootstrap), percentile 95% CI",
        "ranking_all_pairs": ranking, "classification_heldout": classify, "majority_baseline_heldout": majority,
        "mean_score_by_label": by_label,
        "resume_extraction": _extract_stats({t: c for t, c in contents.items() if c}),
        "jd_extraction": {"n": len(req_counts), "mean_requirements": r3(statistics.mean(req_counts)),
                          "share_zero_requirements": r3(sum(1 for x in req_counts if not x) / len(req_counts)), "requirement_kinds": dict(kinds)},
        "requirement_status_counts_over_pairs": dict(status),
        "highest_scored_no_fit": fp_examples, "lowest_scored_good_fit": fn_examples,
        "extracted_content_failing_schema": {"n_resumes": len(invalid), "of": len(resumes),
                                             "fields": dict(Counter(re.sub(r"\.\d+\.", ".*.", p) for f in invalid for p in f))},
        "errors": errors, "seconds_extract": round(t_extract, 1), "seconds_match": round(t_match, 1),
    }
