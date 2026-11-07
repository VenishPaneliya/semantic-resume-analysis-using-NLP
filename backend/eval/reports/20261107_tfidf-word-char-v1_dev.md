# Evaluation report — dev split

> **Synthetic data only.** SYNTHETIC DEVELOPMENT DATA. All people, employers and schools are fictional. Labels were hand-assigned by the developer and are NOT a substitute for evaluation on consented, representative real resumes.

| Setting | Value |
|---|---|
| split | dev |
| personas | 8 |
| embedding_model | tfidf-word-char-v1 |
| llm_provider | fixture |
| dataset | synthetic-personas-v1 |
| labels_as_of | 2025-09 |
| generated_at | 2026-11-07T12:44:06+00:00 |
| seconds | 4.7 |

## Field extraction (3 layouts × personas)

| Field | Accuracy | n |
|---|---|---|
| contact.email | 1.000 | 24 |
| contact.name | 1.000 | 24 |
| contact.phone | 1.000 | 21 |
| education.count | 1.000 | 24 |
| education.degree | 0.875 | 24 |
| education.institution | 1.000 | 24 |
| experience.bullet_recall | 1.000 | 75 |
| experience.count | 1.000 | 24 |
| experience.end/current | 1.000 | 30 |
| experience.organization | 1.000 | 30 |
| experience.start | 1.000 | 30 |
| experience.title | 1.000 | 30 |
| projects.count | 1.000 | 24 |

**Skill extraction:** precision 1.0, recall 1.0, F1 1.0 (tp=183, fp=0, fn=0)

| Layout | Skill P | Skill R | Mean field accuracy |
|---|---|---|---|
| A | 1.0 | 1.0 | 0.992 |
| B | 1.0 | 1.0 | 0.992 |
| C | 1.0 | 1.0 | 0.992 |

| Experience level | Mean field accuracy |
|---|---|
| junior | 1.0 |
| mid | 1.0 |
| senior | 0.952 |
| sparse | 1.0 |
| student | 1.0 |

## Role recommendation relevance (hand labels)

hit@1 1.0 · hit@3 1.0 · precision@3 0.667 · nDCG@5 0.995 · seniority within plausible range 1.0 (n=7)

| Persona | Level | Relevant | Top-3 | Seniority (exp → est) |
|---|---|---|---|---|
| p01 | student | data_analyst, data_scientist | data_analyst, data_scientist, data_engineer | entry → entry |
| p02 | junior | backend_developer, fullstack_developer | backend_developer, fullstack_developer, mobile_developer | junior → junior |
| p03 | mid | data_scientist, ml_engineer, mlops_engineer | ml_engineer, data_scientist, mlops_engineer | mid → senior |
| p04 | senior | devops_engineer, mlops_engineer | devops_engineer, mlops_engineer, ml_engineer | senior → staff |
| p05 | junior | qa_automation_engineer | qa_automation_engineer, devops_engineer, mlops_engineer | junior → junior |
| p06 | mid | frontend_developer, fullstack_developer | frontend_developer, fullstack_developer, mobile_developer | mid → senior |
| p07 | student | backend_developer, frontend_developer, fullstack_developer | frontend_developer, fullstack_developer, mobile_developer | entry → entry |
| p08 | sparse | — | insufficient expected: returned=True | — |

## Job requirement matching

Status accuracy 1.0 over 33 labelled requirements.

Confusion (expected → got): {"matched": {"matched": 16}, "missing": {"missing": 14}, "unknown": {"unknown": 2}, "partial": {"partial": 1}}

## Grounding verifier (unsupported-claim detection)

Recall on labelled unsupported claims: 0.923 (13 claims). Faithful rewrites falsely flagged: 0/8.

- “Migrated the marketing site to Next.js and Tailwind CSS in 2019.” — missed ['2019'] · flagged []

## Unsupported claims introduced by the configured rewriting provider

```
{
 "provider": "fixture",
 "model": "fixture-v1",
 "rewrites": 30,
 "rewrites_with_unsupported_claims": 0,
 "rate": 0.0,
 "examples": [],
 "note": "fixture provider is rule-based; configure LLM_PROVIDER to measure a real model"
}
```

## Limits

SYNTHETIC DEVELOPMENT DATA. All people, employers and schools are fictional. Labels were hand-assigned by the developer and are NOT a substitute for evaluation on consented, representative real resumes.
Labels were written by the same developer who built the heuristics; dev-split numbers are optimistic by construction. Only the test split was held out from tuning.
