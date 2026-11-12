"""Evaluation 3: skill extraction (taxonomy.find_skills) on SkillSpan (jjzha/skillspan, test split).

Matching rule (span overlap): a sentence is rebuilt by joining its tokens with single spaces so
every token has a character span. Gold spans are the BIO spans of `tags_skill` and
`tags_knowledge`. A predicted hit is correct if its character span overlaps any gold span in the
same sentence; a gold span is recalled if any predicted hit overlaps it.

"In taxonomy" subsets of the gold spans (what find_skills is designed to find):
  exact    — the normalised span equals a taxonomy name or alias
  contains — the normalised span contains a taxonomy name or alias as a whole-word substring
Normalisation: lower case, every character other than a-z 0-9 + # . / replaced by a space,
whitespace collapsed. These subsets are defined by plain string matching, not by find_skills.
"""

from __future__ import annotations

import json
import re
import statistics
from collections import Counter, defaultdict

from eval.real.common import DATA, bootstrap, r3


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9+#./]", " ", s.lower())).strip(" .")


def _spans(tags: list[str]) -> list[tuple[int, int]]:
    out, start = [], None
    for i, t in enumerate(tags + ["O"]):
        if t == "B" or t == "O":
            if start is not None:
                out.append((start, i))
                start = None
            if t == "B":
                start = i
        elif t == "I" and start is None:
            start = i
    return out


def load() -> list[dict]:
    rows = []
    with (DATA / "skillspan" / "test.json").open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    sents = []
    for r in rows:
        toks = r["tokens"]
        offs, pos = [], 0
        for t in toks:
            offs.append((pos, pos + len(t)))
            pos += len(t) + 1
        text = " ".join(toks)
        gold = []
        for kind in ("skill", "knowledge"):
            for a, b in _spans(r[f"tags_{kind}"]):
                gold.append({"kind": kind, "start": offs[a][0], "end": offs[b - 1][1], "text": " ".join(toks[a:b])})
        sents.append({"doc": f"{r['source']}:{r['idx']}", "source": r["source"], "text": text, "gold": gold})
    return sents


def evaluate() -> dict:
    from app.services.taxonomy import get_taxonomy

    tax = get_taxonomy()
    terms = sorted({_norm(t) for s in tax.skills.values() for t in (s.name, *s.aliases) if _norm(t)}, key=len, reverse=True)
    term_re = re.compile(r"(?<![a-z0-9+#])(" + "|".join(re.escape(t) for t in terms) + r")(?![a-z0-9+#])")
    term_set = set(terms)
    # baseline: canonical names only, case-insensitive, no aliases and no prose rules
    names = sorted({s.name for s in tax.skills.values()}, key=len, reverse=True)
    name_re = re.compile(r"(?<![A-Za-z0-9+#])(" + "|".join(re.escape(n) for n in names) + r")(?![A-Za-z0-9+#]|\.[A-Za-z0-9])", re.I)

    sents = load()
    for s in sents:
        for g in s["gold"]:
            n = _norm(g["text"])
            g["exact"] = n in term_set
            g["contains"] = bool(term_re.search(n))
        s["pred"] = [{"start": h.start, "end": h.end, "skill": h.skill, "text": h.matched} for h in tax.find_skills(s["text"])]
        s["pred_base"] = [{"start": m.start(1), "end": m.end(1), "skill": m.group(1), "text": m.group(1)} for m in name_re.finditer(s["text"])]

    def overlap(a, b):
        return a["start"] < b["end"] and b["start"] < a["end"]

    def score(rows, pred_key="pred", gold_filter=None, pred_gold_filter=None):
        tp_p = fp = 0
        rec = tot = 0
        for s in rows:
            golds = s["gold"]
            for p in s[pred_key]:
                pool = [g for g in golds if (pred_gold_filter is None or pred_gold_filter(g))]
                if any(overlap(p, g) for g in pool):
                    tp_p += 1
                else:
                    fp += 1
            for g in golds:
                if gold_filter and not gold_filter(g):
                    continue
                tot += 1
                rec += int(any(overlap(p, g) for p in s[pred_key]))
        p = tp_p / (tp_p + fp) if tp_p + fp else 0.0
        r = rec / tot if tot else 0.0
        return {"precision": r3(p), "recall": r3(r), "f1": r3(2 * p * r / (p + r) if p + r else 0.0),
                "n_pred": tp_p + fp, "n_gold": tot, "pred_correct": tp_p, "gold_recalled": rec}

    docs = defaultdict(list)
    for s in sents:
        docs[s["doc"]].append(s)
    groups = list(docs.values())

    def f1_of(gf):
        return lambda rs: score(rs, gold_filter=gf)["f1"]

    scopes = {
        "all_gold": None,
        "in_taxonomy_exact": lambda g: g["exact"],
        "in_taxonomy_contains": lambda g: g["contains"],
        "knowledge_spans_only": lambda g: g["kind"] == "knowledge",
        "skill_spans_only": lambda g: g["kind"] == "skill",
    }
    results = {}
    for name, gf in scopes.items():
        res = score(sents, gold_filter=gf)
        res["f1_ci95"] = bootstrap(f1_of(gf), groups, n=500)
        res["recall_ci95"] = bootstrap(lambda rs, gf=gf: score(rs, gold_filter=gf)["recall"], groups, n=500)
        results[name] = res
    results["precision_ci95"] = bootstrap(lambda rs: score(rs)["precision"], groups, n=500)
    # precision when only knowledge spans count as correct (stricter: soft "skill" spans do not)
    results["precision_vs_knowledge_spans_only"] = score(sents, pred_gold_filter=lambda g: g["kind"] == "knowledge")["precision"]
    by_source = {src: {k: score([s for s in sents if s["source"] == src], gold_filter=gf) for k, gf in
                       (("all_gold", None), ("in_taxonomy_exact", lambda g: g["exact"]))} for src in ("tech", "house")}
    baseline = {k: score(sents, pred_key="pred_base", gold_filter=gf) for k, gf in
                (("all_gold", None), ("in_taxonomy_exact", lambda g: g["exact"]), ("in_taxonomy_contains", lambda g: g["contains"]))}

    fp_counter, fn_counter, oot_counter, fp_examples, fn_examples = Counter(), Counter(), Counter(), [], []
    for s in sents:
        for p in s["pred"]:
            if not any(overlap(p, g) for g in s["gold"]):
                fp_counter[f"{p['skill']} ('{p['text']}')"] += 1
                if len(fp_examples) < 400:
                    fp_examples.append({"skill": p["skill"], "sentence": s["text"][:200]})
        for g in s["gold"]:
            hit = any(overlap(p, g) for p in s["pred"])
            if g["exact"] and not hit:
                fn_counter[g["text"]] += 1
                if len(fn_examples) < 200:
                    fn_examples.append({"gold": g["text"], "sentence": s["text"][:200]})
            if not g["contains"] and g["kind"] == "knowledge":
                oot_counter[_norm(g["text"])] += 1
    return {
        "dataset": "jjzha/skillspan (test split)", "n_sentences": len(sents), "n_documents": len(docs),
        "n_gold_spans": sum(len(s["gold"]) for s in sents),
        "gold_span_kinds": dict(Counter(g["kind"] for s in sents for g in s["gold"])),
        "share_gold_in_taxonomy_exact": r3(statistics.mean(g["exact"] for s in sents for g in s["gold"])),
        "share_gold_in_taxonomy_contains": r3(statistics.mean(g["contains"] for s in sents for g in s["gold"])),
        "share_knowledge_gold_in_taxonomy_contains": r3(statistics.mean(g["contains"] for s in sents for g in s["gold"] if g["kind"] == "knowledge")),
        "matching_rule": __doc__.split("Matching rule")[1].strip(),
        "find_skills": results, "by_source": by_source, "baseline_canonical_names_only": baseline,
        "bootstrap": "500 resamples of documents (cluster bootstrap)",
        "top_false_positives": fp_counter.most_common(15), "top_missed_in_taxonomy": fn_counter.most_common(15),
        "top_out_of_taxonomy_knowledge_spans": oot_counter.most_common(25),
        "fp_examples": fp_examples[:: max(1, len(fp_examples) // 12)][:12], "fn_examples": fn_examples[:: max(1, len(fn_examples) // 8)][:8],
    }
