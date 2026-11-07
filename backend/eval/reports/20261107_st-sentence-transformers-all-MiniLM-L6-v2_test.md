# Evaluation report — test split

> **Synthetic data only.** SYNTHETIC DEVELOPMENT DATA. All people, employers and schools are fictional. Labels were hand-assigned by the developer and are NOT a substitute for evaluation on consented, representative real resumes.

| Setting | Value |
|---|---|
| split | test |
| personas | 4 |
| embedding_model | st:sentence-transformers/all-MiniLM-L6-v2 |
| llm_provider | fixture |
| dataset | synthetic-personas-v1 |
| labels_as_of | 2025-09 |
| generated_at | 2026-11-07T12:44:27+00:00 |
| seconds | 15.1 |

## Field extraction (3 layouts × personas)

| Field | Accuracy | n |
|---|---|---|
| contact.email | 1.000 | 12 |
| contact.name | 1.000 | 12 |
| contact.phone | 1.000 | 12 |
| education.count | 1.000 | 12 |
| education.degree | 0.750 | 12 |
| education.institution | 1.000 | 12 |
| experience.bullet_recall | 1.000 | 48 |
| experience.count | 1.000 | 12 |
| experience.end/current | 1.000 | 18 |
| experience.organization | 1.000 | 18 |
| experience.start | 1.000 | 18 |
| experience.title | 1.000 | 18 |
| projects.count | 1.000 | 12 |

**Skill extraction:** precision 1.0, recall 1.0, F1 1.0 (tp=99, fp=0, fn=0)

| Layout | Skill P | Skill R | Mean field accuracy |
|---|---|---|---|
| A | 1.0 | 1.0 | 0.986 |
| B | 1.0 | 1.0 | 0.986 |
| C | 1.0 | 1.0 | 0.986 |

| Experience level | Mean field accuracy |
|---|---|
| junior | 0.967 |
| mid | 1.0 |
| senior | 1.0 |

## Role recommendation relevance (hand labels)

hit@1 1.0 · hit@3 1.0 · precision@3 0.5 · nDCG@5 0.969 · seniority within plausible range 0.75 (n=4)

| Persona | Level | Relevant | Top-3 | Seniority (exp → est) |
|---|---|---|---|---|
| p09 | mid | backend_developer, data_engineer | data_engineer, ml_engineer, data_scientist | mid → senior |
| p10 | junior | ml_engineer, nlp_llm_engineer | nlp_llm_engineer, ml_engineer, data_scientist | junior → junior |
| p11 | senior | data_analyst, data_scientist | data_scientist, data_analyst, data_engineer | senior → staff |
| p12 | junior | mobile_developer | mobile_developer, backend_developer, fullstack_developer | junior → junior |

## Job requirement matching

Status accuracy 0.933 over 15 labelled requirements.

Confusion (expected → got): {"matched": {"matched": 8, "partial": 1}, "missing": {"missing": 6}}

Misses:
- p10/jd_ml: “Python” expected matched, got partial

## Grounding verifier (unsupported-claim detection)

Recall on labelled unsupported claims: 0.923 (13 claims). Faithful rewrites falsely flagged: 0/8.

- “Migrated the marketing site to Next.js and Tailwind CSS in 2019.” — missed ['2019'] · flagged []

## Unsupported claims introduced by the configured rewriting provider

```
{
 "provider": "fixture",
 "model": "fixture-v1",
 "rewrites": 16,
 "rewrites_with_unsupported_claims": 0,
 "rate": 0.0,
 "examples": [],
 "note": "fixture provider is rule-based; configure LLM_PROVIDER to measure a real model"
}
```

## Limits

SYNTHETIC DEVELOPMENT DATA. All people, employers and schools are fictional. Labels were hand-assigned by the developer and are NOT a substitute for evaluation on consented, representative real resumes.
Labels were written by the same developer who built the heuristics; dev-split numbers are optimistic by construction. Only the test split was held out from tuning.
