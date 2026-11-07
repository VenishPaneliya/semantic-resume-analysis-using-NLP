"""Reproducible evaluation on the SYNTHETIC development dataset.

    python -m eval.run_eval [--split dev|test|all] [--embedding tfidf|sentence-transformers]

Writes eval/reports/<date>_<embedding>_<split>.{json,md}. Numbers measure behaviour on
fictional, developer-written resumes rendered in three layouts; they say little about real
resumes. See docs/EVALUATION.md for the protocol for consented real data.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _phone(s: str | None) -> str:
    return re.sub(r"\D", "", s or "")


def eval_extraction(personas: list[dict]) -> dict:
    from app.services.extraction.extractor import extract
    from app.services.parsing.parsers import parse_document
    from eval.synthetic import render

    fields: dict[str, list[int]] = defaultdict(list)
    by_layout: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    by_level: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    skill_tp = skill_fp = skill_fn = 0
    skill_by_layout: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])
    failures = []
    for p in personas:
        gt = p["content"]
        for layout in ("A", "B", "C"):
            kind, data = render(p, layout)
            try:
                parsed = parse_document(kind, data)
                ex = extract(parsed["text"], parsed["pages"])["content"]
            except Exception as e:  # noqa: BLE001
                failures.append({"persona": p["id"], "layout": layout, "error": str(e)[:120]})
                continue

            def rec(name: str, ok: bool, layout=layout, p=p):
                fields[name].append(int(ok))
                by_layout[layout][name].append(int(ok))
                by_level[p["level"]][name].append(int(ok))

            rec("contact.name", _norm(ex["contact"]["name"]) == _norm(gt["contact"]["name"]))
            rec("contact.email", (ex["contact"]["email"] or "").lower() == (gt["contact"]["email"] or "").lower())
            if gt["contact"].get("phone"):
                rec("contact.phone", _phone(ex["contact"]["phone"]) == _phone(gt["contact"]["phone"]))
            rec("experience.count", len(ex["experience"]) == len(gt["experience"]))
            for i, ge in enumerate(gt["experience"]):
                ee = ex["experience"][i] if i < len(ex["experience"]) else {}
                rec("experience.title", _norm(ee.get("title")) == _norm(ge["title"]))
                rec("experience.organization", _norm(ee.get("organization")) == _norm(ge["organization"]))
                rec("experience.start", ee.get("start") == ge.get("start"))
                rec("experience.end/current", (ee.get("current") and ge.get("current")) or ee.get("end") == ge.get("end"))
                ext_b = {_norm(b["text"]) for b in ee.get("bullets", [])}
                for gb in ge["bullets"]:
                    rec("experience.bullet_recall", _norm(gb) in ext_b)
            rec("education.count", len(ex["education"]) == len(gt["education"]))
            for i, ged in enumerate(gt["education"]):
                ed = ex["education"][i] if i < len(ex["education"]) else {}
                rec("education.degree", _norm(ged["degree"]) in _norm(ed.get("degree")) if ed.get("degree") else False)
                rec("education.institution", _norm(ed.get("institution")) == _norm(ged["institution"]))
            rec("projects.count", len(ex["projects"]) == len(gt.get("projects", [])))
            gts = set(gt["skills"]["technical"])
            exs = set(ex["skills"]["technical"])
            tp, fp, fn = len(gts & exs), len(exs - gts), len(gts - exs)
            skill_tp, skill_fp, skill_fn = skill_tp + tp, skill_fp + fp, skill_fn + fn
            agg = skill_by_layout[layout]
            agg[0] += tp
            agg[1] += fp
            agg[2] += fn

    def acc(d):
        return {k: {"accuracy": round(sum(v) / len(v), 3), "n": len(v)} for k, v in sorted(d.items())}

    def prf(tp, fp, fn):
        p_ = tp / (tp + fp) if tp + fp else 0.0
        r_ = tp / (tp + fn) if tp + fn else 0.0
        return {"precision": round(p_, 3), "recall": round(r_, 3), "f1": round(2 * p_ * r_ / (p_ + r_), 3) if p_ + r_ else 0.0,
                "tp": tp, "fp": fp, "fn": fn}

    return {
        "fields": acc(fields),
        "by_layout": {k: acc(v) for k, v in by_layout.items()},
        "by_level": {k: {"mean_field_accuracy": round(sum(sum(x) for x in v.values()) / max(1, sum(len(x) for x in v.values())), 3)}
                     for k, v in by_level.items()},
        "skills": prf(skill_tp, skill_fp, skill_fn),
        "skills_by_layout": {k: prf(*v) for k, v in skill_by_layout.items()},
        "failures": failures,
    }


def eval_recommendations(personas: list[dict], as_of: str | None = None) -> dict:
    from app.services.ml.recommender import recommend

    rows = []
    for p in personas:
        rel = set(p["labels"]["relevant_roles"])
        rec = recommend(p["content"], as_of=as_of)
        if p["labels"].get("expect_insufficient"):
            rows.append({"persona": p["id"], "insufficient_expected": True, "insufficient_returned": rec["status"] == "insufficient_evidence"})
            continue
        ranked = [r["role_id"] for r in rec.get("all_scores", [])]
        top = ranked[:5]
        dcg = sum(1 / math.log2(i + 2) for i, r in enumerate(top) if r in rel)
        idcg = sum(1 / math.log2(i + 2) for i in range(min(len(rel), 5)))
        rows.append({
            "persona": p["id"], "level": p["level"], "relevant": sorted(rel), "top3": ranked[:3],
            "hit@1": int(bool(ranked) and ranked[0] in rel), "hit@3": int(bool(rel & set(ranked[:3]))),
            "precision@3": round(len(rel & set(ranked[:3])) / 3, 3), "ndcg@5": round(dcg / idcg, 3) if idcg else 0.0,
            "seniority_expected": p["labels"]["seniority"], "seniority_estimate": rec["seniority"]["estimate"],
            "seniority_in_range": p["labels"]["seniority"] in rec["seniority"]["plausible_range"],
            "status": rec["status"],
        })
    scored = [r for r in rows if "hit@1" in r]
    mean = lambda k: round(sum(r[k] for r in scored) / len(scored), 3) if scored else None  # noqa: E731
    return {
        "summary": {"n": len(scored), "hit@1": mean("hit@1"), "hit@3": mean("hit@3"), "precision@3": mean("precision@3"),
                    "ndcg@5": mean("ndcg@5"),
                    "seniority_in_plausible_range": round(sum(r["seniority_in_range"] for r in scored) / len(scored), 3) if scored else None,
                    "insufficient_evidence_correct": [r for r in rows if "insufficient_expected" in r]},
        "per_persona": rows,
    }


def eval_jd(personas_by_id: dict, split_ids: set[str], as_of: str | None = None) -> dict:
    from app.services.ml.jd import extract_jd, match

    cases = json.loads((ROOT / "eval" / "cases" / "jd_cases.json").read_text(encoding="utf-8"))
    conf: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    correct = total = 0
    misses = []
    for lab in cases["labels"]:
        if lab["persona"] not in split_ids:
            continue
        jd = extract_jd(cases["jds"][lab["jd"]])
        m = match(personas_by_id[lab["persona"]]["content"], jd, as_of=as_of)
        got = {r["text"]: r["status"] for r in m["requirements"]}
        for text, exp in lab["expected"].items():
            g = got.get(text, "not_extracted")
            conf[exp][g] += 1
            total += 1
            correct += int(g == exp)
            if g != exp:
                misses.append({"persona": lab["persona"], "jd": lab["jd"], "requirement": text, "expected": exp, "got": g})
    return {"accuracy": round(correct / total, 3) if total else None, "n": total,
            "confusion": {k: dict(v) for k, v in conf.items()}, "misses": misses}


def eval_grounding(personas_by_id: dict) -> dict:
    from app.schemas.resume import ResumeContent
    from app.services.llm.grounding import verify

    cases = json.loads((ROOT / "eval" / "cases" / "rewrite_cases.json").read_text(encoding="utf-8"))["cases"]
    tp = fn = fp_cases = faithful = 0
    details = []
    for c in cases:
        content = ResumeContent.model_validate(personas_by_id[c["persona"]]["content"])
        g = verify(c["rewrite"], content, source_text=c["source"])
        flagged = {u["value"].lower() for u in g["unsupported"]}
        labelled = {x.lower() for x in c["unsupported"]}
        hit = {x for x in labelled if any(x in f or f in x for f in flagged)}
        tp += len(hit)
        fn += len(labelled - hit)
        extra = {f for f in flagged if not any(x in f or f in x for x in labelled)}
        if not labelled:
            faithful += 1
            fp_cases += int(bool(flagged))
        details.append({"rewrite": c["rewrite"], "labelled": sorted(labelled), "flagged": sorted(flagged),
                        "missed": sorted(labelled - hit), "extra_flags": sorted(extra)})
    return {"claim_detection_recall": round(tp / (tp + fn), 3) if tp + fn else None, "labelled_claims": tp + fn,
            "faithful_rewrites": faithful, "faithful_rewrites_falsely_flagged": fp_cases,
            "false_positive_rate_on_faithful": round(fp_cases / faithful, 3) if faithful else None, "details": details}


def eval_rewriting_provider(personas: list[dict]) -> dict:
    """Unsupported claims introduced by the *configured* provider when rewriting every
    bullet. With the default fixture provider this measures the pipeline, not a model."""
    from app.schemas.resume import ResumeContent
    from app.services.llm.grounding import verify
    from app.services.llm.providers import get_provider
    from app.services.llm.service import (
        OP_INSTRUCTIONS,
        SCHEMA_HINTS,
        SYSTEM_PROMPT,
        RewriteOut,
        resume_context_for,
    )

    prov = get_provider()
    n = introduced = 0
    examples = []
    for p in personas:
        c = ResumeContent.model_validate(p["content"])
        items = [{"id": f"b{i}", "text": t} for i, (_, _, t) in enumerate(c.all_bullets())]
        if not items:
            continue
        user = (f"Operation: rewrite_bullet\nInstruction: {OP_INSTRUCTIONS['rewrite_bullet']}\nRespond with JSON exactly like: "
                f"{SCHEMA_HINTS[RewriteOut]}\n\n<resume_data>\n{resume_context_for(c)}\n</resume_data>\n"
                f"<task_json>{json.dumps({'items': items})}</task_json>")
        try:
            out = RewriteOut.model_validate_json(prov.complete_json(SYSTEM_PROMPT, user, operation="rewrite_bullet").text)
        except Exception as e:  # noqa: BLE001
            return {"provider": prov.name, "status": f"error: {type(e).__name__}"}
        src = {i["id"]: i["text"] for i in items}
        for r in out.revised:
            if r.target_id not in src:
                continue
            n += 1
            g = verify(r.text, c, source_text=src[r.target_id])
            if g["unsupported"]:
                introduced += 1
                if len(examples) < 5:
                    examples.append({"before": src[r.target_id], "after": r.text, "unsupported": g["unsupported"]})
    return {"provider": prov.name, "model": prov.model, "rewrites": n, "rewrites_with_unsupported_claims": introduced,
            "rate": round(introduced / n, 3) if n else None, "examples": examples,
            "note": "fixture provider is rule-based; configure LLM_PROVIDER to measure a real model" if prov.name == "fixture" else None}


def to_markdown(r: dict) -> str:
    L = [f"# Evaluation report — {r['meta']['split']} split", "",
         f"> **Synthetic data only.** {r['meta']['notice']}", "",
         "| Setting | Value |", "|---|---|"]
    for k, v in r["meta"].items():
        if k != "notice":
            L.append(f"| {k} | {v} |")
    e = r["extraction"]
    L += ["", "## Field extraction (3 layouts × personas)", "", "| Field | Accuracy | n |", "|---|---|---|"]
    L += [f"| {k} | {v['accuracy']:.3f} | {v['n']} |" for k, v in e["fields"].items()]
    s = e["skills"]
    L += ["", f"**Skill extraction:** precision {s['precision']}, recall {s['recall']}, F1 {s['f1']} (tp={s['tp']}, fp={s['fp']}, fn={s['fn']})", "",
          "| Layout | Skill P | Skill R | Mean field accuracy |", "|---|---|---|---|"]
    for lay, v in sorted(e["skills_by_layout"].items()):
        flds = e["by_layout"][lay]
        mean = sum(x["accuracy"] * x["n"] for x in flds.values()) / max(1, sum(x["n"] for x in flds.values()))
        L.append(f"| {lay} | {v['precision']} | {v['recall']} | {mean:.3f} |")
    L += ["", "| Experience level | Mean field accuracy |", "|---|---|"]
    L += [f"| {k} | {v['mean_field_accuracy']} |" for k, v in sorted(e["by_level"].items())]
    if e["failures"]:
        L += ["", f"Parse failures: {e['failures']}"]
    rc = r["recommendations"]["summary"]
    L += ["", "## Role recommendation relevance (hand labels)", "",
          f"hit@1 {rc['hit@1']} · hit@3 {rc['hit@3']} · precision@3 {rc['precision@3']} · nDCG@5 {rc['ndcg@5']} · "
          f"seniority within plausible range {rc['seniority_in_plausible_range']} (n={rc['n']})", "",
          "| Persona | Level | Relevant | Top-3 | Seniority (exp → est) |", "|---|---|---|---|---|"]
    for p in r["recommendations"]["per_persona"]:
        if "top3" in p:
            L.append(f"| {p['persona']} | {p['level']} | {', '.join(p['relevant'])} | {', '.join(p['top3'])} | {p['seniority_expected']} → {p['seniority_estimate']} |")
        else:
            L.append(f"| {p['persona']} | sparse | — | insufficient expected: returned={p['insufficient_returned']} | — |")
    j = r["jd_matching"]
    L += ["", "## Job requirement matching", "", f"Status accuracy {j['accuracy']} over {j['n']} labelled requirements.", "",
          "Confusion (expected → got): " + json.dumps(j["confusion"])]
    if j["misses"]:
        L += ["", "Misses:"] + [f"- {m['persona']}/{m['jd']}: “{m['requirement']}” expected {m['expected']}, got {m['got']}" for m in j["misses"]]
    g = r["grounding"]
    L += ["", "## Grounding verifier (unsupported-claim detection)", "",
          f"Recall on labelled unsupported claims: {g['claim_detection_recall']} ({g['labelled_claims']} claims). "
          f"Faithful rewrites falsely flagged: {g['faithful_rewrites_falsely_flagged']}/{g['faithful_rewrites']}.", ""]
    for d in g["details"]:
        if d["missed"] or (not d["labelled"] and d["flagged"]):
            L.append(f"- “{d['rewrite']}” — missed {d['missed']} · flagged {d['flagged']}")
    w = r["rewriting_provider"]
    L += ["", "## Unsupported claims introduced by the configured rewriting provider", "", "```", json.dumps(w, indent=1)[:1500], "```",
          "", "## Limits", "", r["meta"]["notice"],
          "Labels were written by the same developer who built the heuristics; dev-split numbers are optimistic by construction. "
          "Only the test split was held out from tuning."]
    return "\n".join(L) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="all", choices=["dev", "test", "all"])
    ap.add_argument("--embedding", default=None, choices=["tfidf", "sentence-transformers"])
    args = ap.parse_args()
    if args.embedding:
        os.environ["EMBEDDING_BACKEND"] = args.embedding
    os.environ.setdefault("DATABASE_URL", "sqlite://")
    from app.config import get_settings

    get_settings.cache_clear()
    from app.services.ml.embeddings import get_embedder
    from eval.synthetic import load

    data = load()
    ids = set(data["splits"]["dev"] + data["splits"]["test"]) if args.split == "all" else set(data["splits"][args.split])
    personas = [p for p in data["personas"] if p["id"] in ids]
    by_id = {p["id"]: p for p in data["personas"]}
    t0 = time.time()
    report = {
        "meta": {"split": args.split, "personas": len(personas), "embedding_model": get_embedder().name,
                 "llm_provider": get_settings().llm_provider, "dataset": data["version"], "labels_as_of": data.get("as_of"),
                 "generated_at": datetime.now(UTC).isoformat(timespec="seconds"), "notice": data["notice"]},
        "extraction": eval_extraction(personas),
        "recommendations": eval_recommendations(personas, data.get("as_of")),
        "jd_matching": eval_jd(by_id, ids, data.get("as_of")),
        "grounding": eval_grounding(by_id),
        "rewriting_provider": eval_rewriting_provider(personas),
    }
    report["meta"]["seconds"] = round(time.time() - t0, 1)
    out = ROOT / "eval" / "reports"
    out.mkdir(parents=True, exist_ok=True)
    stem = f"{datetime.now(UTC):%Y%m%d}_{report['meta']['embedding_model'].replace('/', '-').replace(':', '-')}_{args.split}"
    (out / f"{stem}.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    (out / f"{stem}.md").write_text(to_markdown(report), encoding="utf-8")
    print(to_markdown(report))
    print(f"\nWritten: {out / stem}.md/.json")


if __name__ == "__main__":
    main()
