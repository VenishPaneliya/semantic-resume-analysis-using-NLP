# Evaluation report — all split

> **Synthetic data only.** SYNTHETIC DEVELOPMENT DATA. All people, employers and schools are fictional. Labels were hand-assigned by the developer and are NOT a substitute for evaluation on consented, representative real resumes.

| Setting | Value |
|---|---|
| split | all |
| personas | 12 |
| embedding_model | st:sentence-transformers/all-MiniLM-L6-v2 |
| llm_provider | fixture |
| dataset | synthetic-personas-v1 |
| labels_as_of | 2025-09 |
| generated_at | 2026-11-08T15:08:54+00:00 |
| seconds | 15.5 |

## Field extraction (3 layouts × personas)

| Field | Accuracy | n |
|---|---|---|
| contact.email | 1.000 | 36 |
| contact.name | 1.000 | 36 |
| contact.phone | 1.000 | 33 |
| education.count | 1.000 | 36 |
| education.degree | 0.833 | 36 |
| education.institution | 1.000 | 36 |
| experience.bullet_recall | 1.000 | 123 |
| experience.count | 1.000 | 36 |
| experience.end/current | 1.000 | 48 |
| experience.organization | 1.000 | 48 |
| experience.start | 1.000 | 48 |
| experience.title | 1.000 | 48 |
| projects.count | 1.000 | 36 |

**Skill extraction:** precision 1.0, recall 1.0, F1 1.0 (tp=282, fp=0, fn=0)

| Layout | Skill P | Skill R | Mean field accuracy |
|---|---|---|---|
| A | 1.0 | 1.0 | 0.990 |
| B | 1.0 | 1.0 | 0.990 |
| C | 1.0 | 1.0 | 0.990 |

| Experience level | Mean field accuracy |
|---|---|
| junior | 0.984 |
| mid | 1.0 |
| senior | 0.976 |
| sparse | 1.0 |
| student | 1.0 |

## Role recommendation relevance (hand labels)

hit@1 1.0 · hit@3 1.0 · precision@3 0.606 · nDCG@5 0.986 · seniority within plausible range 0.909 (n=11)

| Persona | Level | Relevant | Top-3 | Seniority (exp → est) |
|---|---|---|---|---|
| p01 | student | data_analyst, data_scientist | data_analyst, data_scientist, data_engineer | entry → entry |
| p02 | junior | backend_developer, fullstack_developer | backend_developer, fullstack_developer, mobile_developer | junior → junior |
| p03 | mid | data_scientist, ml_engineer, mlops_engineer | ml_engineer, data_scientist, mlops_engineer | mid → senior |
| p04 | senior | devops_engineer, mlops_engineer | devops_engineer, mlops_engineer, data_engineer | senior → staff |
| p05 | junior | qa_automation_engineer | qa_automation_engineer, devops_engineer, backend_developer | junior → junior |
| p06 | mid | frontend_developer, fullstack_developer | frontend_developer, fullstack_developer, mobile_developer | mid → senior |
| p07 | student | backend_developer, frontend_developer, fullstack_developer | frontend_developer, fullstack_developer, mobile_developer | entry → entry |
| p08 | sparse | — | insufficient expected: returned=True | — |
| p09 | mid | backend_developer, data_engineer | data_engineer, ml_engineer, data_scientist | mid → senior |
| p10 | junior | ml_engineer, nlp_llm_engineer | nlp_llm_engineer, ml_engineer, data_scientist | junior → junior |
| p11 | senior | data_analyst, data_scientist | data_scientist, data_analyst, data_engineer | senior → staff |
| p12 | junior | mobile_developer | mobile_developer, backend_developer, fullstack_developer | junior → junior |

## Job requirement matching

Status accuracy 0.979 over 48 labelled requirements.

Confusion (expected → got): {"matched": {"matched": 24, "partial": 1}, "missing": {"missing": 20}, "unknown": {"unknown": 2}, "partial": {"partial": 1}}

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
 "rewrites": 46,
 "rewrites_with_unsupported_claims": 0,
 "rate": 0.0,
 "examples": [],
 "note": "fixture provider is rule-based; configure LLM_PROVIDER to measure a real model"
}
```

## Limits

SYNTHETIC DEVELOPMENT DATA. All people, employers and schools are fictional. Labels were hand-assigned by the developer and are NOT a substitute for evaluation on consented, representative real resumes.
Labels were written by the same developer who built the heuristics; dev-split numbers are optimistic by construction. Only the test split was held out from tuning.
