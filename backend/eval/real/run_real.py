"""Evaluation on REAL public data (see docs/EVALUATION.md for the synthetic harness).

    python -m eval.real.fetch          # once: download datasets + today's job postings into var/eval_data/
    python -m eval.real.run_real [--only fit,recommend,skills,jobs] [--fit-pairs 1000]

Writes eval/reports/<YYYYMMDD>_real.{md,json}. Raw data stays in var/eval_data/ (gitignored); the
report contains aggregate numbers, job titles and skill names only — no resume text.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

DATASETS = [
    {"name": "cnamuangtoun/resume-job-description-fit", "url": "https://huggingface.co/datasets/cnamuangtoun/resume-job-description-fit",
     "files": "test.csv (train.csv downloaded, unused)", "license": "not stated (no dataset card / README; HF metadata has no license tag)",
     "rows": "train 6,241 / test 1,759 pairs; test has 477 unique resumes and 71 unique job descriptions",
     "card_notes": "No dataset card: label provenance, annotation process and whether resumes/JDs are real or generated are undocumented."},
    {"name": "ahmedheakl/resume-atlas", "url": "https://huggingface.co/datasets/ahmedheakl/resume-atlas", "files": "train split (parquet conversion)",
     "license": "MIT (dataset card)", "rows": "13,389 resumes, 43 categories",
     "card_notes": "Card points to arXiv 2406.18125 and github.com/noran-mohamed/Resume-Classification-Dataset; text is pre-processed "
                   "(lower-cased, punctuation and stop words removed, one line). Many entries are resume-builder sample templates "
                   "(e.g. recurring placeholder names/addresses), so not all are real people's resumes."},
    {"name": "jjzha/skillspan", "url": "https://huggingface.co/datasets/jjzha/skillspan", "files": "test.json",
     "license": "CC-BY-4.0 (dataset card)", "rows": "test 3,569 sentences (65 postings); train 4,800 / dev 3,174 sentences",
     "card_notes": "Zhang et al., NAACL 2022. Human-annotated job postings from StackOverflow ('tech') and a large job platform ('house'); "
                   "entities partly masked (<ORGANIZATION>, <ADDRESS>). Tokenisation splits '.NET' into '. NET'."},
    {"name": "Live job postings", "url": "https://remotive.com/api/remote-jobs, https://www.arbeitnow.com/api/job-board-api, https://remoteok.com/api",
     "license": "Public APIs without keys; each provider's terms apply (RemoteOK asks for attribution/link-back). Snapshot used for evaluation only, not redistributed.",
     "rows": "see jobs section", "card_notes": "Fetched on the run date; RemoteOK text arrives mojibake-encoded and is repaired before use."},
]


def _fmt_ci(ci) -> str:
    return f"[{ci[0]}, {ci[1]}]" if ci and ci[0] is not None else "n/a"


def to_markdown(r: dict) -> str:
    m = r["meta"]
    L = [f"# Real-data evaluation — {m['date']}", "",
         "> Public datasets and live postings, measured without tuning. Numbers describe these datasets, which differ from "
         "real user uploads (see Limits). 95% CIs are percentile bootstrap.", "",
         "| Setting | Value |", "|---|---|"]
    for k, v in m.items():
        L.append(f"| {k} | {v} |")
    L += ["", "## Datasets", "", "| Dataset | URL | License | Rows used / available | Notes |", "|---|---|---|---|---|"]
    for d in DATASETS:
        L.append(f"| {d['name']} | {d['url']} | {d['license']} | {d['rows']} | {d['card_notes']} |")

    if "fit" in r:
        f = r["fit"]
        L += ["", "## 1. Resume–JD fit (match score as a classifier)", "",
              f"n = {f['n_pairs']} pairs ({f['label_counts']}), {f['n_unique_resumes']} resumes, {f['n_unique_jds']} JDs. "
              f"Split: {f['split']['rule']} — dev {f['split']['dev_pairs']} pairs / held-out {f['split']['heldout_pairs']} pairs. "
              f"CIs: {f['bootstrap']}.", "",
              "### Ranking (all pairs)", "", "| Score | AUC Good vs No (95% CI) | AUC Fit-any vs No (95% CI) | Spearman vs ordinal label (95% CI) |", "|---|---|---|---|"]
        names = {"system": "**System match score** (`overall`)", "system_lenient": "System, lenient content (diagnostic)",
                 "tfidf_cosine": "Baseline: TF-IDF cosine", "embedding_cosine": f"Baseline: raw {m['embedding_model']} cosine",
                 "c_requirement": "Component: requirement coverage", "c_keyword": "Component: keyword coverage", "c_semantic": "Component: semantic alignment"}
        for k, v in f["ranking_all_pairs"].items():
            L.append(f"| {names[k]} | {v['auc_good_vs_no']} {_fmt_ci(v['auc_good_vs_no_ci95'])} | {v['auc_fit_vs_no']} {_fmt_ci(v['auc_fit_vs_no_ci95'])} | "
                     f"{v['spearman']} {_fmt_ci(v['spearman_ci95'])} |")
        L += ["", "### Classification on the held-out half (threshold chosen on dev to maximise F1 for Fit-any)", "",
              "| Score | Threshold | Accuracy (95% CI) | Precision | Recall | F1 (95% CI) | 3-class accuracy | 3-class macro-F1 |", "|---|---|---|---|---|---|---|---|"]
        for k, v in f["classification_heldout"].items():
            t = v["three_class"]
            L.append(f"| {names[k]} | {v['threshold_from_dev']} | {v['accuracy']} {_fmt_ci(v['accuracy_ci95'])} | {v['precision']} | {v['recall']} | "
                     f"{v['f1']} {_fmt_ci(v['f1_ci95'])} | {t['accuracy']} | {t['macro_f1']} |")
        mj = f["majority_baseline_heldout"]
        L.append(f"| Baseline: majority class ({mj['majority_class_from_dev']}) | — | {mj['binary_accuracy']} | — | 0 | {mj['binary_f1_fit']} | "
                 f"{mj['three_class_accuracy']} | {mj['three_class_macro_f1']} |")
        conf = f["classification_heldout"]["system"]["three_class"]["confusion_rows_true_cols_pred"]
        L += ["", "System 3-class confusion on held-out (rows = true, cols = predicted; thresholds "
              f"{f['classification_heldout']['system']['three_class']['thresholds_from_dev']} from dev):", "",
              "| true \\ pred | No Fit | Potential Fit | Good Fit |", "|---|---|---|---|"]
        for a, row in conf.items():
            L.append(f"| {a} | {row['No Fit']} | {row['Potential Fit']} | {row['Good Fit']} |")
        L += ["", f"Mean score by label: `{json.dumps(f['mean_score_by_label'])}`", "",
              f"**Resume extraction on this dataset's text** (n={f['resume_extraction']['n_resumes']}): `{json.dumps(f['resume_extraction'])}`", "",
              f"JD extraction (n={f['jd_extraction']['n']}): `{json.dumps(f['jd_extraction'])}`", "",
              f"Requirement statuses over all pairs: `{json.dumps(f['requirement_status_counts_over_pairs'])}`", "",
              f"Extracted content failing its own schema: {f['extracted_content_failing_schema']['n_resumes']} of "
              f"{f['extracted_content_failing_schema']['of']} resumes, fields `{json.dumps(f['extracted_content_failing_schema']['fields'])}` "
              "(truncated to the schema limit before matching; see Bugs).", "",
              "Highest-scored *No Fit* pairs: " + "; ".join(f"“{(x['jd_title'] or 'no title')[:60]}” {x['score']}" for x in f["highest_scored_no_fit"]), "",
              "Lowest-scored *Good Fit* pairs: " + "; ".join(f"“{(x['jd_title'] or 'no title')[:60]}” {x['score']}" for x in f["lowest_scored_good_fit"]), "",
              f"Runtime: extraction {f['seconds_extract']} s, matching {f['seconds_match']} s. Errors: {len(f['errors'])}."]

    if "recommend" in r:
        c = r["recommend"]
        L += ["", "## 2. Resume category → role recommendation", "",
              f"n = {c['n_in_scope']} in-scope resumes ({c['sampling']}); {c['n_out_of_scope']} out-of-scope controls.", "",
              "Category → relevant role ids (only clear mappings; binary relevance):", "", "| Dataset category | Relevant role ids |", "|---|---|"]
        for k, v in c["mapping"].items():
            L.append(f"| {k} | {', '.join(v)} |")
        L += ["", f"Not mapped (no clear counterpart): {', '.join(c['not_mapped_technical'])}. Out-of-scope controls: {', '.join(c['out_of_scope_controls'])}.", "",
              "| Variant | n | Insufficient evidence | hit@1 (95% CI) | hit@3 (95% CI) | nDCG@5 (95% CI) | hit@1 / hit@3 ignoring the gate |", "|---|---|---|---|---|---|---|"]
        vn = {"pipeline": "**System: extract → recommend**", "lenient": "System recommend on lenient content (diagnostic)", "tfidf": "Baseline: TF-IDF resume vs role profile"}
        for v, o in c["overall"].items():
            ci = c["ci95"]
            L.append(f"| {vn[v]} | {o['n']} | {o['insufficient_evidence_rate']} | {o['hit@1']} {_fmt_ci(ci[v + '.hit@1'])} | {o['hit@3']} {_fmt_ci(ci[v + '.hit@3'])} | "
                     f"{o['ndcg@5']} {_fmt_ci(ci[v + '.ndcg@5'])} | {o['ungated_hit@1']} / {o['ungated_hit@3']} |")
        rb = c["random_baseline"]
        L.append(f"| Baseline: random ranking (expected) | — | — | {rb['hit@1']} | {rb['hit@3']} | — | — |")
        L += ["", "Insufficient-evidence results count as misses in hit@k/nDCG@5; the last column ranks the tentative top-3 anyway.", "",
              "### Per category", "", "| Category | n | System insufficient | System (lenient) hit@1 / hit@3 / nDCG@5 | TF-IDF hit@1 / hit@3 | Most common wrong top-1 (lenient) |", "|---|---|---|---|---|---|"]
        for cat, v in c["per_category"].items():
            p, le, tf = v["pipeline"], v["lenient"], v["tfidf"]
            L.append(f"| {cat} | {p['n']} | {p['insufficient_evidence_rate']} | {le['hit@1']} / {le['hit@3']} / {le['ndcg@5']} | {tf['hit@1']} / {tf['hit@3']} | "
                     f"{', '.join(f'{a} ({b})' for a, b in c['top1_confusions_lenient'][cat])} |")
        L += ["", "### Out-of-scope control (non-technical categories)", "", "| Variant | mean top fit, in-scope | mean top fit, out-of-scope | AUC (top fit separates in vs out) | insufficient rate, out-of-scope | top-1 for out-of-scope |", "|---|---|---|---|---|---|"]
        for v, s in c["scope_control"].items():
            L.append(f"| {vn[v]} | {s['mean_top_fit_in_scope']} | {s['mean_top_fit_out_of_scope']} | {s['auc_top_fit_in_vs_out']} | {s['insufficient_rate_out_of_scope']} | "
                     f"{json.dumps(s['out_of_scope_top1_counts'])} |")
        L += ["", f"Runtime {c['seconds']} s. Errors: {c['n_errors']}. Pipeline content needing schema repair: {c['pipeline_content_schema_repairs']}."]

    if "skills" in r:
        s = r["skills"]
        fs = s["find_skills"]
        L += ["", "## 3. Skill extraction (`find_skills`) on SkillSpan", "",
              f"n = {s['n_sentences']} sentences / {s['n_documents']} postings, {s['n_gold_spans']} gold spans {s['gold_span_kinds']}. "
              f"Gold spans in taxonomy: {s['share_gold_in_taxonomy_exact']} exact, {s['share_gold_in_taxonomy_contains']} contains "
              f"({s['share_knowledge_gold_in_taxonomy_contains']} of knowledge spans). CIs: {s['bootstrap']}.", "",
              f"**Matching rule.** {s['matching_rule']}", "",
              f"Precision (any gold span): **{fs['all_gold']['precision']}** {_fmt_ci(fs['precision_ci95'])} over {fs['all_gold']['n_pred']} predictions; "
              f"counting only knowledge spans as correct: {fs['precision_vs_knowledge_spans_only']}.", "",
              "| Gold scope | n gold | Recall (95% CI) | F1 (95% CI) |", "|---|---|---|---|"]
        for k in ("in_taxonomy_exact", "in_taxonomy_contains", "all_gold", "knowledge_spans_only", "skill_spans_only"):
            v = fs[k]
            L.append(f"| {k} | {v['n_gold']} | {v['recall']} {_fmt_ci(v['recall_ci95'])} | {v['f1']} {_fmt_ci(v['f1_ci95'])} |")
        b = s["baseline_canonical_names_only"]
        L += ["", "| Baseline: canonical names only (case-insensitive, no aliases/prose rules) | P | R | F1 |", "|---|---|---|---|"]
        for k, v in b.items():
            L.append(f"| {k} | {v['precision']} | {v['recall']} | {v['f1']} |")
        L += ["", "| Source | P | R (all gold) | R (in taxonomy, exact) |", "|---|---|---|---|"]
        for src, v in s["by_source"].items():
            L.append(f"| {src} | {v['all_gold']['precision']} | {v['all_gold']['recall']} (n={v['all_gold']['n_gold']}) | "
                     f"{v['in_taxonomy_exact']['recall']} (n={v['in_taxonomy_exact']['n_gold']}) |")
        L += ["", f"Top unmatched predictions: {s['top_false_positives']}", "", f"Missed in-taxonomy gold: {s['top_missed_in_taxonomy']}", "",
              f"Most frequent out-of-taxonomy knowledge spans (coverage gaps): {s['top_out_of_taxonomy_knowledge_spans']}"]

    if "jobs" in r:
        j = r["jobs"]
        a = j["summary"]["all"]
        L += ["", "## 4. Live job postings → `extract_jd`", "",
              f"Fetched {j['fetched_at']}: {j['n_postings_fetched']} postings; evaluated n = {j['n_evaluated']} "
              f"(all Remotive and RemoteOK postings, Arbeitnow sampled to fill). Fetch errors: {j['fetch_errors'] or 'none'}. "
              f"Parse errors: {len(j['parse_errors'])}. Runtime {j['runtime_seconds_total']} s total, mean {j['runtime_ms_per_posting_mean']} ms, "
              f"p95 {j['runtime_ms_per_posting_p95']} ms per posting.", "",
              "| Subset | n | title found | API title appears in text | extracted = API title, when it appears | title shares a word with API title | ≥1 requirement | structured requirements | skill-fallback only | mean / median requirements | years extracted | degree extracted | zero taxonomy skills |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for k, v in j["summary"].items():
            if not v.get("n"):
                continue
            L.append(f"| {k} | {v['n']} | {v['share_title_found']} | {v['share_api_title_appears_in_text']} | {v['share_title_equals_api_title_when_in_text']} | {v['share_title_shares_a_word_with_api_title']} | {v['share_ge1_requirement']} | "
                     f"{v['share_structured_requirements']} | {v['share_skill_fallback_only']} | {v['mean_requirements']} / {v['median_requirements']} | "
                     f"{v['share_years_extracted']} | {v['share_degree_extracted']} | {v['share_zero_taxonomy_skills']} |")
        L += ["", f"95% CIs (all): title found {_fmt_ci(a['share_title_found_ci95'])}, ≥1 requirement {_fmt_ci(a['share_ge1_requirement_ci95'])}, "
              f"years {_fmt_ci(a['share_years_extracted_ci95'])}, degree {_fmt_ci(a['share_degree_extracted_ci95'])}.", "",
              f"Requirement kinds: `{json.dumps(j['requirement_kinds'])}`", "",
              "Extracted title vs API title (English postings, no shared word): " + "; ".join(f"“{x['api_title']}” → “{x['extracted']}”" for x in j["examples_title_mismatch"][:8])]
        h = j["hand_labelled"]
        if h.get("n_postings"):
            L += ["", "### Hand-labelled sample — **labelled by an AI assistant, single annotator**", "",
                  f"{h['annotator_note']} n = {h['n_postings']} postings (random among postings passing a coarse not-German filter; "
                  "5 of them turned out to be French or Dutch), "
                  f"{h['gold_skill_mentions']} gold skills, of which {h['gold_in_taxonomy']} map to the taxonomy. Guidelines are in `eval/real/job_labels.json`.", "",
                  "| Predicted skills | Gold scope | P | R | F1 (95% CI) |", "|---|---|---|---|---|"]
            for key, lab in (("requirement_skills_vs_gold_in_taxonomy", "requirement skills / gold in taxonomy"),
                             ("requirement_skills_vs_all_gold", "requirement skills / all gold")):
                v = h[key]
                L.append(f"| {lab.split(' / ')[0]} | {lab.split(' / ')[1]} | {v['precision']} | {v['recall']} | {v['f1']} {_fmt_ci(v['f1_ci95'])} |")
            for key, lab in (("all_mentioned_skills_vs_gold_in_taxonomy", "all mentioned skills / gold in taxonomy"),
                             ("all_mentioned_skills_vs_all_gold", "all mentioned skills / all gold")):
                v = h[key]
                L.append(f"| {lab.split(' / ')[0]} | {lab.split(' / ')[1]} | {v['precision']} | {v['recall']} | {v['f1']} |")
            L += ["", f"Minimum years: accuracy **{h['years_accuracy']}** {_fmt_ci(h['years_accuracy_ci95'])} (n={h['years_n']}; "
                  f"{h['years_with_gold_stated']} postings state a number). Errors: "
                  + "; ".join(f"{e['key'].split(':')[0]} gold {e['gold']} → {e['pred']}" for e in h["years_errors"])]
    L += ["", "## Failure patterns (observed in this run)", ""] + [f"- {x}" for x in r["patterns"]]
    L += ["", "## Bugs found", ""] + [f"- {b}" for b in r["bugs"]]
    L += ["", "## Limits", ""] + [f"- {x}" for x in r["limits"]]
    return "\n".join(L) + "\n"


BUGS = [
    "**`extract()` returns content that fails `ResumeContent` validation.** The extractor assigns fields without validation, so an "
    "education line longer than 160 characters becomes `degree`/`field_of_study` > 160 chars. Any later `ResumeContent.model_validate` "
    "on that content raises (`PUT /resumes/{id}/review` with the unchanged extraction → 422; `openings.candidate_facts` after "
    "`parse_uploaded_resume` → unhandled ValidationError). Repro: `extract(t, [{'page':1,'char_start':0,'char_end':len(t)}])` with "
    "`t = 'Jane Doe\\nEDUCATION\\nBachelor of Science in Computer Science with a minor in mathematics where I completed coursework in "
    "algorithms, operating systems, databases, networking, compilers and graphics, University of Somewhere\\n'`, then "
    "`ResumeContent.model_validate(content)` → `string_too_long` on education.0.degree / field_of_study.",
]


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="fit,recommend,skills,jobs")
    ap.add_argument("--fit-pairs", type=int, default=1000)
    args = ap.parse_args()
    os.environ.setdefault("DATABASE_URL", "sqlite://")
    from app.config import get_settings

    get_settings.cache_clear()
    from app.services.ml.embeddings import get_embedder
    from app.services.taxonomy import get_taxonomy
    from app.versions import EXTRACTOR_VERSION, JD_MATCHER_VERSION, RECOMMENDER_VERSION

    only = set(args.only.split(","))
    t0 = time.time()
    report: dict = {"meta": {
        "date": f"{datetime.now():%Y-%m-%d}", "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "embedding_model": get_embedder().name, "embedding_backend_setting": get_settings().embedding_backend,
        "extractor_version": EXTRACTOR_VERSION, "jd_matcher_version": JD_MATCHER_VERSION, "recommender_version": RECOMMENDER_VERSION,
        "taxonomy_version": get_taxonomy().version, "seed": 20261110}}
    if "skills" in only:
        from eval.real import skills
        report["skills"] = skills.evaluate()
        print("skills done", round(time.time() - t0))
    if "jobs" in only:
        from eval.real import jobs
        report["jobs"] = jobs.evaluate()
        print("jobs done", round(time.time() - t0))
    if "recommend" in only:
        from eval.real import recommend
        report["recommend"] = recommend.evaluate()
        print("recommend done", round(time.time() - t0))
    if "fit" in only:
        from eval.real import fit
        report["fit"] = fit.evaluate(args.fit_pairs)
        print("fit done", round(time.time() - t0))
    report["meta"]["seconds"] = round(time.time() - t0, 1)
    report["bugs"] = BUGS
    report["patterns"] = PATTERNS
    report["limits"] = LIMITS
    out = ROOT / "eval" / "reports"
    out.mkdir(parents=True, exist_ok=True)
    stem = f"{datetime.now():%Y%m%d}_real"  # local date
    (out / f"{stem}.json").write_text(json.dumps(report, indent=1, default=str, ensure_ascii=False), encoding="utf-8")
    (out / f"{stem}.md").write_text(to_markdown(report), encoding="utf-8")
    print(f"Written: {out / stem}.md/.json")


PATTERNS = [
    "**Extraction needs line structure.** On both resume datasets the extractor finds 0 experience entries and 0 recognised skills for "
    "almost every resume (headings glued to text, or one lower-cased line), so `match` marks nearly every requirement missing/unknown "
    "and `recommend` returns insufficient evidence for 100% of resume-atlas inputs, in-scope and out-of-scope alike.",
    "**Fit score does not track the fit labels.** With empty extraction the score is 60% requirement coverage (≈0) + 20% keyword coverage (0) + "
    "20% semantic; mean score is ≈9 for every label. Plain TF-IDF cosine is slightly better but still weak, so the labels themselves are hard to "
    "predict from text similarity.",
    "**JD section headings with a leading word are not recognised** (`_section_of` needs the heading to start with a known word): "
    "'Job Requirements', 'Candidate Qualifications', 'YOUR EXPERIENCE', 'What you bring', 'About You' all return None. Requirements "
    "under them become responsibilities (Aprio tax manager, Akicita account manager) or the whole posting falls back to one requirement per "
    "skill (NTS lead engineer, Redwood principal engineer), and the years requirement is lost.",
    "**Years: minimum across all experience lines.** `years_required` takes the minimum of every experience requirement, so skill-specific "
    "or secondary lines win: '5+ years Golang … 1+ year AI-assisted coding' → 1; '10+ years customer-facing … at least 5 years lodging' → 5; "
    "'Client onboarding experience within the last three years' (nice-to-have) → 3. Phrases without 'experience' ('12+ years building software') "
    "are classified as `other`, not experience.",
    "**Title = first short line.** Extracted titles are often a section heading or sentence: 'About the Role', 'How it works', "
    "'Our Technology Stack', '5+ years of commercial experience with Python'. Many postings never state the title in the body.",
    "**Non-English postings.** German postings: 53% have zero taxonomy skills, 0% years extracted, median 2 requirements.",
    "**Soft-skill aliases fire on perks/company prose** (SkillSpan and postings): 'mentoring programs & trainings' (a benefit) → Leadership; "
    "'teamwork' in a culture blurb → Collaboration; 'experimentation' → A/B Testing; 'agile feature team' → Agile.",
    "**Recruiter-page boilerplate becomes requirements**: a Lemon.io posting lists ~60 stacks under 'NOT YOUR TECH STACK?', producing 20 "
    "false-positive requirement skills (Swift, iOS, Vue.js, React Native, …).",
    "**Alias collapses**: 'Flutter' → React Native, 'Cypress' → Playwright, 'Jira' → Agile, 'Datadog' → Monitoring; on SkillSpan, "
    "'amazon-web-services' and tokenised '. NET' are missed.",
    "**Role ranking (diagnostic, lenient content)** is below a plain TF-IDF profile baseline overall; Testing resumes are ranked as data roles, "
    "Data Science resumes as data_analyst, DotNet resumes as frontend_developer. Out-of-scope resumes (accountants, HR, sales) most often get "
    "data_analyst as top role, though their fit scores are much lower (AUC in-vs-out 0.93).",
]


LIMITS = [
    "**Label noise / provenance (fit).** `resume-job-description-fit` has no dataset card: who assigned No/Potential/Good Fit, how, "
    "and whether resumes or JDs were generated by a language model are undocumented. Its JDs are few (71 in test) and reused across many pairs, "
    "so CIs use a JD-level cluster bootstrap; they are wide for that reason. Treat AUCs as agreement with these labels, not with hiring decisions.",
    "**Input format (fit, atlas).** Both resume datasets are plain text that lost its layout: the fit set glues headings to content "
    "(\"Summary7+ years…\", \"SkillsData/Business…\"), and resume-atlas is lower-cased, punctuation-free and on a single line. The extractor "
    "relies on headings on their own lines, so on these datasets it extracts almost nothing; the system numbers therefore measure mostly the "
    "semantic component and the insufficient-evidence gate. Real uploads go through the PDF/DOCX parser, which keeps line structure — these "
    "results do not transfer to them in either direction. The 'lenient content' rows are a diagnostic that bypasses extraction; they are not product behaviour.",
    "**Category labels (atlas).** A category is a coarse proxy for the right role (a 'Python Developer' may be a data engineer). Only "
    "clear mappings were used and relevance is binary. resume-atlas merges several public resume collections, and a visible share of entries "
    "are resume-builder sample templates (recurring placeholder names and addresses), i.e. not real job seekers; some may be machine-generated. "
    "The dataset card does not say.",
    "**SkillSpan.** Annotations follow the SkillSpan guidelines (skills are often long verb phrases; knowledge spans are nouns), not this "
    "product's notion of a skill, so recall against all gold spans measures coverage, not correctness. Annotators did not tag every technology "
    "mention (e.g. job titles), so precision is a lower bound: in a spot check of 12 unmatched predictions, about 8 were genuine technology "
    "mentions in the text. Postings are 2016–2021-era and partly masked; '.NET' is tokenised as '. NET', which the matcher cannot see.",
    "**Live postings.** A one-day snapshot of three remote/EU job boards (Arbeitnow is mostly German-language and Germany/EU-based); not "
    "representative of any labour market. The 30-posting sample was labelled by an AI assistant as a single annotator, without adjudication "
    "or agreement measurement; 5 of the 30 are French or Dutch because the language filter used to draw the sample only excluded German. "
    "Gold skills include many items outside the 110-skill taxonomy by design (coverage).",
    "**No tuning.** Nothing under `backend/app` was changed for this report; thresholds for the classification rows were fitted on the dev half only. "
    "The default embedding backend was used (see meta).",
]


if __name__ == "__main__":
    main()
