# Scoring, ranking and matching — what the numbers mean

All numbers are **advisory indicators** computed by published, deterministic rules. None is an
ATS score, a hiring probability, or a prediction of interviews. The live rubric (weights, rules,
rationale) is served at `GET /api/rubric` and versioned (`rubric_version` on every result).

## 1. Resume rubric (`app/services/analysis/rubric.py`, `rubric-1.1.0`)

| Category | Weight | What is measured |
|---|---|---|
| Section completeness | 15 | email, phone, links, experience/projects, education, skills, summary |
| Bullet-point quality | 20 | very short (<6 words) / long (>35 words) bullets, duty openings ("responsible for"), no result or purpose |
| Quantified achievements | 15 | share of bullets containing a number; target 50% |
| Action verbs & repetition | 10 | recognised action-verb openings, repeated opening verbs, repeated 3-word phrases, first-person pronouns |
| Clarity & readability | 10 | summary length, clichés, passive phrasing, sentences > 30 words |
| Skill coverage & evidence | 15 | share of listed technical skills that appear in experience/project evidence; target 60% |
| Dates & timeline | 10 | undated entries, end-before-start, future starts, overlapping full-time roles, year-only dates; gaps are informational (0 points) |
| Parsing quality | 5 | measured only: uncertain fields, unparsed sections, OCR use, header content, embedded-font count, instruction-like text |

- Each category starts at 100; fixed rules subtract their points once; proportional rules subtract
  `weight × affected_bullets / total_bullets`. Scores are clamped to 0–100.
- **Missing vs. not extracted:** if a section heading was detected but its contents could not be
  parsed, the rubric reports "could not reliably extract" and does *not* deduct for a missing section.
- Categories without data are reported as `insufficient_data` and **excluded** from the overall
  weighted average (not scored as 0).
- Formatting: only properties read from the file (page count, page size, embedded fonts and sizes,
  text-layer presence, header content in DOCX) are reported. Visual layout is never inferred from text.
- Every finding carries the rule id, rationale, suggested fix, effort and resume evidence; the
  improvement list is ordered by priority (weighted impact), then effort.

## 2. Role recommendations (`app/services/ml/recommender.py`, `hybrid-recommender-1.1.0`)

```
fit = 100 × (0.40·required_coverage + 0.20·preferred_coverage + 0.25·semantic + 0.15·title_signal)
```

1. **Normalise skills** with the versioned taxonomy (`data/taxonomy/skills_v1.json`: canonical names,
   aliases, `related`, `implies`). Short tokens (Go, R, C) use stricter matching to avoid prose hits.
2. **Evidence weighting:** a skill shown in an experience/project bullet, project technology list or
   job title counts 1.0; listed only in the skills section counts 0.6; absent counts 0. Demonstrated
   tools propagate to implied skills (Tableau ⇒ Data Visualization); listed-only skills do not.
3. **Semantic signal:** embedding similarity between resume evidence text and the role profile, mapped
   to [0,1] with fixed per-backend anchors. Sentence Transformers (`all-MiniLM-L6-v2`) when installed,
   otherwise TF-IDF (recorded as `embedding_model` on every result). *This is not a probability.*
4. **Title signal:** 1 if a job title matches the role or a related title; 0.5 if a project name does.
5. **Preferences** (target roles +5, preferred domain +3) change ordering only and are reported
   separately as `preference_adjustment`; they never change `fit_score`. Location and work arrangement
   are stored but not used for ranking (role profiles are location-independent).
6. **Insufficient evidence:** fewer than 4 recognised skills, fewer than 2 evidence units, or under 40
   words of evidence text returns `status: insufficient_evidence` with what to add, instead of a ranking.
7. **Seniority:** overlap-merged dated experience (internships at half weight) mapped to bands, with a
   ± margin that widens for year-only or missing dates; reported as an estimate + plausible range.

**Fairness constraint:** ranking features use job titles, bullets, projects, skills, degree field and
certification names only. Name, contact details, location, photos, employer and school names (possible
proxies) and protected attributes are excluded. A test asserts identical scores when these change.

No supervised classifier is shipped: there is no labelled, consented, representative dataset to train or
validate one. See [EVALUATION.md](EVALUATION.md#what-data-would-improve-the-models) for what would be needed.

## 3. Job description matching (`app/services/ml/jd.py`, `jd-matcher-1.1.0`)

Requirements are extracted per line under requirement/preferred headings and classified as
`skill`, `experience`, `education`, `certification`, `unassessable` (work authorisation, travel, …) or `other`.

| Status | Meaning |
|---|---|
| matched | evidence satisfies it (all listed skills demonstrated, or any one for "X or Y") |
| partial | some evidence: listed-but-not-demonstrated skills, some of several skills, experience within 1 year, degree below level when "or equivalent experience" is stated |
| missing | no evidence — split into **genuine gap** vs **possibly unlisted** (a related skill is demonstrated, so the user may have it but did not write it down) |
| unknown | cannot be assessed from a resume, or undated roles make it uncertain |

```
overall = 60% requirement coverage (required weight 1, preferred 0.5; matched 1, partial 0.5, unknown excluded)
        + 20% keyword coverage (JD skills present in resume)
        + 20% semantic alignment (resume evidence vs JD text)
```

Guidance never suggests adding keywords the user cannot support.

## 4. Grounding verifier (`app/services/llm/grounding.py`)

Generated text is checked against the confirmed resume plus facts the user explicitly confirmed:
numbers (incl. word numbers), years, taxonomy skills, credential phrases and capitalised entities.
Unsupported claims turn a suggestion into `needs_facts`; acceptance is refused until the user edits
the text or confirms each fact (recorded on the suggestion). `[ADD: …]` placeholders are allowed and
are flagged again at export. Known limitation: a real value used in the wrong context (e.g. a year that
exists elsewhere in the resume) is not detected.

## 5. Leaderboards and the relevance gate (`app/services/ml/leaderboard.py`, `leaderboard-1.1.0`)

- **A. Roles:** all taxonomy roles ranked by the §2 fit score plus the preference adjustment (target roles / domains saved
  on the account). Each row shows the adjustment openly ("+5 preference"); the score itself is unchanged. This view
  also replaced the separate Roles tab, and carries the seniority estimate.
- **B. Openings:** open vacancies posted by HR staff, ranked by the §3 compatibility indicator.
- **C. Standing:** `rank = 1 + number of applicants with a strictly higher score` (ties share the better
  rank) and `top % = rank / applicants`. It is shown only when at least 3 people have applied. Candidates see
  their own rank, the count, the median and a 10-point histogram, never another applicant's identity or
  score. Scores are recomputed when a candidate re-applies or the recruiter edits the opening.
- **Tiers (heuristic bands, not probabilities):** strong ≥ 60, good 40–59, stretch 25–39, not a match < 25.
  The bands were set by inspecting the synthetic personas: their true role scores 60–96 on roles and 78–96 on
  matching demo openings, adjacent roles 35–57, and unrelated roles mostly below 25.
- **Relevance gate (D):** resume tips and AI tailoring are offered only if **score ≥ 40 and at least a third of
  the target's core (required) skills are already shown**. The second floor stops generic signals (years of
  experience, degree, wording) from unlocking tips for an unrelated job; e.g. an ML-engineer persona scores 41
  on a backend opening with only 20% of its core skills. Below the gate the user gets a learning path (missing
  skills) instead, and `POST /suggestions` with `operation=tailor` returns `422 target_not_related`.
- **Tips** are deterministic. They cover: show skills that are listed but not demonstrated; ask about
  missing skills with related evidence ("if you haven't, leave it out"); use the target's standard wording for
  skills you already have; lead with and quantify your most relevant bullets; and point the summary at the
  target. None of them adds a skill or result on the user's behalf.

## 6. Fairness monitoring (`/api/recruiter/fairness`, admins only)

For each dimension (gender, age band), from **voluntary** self-identification only, and only for applicants
who applied themselves: group size, mean compatibility score, strong rate (score ≥ 60) and selection rate
(stage shortlisted/interview/offer/hired). Impact ratio = group rate ÷ highest group rate; below 0.8 is
flagged (four-fifths rule). Groups with fewer than 10 people are suppressed, a dimension is shown only when
at least 2 groups pass that threshold, and the data is a snapshot as of the start of the current UTC day (stage
changes made today are not counted), so the report can't be used to infer one person's answer. A counterfactual test
(`test_counterfactual_identity_changes_do_not_change_scores`) checks that changing name, contact details,
location, employer and school leaves every score unchanged.

## 7. Mock interview checks (`app/services/interview.py`)

Rule-based, always shown separately from AI coaching: situation cue, first-person action verb, result cue,
a number, 60–300 words, "I" at least as often as "we", and whether skills mentioned appear in the resume.
Score = 1 + 4 × (checks passed ÷ 7). These are structure heuristics, not a judgement of answer quality.
