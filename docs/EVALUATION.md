# Evaluation

## TL;DR

Three evaluation sets, all reproducible from `backend/`. Current results, synthetic vs real and before vs
after the 2026-11 changes, are in **[EVALUATION_REPORT_2026-11.md](EVALUATION_REPORT_2026-11.md)**.

| Set | Command | What it measures | Trust |
|---|---|---|---|
| Synthetic v1 (12 hand-written personas) | `python -m eval.run_eval --split all` | regression check of the original pipeline | low: same author wrote data, rules and labels |
| Synthetic v2 (108 generated resumes, 18 profiles incl. non-tech, 5 layouts, 36 JDs) | `python -m eval.run_eval_v2` | end to end from the PDF/DOCX file: parsing, skills, roles, seniority, JD parsing, requirement checks, ranking, score-band calibration, TF-IDF baseline | medium: optimistic upper bound |
| Real (public labelled datasets + live job postings) | `python -m eval.real.run_real` | resume–job fit, role recommendation, skill extraction (SkillSpan), live JD parsing with 30 hand-labelled postings, baselines, bootstrap CIs | best available, with dataset caveats |

Earlier versions of this page reported skill P/R 1.0 and role hit@1 1.0 from v1. Those numbers measured
skills-section strings only and used ground-truth rather than extracted content; they are kept below for
history and **must not** be quoted as accuracy. v2 measures extracted content, and the real set measures text
written by other people. The score bands (Strong 60+, Good 40+, Stretch 25+) are now checked by v2's
calibration table, which shows they need recalibration on real labels.

## Dataset (`backend/data/synthetic/personas_v1.json`)

- 12 fictional personas (student, junior, mid, senior, and one deliberately sparse resume) across
  data, ML, backend, frontend, full-stack, DevOps, QA, NLP and mobile backgrounds.
- Each persona is rendered in three layouts by `eval/synthetic.py`: **A** PDF with CAPS headings and
  "•" bullets; **B** PDF with "Heading:" style, "-" bullets and "Org — Title (dates)" lines; **C** DOCX
  with Word heading/list styles.
- Labels (relevant roles, seniority band, expected insufficient-evidence) were hand-assigned by the
  developer. Seniority labels are relative to `as_of = 2025-09`, which the harness pins.
- **Split:** `dev` (p01–p08) was used while building heuristics; `test` (p09–p12) was held out and run
  once per change. JD-matching labels (`eval/cases/jd_cases.json`) and grounding cases
  (`eval/cases/rewrite_cases.json`) are also hand-labelled.
- There is **no training data**: the system has no learned parameters beyond the pretrained embedding
  model. Taxonomy and thresholds were tuned on `dev` only.

## Historical v1 results (generated 2026-11-07; superseded, see the report above)

| Metric | dev (TF-IDF) | dev (MiniLM) | test (TF-IDF) | test (MiniLM) |
|---|---|---|---|---|
| Field extraction, mean over fields | ≈0.99 | ≈0.99 | ≈0.99 | ≈0.99 |
| `education.degree` exact | 0.875 | 0.875 | 0.750 | 0.750 |
| Skill extraction P / R | 1.0 / 1.0 | 1.0 / 1.0 | 1.0 / 1.0 | 1.0 / 1.0 |
| Role relevance hit@1 / hit@3 | 1.0 / 1.0 (n=7) | 1.0 / 1.0 | 1.0 / 1.0 (n=4) | 1.0 / 1.0 |
| Role relevance nDCG@5 | 0.995 | 0.995 | 0.980 | 0.969 |
| Seniority label within plausible range | 7/7 | 7/7 | 3/4 | 3/4 |
| Insufficient-evidence correctly returned | 1/1 | 1/1 | — | — |
| JD requirement status accuracy | 33/33 | 33/33 | 14/15 | 14/15 |
| Grounding: recall on labelled unsupported claims | 12/13 | | | |
| Grounding: faithful rewrites falsely flagged | 0/8 | | | |
| Unsupported claims introduced by provider | 0/30 (**fixture provider — rule-based, not a model**) | | | |

Remaining known misses (all reported, none tuned away on the test split):

- **Test, JD:** "Python" for p10 is `partial` (expected `matched`) — the persona shows PyTorch/Transformers
  but no bullet names Python, and the taxonomy does not treat PyTorch use as Python evidence.
- **Test, seniority:** p09 (≈6.7 years) is estimated `senior`; the hand label says `mid`.
- **Grounding:** a fabricated *year that exists elsewhere in the resume* is not detected (presence-based check).
- **Degree field:** the extractor keeps the full degree string ("B.Tech in Information Technology"); exact
  match fails for some layouts where the line also contains the institution.

### Why these numbers are optimistic

1. The same developer wrote the renderer, the parser and the labels; layouts are clean, single-column and text-based.
2. Real resumes have multi-column layouts, tables, text boxes, icons, unusual headings, non-English
   content, OCR noise and inconsistent dates — none of which are well represented here.
3. Role labels reflect one person's judgement; real role fit is contested and context-dependent.
4. With n=4 test personas, a single error moves metrics by 25 points; no confidence intervals are meaningful.
5. The fixture provider cannot hallucinate; measuring a real model requires setting `LLM_PROVIDER` and rerunning.

## Protocol for consented, representative real data

1. **Consent & governance:** obtain explicit opt-in (separate from product terms) for evaluation use;
   record consent version; allow withdrawal. Store the evaluation corpus separately from production data
   with restricted access; never use it for training without a separate consent.
2. **De-identification:** remove names, contact details and photos before annotation; keep a re-identification
   key only if needed for withdrawal, held by a different custodian.
3. **Sampling:** stratify by experience level, field, region/language, document type (PDF/DOCX/scanned),
   layout (single/multi-column, tables) and source tool (Word, LaTeX, Canva, Google Docs). Target ≥ 300
   resumes for extraction metrics with per-stratum n ≥ 30.
4. **Annotation:** two independent annotators per document using the `ResumeContent` schema; adjudicate
   disagreements; report inter-annotator agreement (Cohen's κ for categorical fields, exact match for spans).
   For roles, collect graded relevance (0–3) from at least two practitioners per role family.
5. **Splits:** freeze a test set before any tuning; tune only on dev; report test once per release.
6. **Metrics:** field-level exact/fuzzy accuracy with bootstrap 95% CIs; skill P/R/F1 (micro and per category);
   nDCG@5 and hit@3 for roles; requirement-status accuracy and confusion matrix for JD matching; for
   rewriting, the share of AI suggestions with unsupported claims (verifier + human audit of a sample) and
   verifier precision/recall against human labels.
7. **Subgroup analysis:** report all metrics per stratum. Where users volunteer demographic data under
   consent (never inferred), check for disparities in extraction quality and ranking — e.g. that equal
   evidence yields equal fit scores across groups.
8. **Report** with dataset card, annotation guidelines, limitations and the exact versions
   (`parser`, `extractor`, `rubric`, `taxonomy`, `embedding_model`, `recommender`, `prompt`).

## What data would improve the models

- **Supervised extraction** (e.g. a layout-aware token classifier) needs a few thousand annotated resumes
  across layouts; until then the rule-based extractor with explicit uncertainty flags is preferable.
- **A learned role ranker** needs graded relevance judgements (ideally outcome-free, to avoid encoding
  historical hiring bias) for several thousand resume–role pairs. Hiring outcomes should *not* be used as
  labels without a bias audit.
- **Seniority calibration** needs resumes with practitioner-assigned levels across industries/regions.
- **Requirement matching** would benefit from labelled JD–resume requirement pairs to calibrate the
  semantic threshold used for `other` requirements (currently 0.55, a heuristic).
