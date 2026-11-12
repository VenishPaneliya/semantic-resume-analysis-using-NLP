"""Evaluation 4: extract_jd on live public job postings, plus a 30-posting hand-labelled sample.

    python -m eval.real.jobs --dump-label-sample   # writes the sample's plain text for labelling

The label file (eval/real/job_labels.json) was written from the dumped text only, before any
model output for those postings was looked at.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import statistics
import time

from eval.real.common import DATA, ROOT, SEED, bootstrap, html_to_text, language, language_detail, prf, r3

N_TARGET = 250
N_LABEL = 30
LABELS = ROOT / "eval" / "real" / "job_labels.json"


def load_sample() -> tuple[dict, list[dict]]:
    snap = json.loads((DATA / "jobs" / "postings.json").read_text(encoding="utf-8"))
    jobs = []
    seen = set()
    for j in snap["jobs"]:
        key = (j["source"], j["id"])
        if key in seen or not j.get("html"):
            continue
        seen.add(key)
        jobs.append({**j, "text": html_to_text(j["html"])})
    rng = random.Random(SEED)
    # every Remotive and RemoteOK posting (small feeds), Arbeitnow fills up to N_TARGET
    keep = [j for j in jobs if j["source"] != "arbeitnow"]
    an = [j for j in jobs if j["source"] == "arbeitnow"]
    rng.shuffle(an)
    keep += an[: max(0, N_TARGET - len(keep))]
    for j in keep:
        j["lang_filter"] = language(j["text"])
        j["lang"] = language_detail(j["text"])
    return snap, keep


def label_sample(sample: list[dict]) -> list[dict]:
    rng = random.Random(SEED + 4)
    en = [j for j in sample if j["lang_filter"] == "en"]
    return rng.sample(en, N_LABEL)


def dump_label_sample() -> None:
    _, sample = load_sample()
    out = DATA / "jobs" / "label_sample.txt"
    with out.open("w", encoding="utf-8") as f:
        for j in label_sample(sample):
            f.write(f"\n\n######## {j['source']}:{j['id']} | {j['title']} | {j['company']}\n{j['text']}\n")
    print(out)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9+#]+", " ", s.lower()).strip()


def evaluate() -> dict:
    from app.services.ml.jd import extract_jd
    from app.services.taxonomy import get_taxonomy

    tax = get_taxonomy()
    snap, sample = load_sample()
    rows, errors = [], []
    t0 = time.time()
    per = []
    for j in sample:
        t = time.time()
        try:
            jd = extract_jd(j["text"])
        except Exception as e:  # noqa: BLE001
            errors.append({"id": f"{j['source']}:{j['id']}", "error": f"{type(e).__name__}: {e}"[:200]})
            continue
        per.append(time.time() - t)
        reqs = jd["requirements"]
        rows.append({
            "key": f"{j['source']}:{j['id']}", "source": j["source"], "lang": j["lang"], "title_api": j["title"],
            "title": jd["title"], "n_req": len(reqs), "n_req_with_skill": sum(1 for r in reqs if r["skills"]),
            "kinds": [r["kind"] for r in reqs], "years": jd["years_required"], "education": jd["education"],
            "skills_all": jd["skills"], "skills_req": sorted({s for r in reqs for s in r["skills"]}),
            "fallback": bool(reqs) and all(r["text"] in jd["skills"] and r["skills"] == [r["text"]] for r in reqs),
            "chars": len(j["text"]), "api_title_in_text": bool(j["title"]) and _norm(j["title"]) in _norm(j["text"]),
        })
    total_s = time.time() - t0

    def agg(rs: list[dict]) -> dict:
        n = len(rs)
        if not n:
            return {"n": 0}
        title_eq = [r for r in rs if r["title"] and _norm(r["title"]) == _norm(r["title_api"] or "")]
        title_overlap = [r for r in rs if r["title"] and (set(_norm(r["title"]).split()) & set(_norm(r["title_api"] or "").split()))]
        return {
            "n": n,
            "share_title_found": r3(sum(1 for r in rs if r["title"]) / n),
            "share_api_title_appears_in_text": r3(sum(1 for r in rs if r["api_title_in_text"]) / n),
            "share_title_equals_api_title_when_in_text": r3(sum(1 for r in rs if r["api_title_in_text"] and r["title"] and _norm(r["title"]) == _norm(r["title_api"])) / max(1, sum(1 for r in rs if r["api_title_in_text"]))),
            "share_title_equals_api_title": r3(len(title_eq) / n),
            "share_title_shares_a_word_with_api_title": r3(len(title_overlap) / n),
            "share_ge1_requirement": r3(sum(1 for r in rs if r["n_req"] >= 1) / n),
            "share_structured_requirements": r3(sum(1 for r in rs if r["n_req"] and not r["fallback"]) / n),
            "share_skill_fallback_only": r3(sum(1 for r in rs if r["fallback"]) / n),
            "mean_requirements": r3(statistics.mean(r["n_req"] for r in rs)),
            "median_requirements": statistics.median(r["n_req"] for r in rs),
            "share_years_extracted": r3(sum(1 for r in rs if r["years"] is not None) / n),
            "share_degree_extracted": r3(sum(1 for r in rs if r["education"]) / n),
            "mean_taxonomy_skills_mentioned": r3(statistics.mean(len(r["skills_all"]) for r in rs)),
            "share_zero_taxonomy_skills": r3(sum(1 for r in rs if not r["skills_all"]) / n),
        }

    groups = [[r] for r in rows]
    summary = {"all": agg(rows), **{f"source={s}": agg([r for r in rows if r["source"] == s]) for s in sorted({r["source"] for r in rows})},
               **{f"lang={lg}": agg([r for r in rows if r["lang"] == lg]) for lg in ("en", "de", "fr", "nl")}}
    for k in ("share_title_found", "share_ge1_requirement", "share_years_extracted", "share_degree_extracted"):
        field = {"share_title_found": "title", "share_ge1_requirement": "n_req", "share_years_extracted": "years",
                 "share_degree_extracted": "education"}[k]
        summary["all"][k + "_ci95"] = bootstrap(
            lambda rs, f=field: sum(1 for r in rs if (r[f] is not None and r[f] != 0 and r[f] != "")) / len(rs), groups)
    kinds = {}
    for r in rows:
        for k in r["kinds"]:
            kinds[k] = kinds.get(k, 0) + 1
    result = {
        "fetched_at": snap["fetched_at"], "fetch_errors": snap["errors"], "n_postings_fetched": len(snap["jobs"]),
        "n_evaluated": len(sample), "parse_errors": errors, "runtime_seconds_total": round(total_s, 2),
        "runtime_ms_per_posting_mean": round(1000 * statistics.mean(per), 1) if per else None,
        "runtime_ms_per_posting_p95": round(1000 * sorted(per)[int(0.95 * len(per))], 1) if per else None,
        "summary": summary, "requirement_kinds": kinds,
        "examples_no_requirement": [{"key": r["key"], "api_title": r["title_api"], "lang": r["lang"]} for r in rows if not r["n_req"]][:8],
        "examples_title_mismatch": [{"key": r["key"], "api_title": r["title_api"], "extracted": r["title"]}
                                    for r in rows if r["lang"] == "en" and not (r["title"] and set(_norm(r["title"]).split()) & set(_norm(r["title_api"] or "").split()))][:10],
    }
    result["hand_labelled"] = eval_labels(rows, tax)
    return result


def eval_labels(rows: list[dict], tax) -> dict:
    if not LABELS.exists():
        return {"status": "no label file"}
    lab = json.loads(LABELS.read_text(encoding="utf-8"))
    by_key = {r["key"]: r for r in rows}
    agg = {"req_all": [0, 0, 0], "req_tax": [0, 0, 0], "any_all": [0, 0, 0], "any_tax": [0, 0, 0]}
    years_ok, years_n, details, per_post = 0, 0, [], []
    for item in lab["postings"]:
        r = by_key.get(item["key"])
        if r is None:
            continue
        gold_all = {(tax.canonical(s) or s) for s in item["skills"]}
        gold_tax = {s for s in gold_all if s in tax.skills}
        for name, pred_set in (("req", set(r["skills_req"])), ("any", set(r["skills_all"]))):
            for scope, gold in (("all", gold_all), ("tax", gold_tax)):
                a = agg[f"{name}_{scope}"]
                a[0] += len(pred_set & gold)
                a[1] += len(pred_set - gold)
                a[2] += len(gold - pred_set)
        per_post.append({"key": item["key"], "gold": sorted(gold_all), "pred_req": r["skills_req"],
                         "tp": len(set(r["skills_req"]) & gold_tax), "fp": sorted(set(r["skills_req"]) - gold_all),
                         "fn_in_taxonomy": sorted(gold_tax - set(r["skills_req"])),
                         "years_gold": item["years"], "years_pred": r["years"]})
        years_n += 1
        years_ok += int(item["years"] == r["years"])
        if item["years"] != r["years"]:
            details.append({"key": item["key"], "gold": item["years"], "pred": r["years"]})

    def boot_prf(scope_key):
        def f(rs):
            tp = fp = fn = 0
            for p in rs:
                gold = set(p["gold"]) if scope_key == "all" else {s for s in p["gold"] if s in tax.skills}
                pred = set(p["pred_req"])
                tp += len(pred & gold)
                fp += len(pred - gold)
                fn += len(gold - pred)
            pr = tp / (tp + fp) if tp + fp else 0
            rc = tp / (tp + fn) if tp + fn else 0
            return 2 * pr * rc / (pr + rc) if pr + rc else 0.0
        return f

    groups = [[p] for p in per_post]
    return {
        "annotator_note": lab["note"], "labelled_on": lab.get("labelled_on"), "n_postings": len(per_post),
        "gold_skill_mentions": sum(len(p["gold"]) for p in per_post),
        "gold_in_taxonomy": sum(1 for p in per_post for s in p["gold"] if s in tax.skills),
        "requirement_skills_vs_gold_in_taxonomy": {**prf(*agg["req_tax"]), "f1_ci95": bootstrap(boot_prf("tax"), groups)},
        "requirement_skills_vs_all_gold": {**prf(*agg["req_all"]), "f1_ci95": bootstrap(boot_prf("all"), groups)},
        "all_mentioned_skills_vs_gold_in_taxonomy": prf(*agg["any_tax"]),
        "all_mentioned_skills_vs_all_gold": prf(*agg["any_all"]),
        "years_accuracy": r3(years_ok / years_n) if years_n else None, "years_n": years_n,
        "years_accuracy_ci95": bootstrap(lambda rs: sum(int(p["years_gold"] == p["years_pred"]) for p in rs) / len(rs), groups),
        "years_with_gold_stated": sum(1 for p in per_post if p["years_gold"] is not None),
        "years_errors": details, "per_posting": per_post,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump-label-sample", action="store_true")
    a = ap.parse_args()
    if a.dump_label_sample:
        dump_label_sample()
