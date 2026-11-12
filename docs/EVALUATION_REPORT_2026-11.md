# Model evaluation: synthetic vs real data, before and after (November 2026)

**Bottom line.** The 2026-11 improvements made the system much better on real-world text. Real resumes
that lost their layout now get their jobs extracted (0% → 99%), the right role is ranked first far more
often (40% → 68%), and live job ads are read much better (required-skill F1 0.75 → 0.83, years 0.57 → 0.83).
On clean synthetic data the system was already near-perfect and stays there. The one real-data number
that is still weak is the resume–job **fit score** on the public fit dataset (AUC 0.53), and a model trained
on that dataset's own 6,241 examples only reaches 0.61, so most of that gap is in the labels, not the matcher.

*Old* = `main` at the start of the round (extractor-1.1.0, jd-matcher-1.2.0). *New* = extractor-1.2.0,
jd-matcher-1.3.0, recommender-1.2.0. Embeddings `all-MiniLM-L6-v2` on CPU. Square brackets: 95% bootstrap CI.
Reproduce from `backend/`: `python -m eval.run_eval_v2` (synthetic), `python -m eval.real.run_real` (real).
Reports: `backend/eval/reports/20261109_*` and `20261110_real.*` (old), `20261110_synthetic_v2_*` and `20261112_real.*` (new).

## 1. Datasets

| | Synthetic v2 | Real |
|---|---|---|
| Resumes | 108 generated (18 job profiles incl. 6 non-tech), 5 layouts, PDF + DOCX | 1,000 labelled resume–job pairs ([resume-job-description-fit](https://huggingface.co/datasets/cnamuangtoun/resume-job-description-fit), licence not stated); 1,320 categorised resumes ([resume-atlas](https://huggingface.co/datasets/ahmedheakl/resume-atlas), MIT) |
| Job descriptions | 36 generated, 3 styles (bulleted, inline, prose) | 711 live postings from Remotive, Arbeitnow, RemoteOK (250 evaluated, 30 hand-labelled) |
| Skills | generator labels | [SkillSpan](https://huggingface.co/datasets/jjzha/skillspan) (CC-BY-4.0) + the 30 hand-labelled postings |
| Caveat | templated, uses the taxonomy's skill names → optimistic | resume text has lost its layout; fit labels undocumented; test resumes also appear in its train split; hand labels by one AI annotator |

## 2. Side by side: synthetic vs real, old vs new

| Metric | Synthetic old | Synthetic **new** | Real old | Real **new** |
|---|---|---|---|---|
| **Skill recognition F1** | 0.986 | **0.998** | 0.826 (SkillSpan) | **0.825** [0.78, 0.87] |
| Resume parsing: jobs extracted | 100% | 100% | 0% | **99%** |
| Job title / employer correct | 0.966 | **1.00** | — | — |
| Degree correct | 0.889 | **1.00** | — | 88% have education extracted (was 0.5%) |
| **Correct role ranked first** (accuracy) | 1.00 | 0.986 | 0.40 | **0.68** |
| Correct role in top 3 | 1.00 | 1.00 | 0.50 | **0.87** |
| Tech vs non-tech separated (AUC) | 1.00 | 1.00 | 0.50 | **0.93** |
| Seniority band accuracy | 0.954 | 0.954 | — | — |
| **Job ad: required-skill F1** | 0.868 | **0.997** | 0.751 | **0.830** (P 0.88, R 0.79) |
| Job ad: preferred-skill F1 | 0.773 | **1.00** | — | — |
| **Job ad: years accuracy** | 0.667 | **1.00** | 0.567 | **0.833** |
| Job ads with ≥1 requirement found | 100% | 100% | 87.2% | **90.4%** |
| Job ad title correct | 1.00 | 1.00 | 12% | 14% |
| Requirement-check accuracy | 0.994 | 0.996 | — | — |
| **Fit score: good vs bad pairs (AUC)** | 0.999 | **1.00** | 0.504 | **0.531** (TF-IDF baseline 0.574) |
| Fit: 3-class accuracy (held-out) | — | — | 0.32 | **0.41** (majority class 0.52) |
| Candidate ranking per job (nDCG@10) | 0.975 | **0.978** | — | — |

Real role numbers are "ungated": on the one-line resume-atlas text the product still answers
"insufficient evidence" (no bullets to verify), which is the honest product behaviour; the table shows how
the ranking would score.

## 3. What the numbers say

**Good on both datasets**
- Recognising the 110 skills in the taxonomy (F1 0.83 real, 0.998 synthetic).
- Ranking the right role first for real resumes (68%) and separating tech from non-tech resumes (AUC 0.93).
- Reading live job ads: required skills (F1 0.83, precision 0.88) and the years requirement (83%).

**Still weak on real data**
- **Fit score on the public fit dataset (AUC 0.53).** A logistic-regression model trained on that dataset's own
  6,241 labelled pairs reaches only 0.61; the labels barely follow from the text, and 1,758 of the 1,759 test
  resumes also appear in its training split. We did not tune to it. A trustworthy number needs consented resumes
  with recruiter judgements.
- **Job-ad titles (14%)** and non-English ads (German: almost no skills found).
- **Skills outside the taxonomy** (recall over all annotated skills 0.19): "customer onboarding", "GAAP" etc.
  are not in the 110-skill list.

**Honesty notes**
- Synthetic gains are partly "fixed what we saw": the synthetic set was used to find failure patterns. Fixes are
  general rules, and the real data was the check.
- Two live-ad failures (out of 30 hand-labelled ads) were inspected to find the "about section swallows the
  posting" and "duties-only posting" patterns; the fixes are general, but those 30 ads are no longer fully unseen.
- Score bands: on synthetic data the "Good match" band (40–59) contains 55% unrelated pairs and 0% same-role
  pairs, while "Strong" (60+) is 68% same-role and 4% unrelated. The bands need recalibration on real labels.

## 4. What changed in the model (2026-11)

1. Structure recovery for flattened resumes (glued headings, run-on sentences, dates inline), with evidence still
   pointing at the original text; text with no sections keeps its skills as "mentioned", never "shown in work".
2. Job-description parsing: wider headings, boilerplate sections skipped, headline years = main requirement,
   recency windows ignored, better titles, prose read sentence by sentence, flattened ads repaired.
3. Skill matcher: plurals, capitalised product names mid-sentence (React, Spark), "R and Python".
4. Extraction: non-tech titles in "Company — Title" lines, more degrees, schema-safe lengths, no crash on very long bullets.
5. One coverage rule everywhere (shown in work 1, listed only 0.5); stale scores refreshed nightly.

## 5. Whole-system test (2026-11-10, before these fixes)

289 end-to-end scenarios, 285 passed; the 4 failures and the bugs found then (500 on deleted-file download,
over-long extracted fields, common-password check, tiny PDFs) are fixed except the tiny-PDF case. See the README
checklist for what remains.

## 6. Next steps for real-data accuracy

1. Labelled real data: consented resumes with recruiter judgements (fit) and practitioner role labels.
2. Fine-tune the embedding model on those labels (the RTX 2050 is enough for MiniLM-size models).
3. Recalibrate score bands on real labels; extend the taxonomy (finance, healthcare, operations skills);
   job-ad titles; German/Hindi headings.
