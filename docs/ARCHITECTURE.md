# Architecture

## Assumptions

- Greenfield repository; default stack from the brief is used unchanged.
- Development and CI must run without paid credentials: the LLM layer has a `fixture`
  provider whose output is **always labelled `provider: "fixture"`** and rendered in the UI
  with a "Development fixture — not live AI" badge.
- The deterministic pipeline (parsing → extraction → rubric → recommendation → JD matching)
  never depends on an LLM. LLM calls are additive (rewrites, cover letters, interview
  questions, optional extraction refinement) and their failure never erases deterministic
  results.
- Tests run on SQLite + eager task execution + local encrypted storage. Production uses
  PostgreSQL, Redis/Celery and S3-compatible storage. The same code paths and the same
  Alembic migrations serve both (migrations avoid Postgres-only DDL).

## Components

```
                ┌────────────────────────┐
 Browser ──────▶│ Next.js (frontend/)    │  App Router, TS, Tailwind
                │ same-origin /api proxy │  HTTP-only session cookie + CSRF header
                └──────────┬─────────────┘
                           │ /api/*
                ┌──────────▼─────────────┐
                │ FastAPI (backend/app)  │  typed Pydantic contracts, OpenAPI at /api/docs
                │  api/      routers     │  ownership checks in deps.get_owned()
                │  security/ sessions,   │  CSRF, rate limits, quotas
                │  services/ domain logic│
                └──┬─────────┬───────┬───┘
                   │         │       │
         ┌─────────▼──┐ ┌────▼───┐ ┌─▼────────────────┐
         │ PostgreSQL │ │ Redis  │ │ S3-compatible    │ private bucket, SSE + app-level
         │ (Alembic)  │ │ broker │ │ (Fernet) encryption, signed URLs
         └────────────┘ └────┬───┘ └──────────────────┘
                             │
                   ┌─────────▼──────────┐
                   │ Celery workers     │  parse/OCR (sandboxed subprocess with
                   │ app/worker/        │  time + memory limits), analysis, exports,
                   │                    │  retention sweeps (beat)
                   └────────────────────┘
```

### Separation of concerns

| Layer | Package | Depends on LLM? |
|---|---|---|
| Upload validation | `services/upload_validation.py` | no |
| Parsing (PDF/DOCX/OCR) | `services/parsing/` | no |
| Structured extraction | `services/extraction/` | no (optional LLM refinement is a separate step) |
| Skill normalisation | `services/skills.py` + `data/taxonomy/skills_v1.json` | no |
| Rubric analysis | `services/analysis/rubric.py` | no |
| Embeddings | `services/ml/embeddings.py` (Sentence Transformers or TF-IDF fallback) | no |
| Role recommendation | `services/ml/recommender.py` | no (explanations are template-grounded) |
| JD extraction & matching | `services/ml/jd.py` | no |
| Generation (rewrite, cover letter, interview) | `services/llm/` | yes, behind `LLMProvider` |
| Grounding verifier | `services/llm/grounding.py` | no — verifies LLM output deterministically |
| Export (PDF/DOCX) | `services/export/` | no |

## Data model (summary)

- `users`, `oauth_accounts`, `sessions`, `auth_tokens` — identity. Session and auth tokens
  are stored only as SHA-256 hashes.
- `resumes` — the original upload (immutable file key, sha256, page count, status).
- `extractions` — parser output: encrypted raw text, per-page text, structured fields with
  evidence spans/page refs and confidence, warnings, parser version.
- `resume_versions` — structured resume content (JSON), linear history with
  `parent_id`, `source` (`extracted` | `user_edit` | `ai_accepted` | `restore`), `label`.
  Version 1 is created when the user confirms the extraction review.
- `processing_jobs` — durable job state machine (`queued → running → succeeded|failed`,
  attempts, idempotency key, error code).
- `analyses`, `role_recommendations`, `jd_matches` — cached results keyed by
  `(user, version, content_hash, engine versions)`.
- `job_descriptions` — user JDs with extracted requirements.
- `ai_suggestions` — pending/accepted/rejected edits with before/after, explanation,
  grounding report, provider/model/prompt version.
- `exports`, `career_artifacts`, `applications`, `usage_events`, `audit_logs`.

See `backend/app/models.py` and `backend/alembic/versions/` for the authoritative schema.

## API boundaries

All routes are under `/api`. Groups: `auth`, `account`, `resumes`, `versions`,
`analysis`, `recommendations`, `jobs` (JD), `suggestions` (AI editor), `exports`,
`career`, `applications`, `processing-jobs`, `admin`, `health`, `metrics`.
OpenAPI: `/api/openapi.json`, Swagger UI at `/api/docs`.

## Data flow: upload → analysis

1. `POST /api/resumes` (multipart). Validation: extension, declared MIME, magic bytes,
   size, page count (PDF), encryption, zip-bomb checks (DOCX). File is encrypted and stored
   under `users/{uid}/resumes/{rid}/original`.
2. A `parse_resume` job is enqueued with idempotency key `parse:{resume_id}:{sha256}`.
3. Worker runs the parser in a child process with a wall-clock timeout and (on POSIX) an
   address-space limit. Output: pages, text, layout measurements (fonts, sizes — only what
   the PDF actually reports).
4. Extraction builds structured fields with evidence `{page, start, end, text}` and
   confidence; uncertain fields are flagged, never silently guessed.
5. User reviews/corrects (`PUT /api/resumes/{id}/review`) → creates confirmed version 1.
6. Analysis/recommendation/JD-match run on a **confirmed version**; results are cached by
   content hash + engine versions so re-running is idempotent and cheap.

## Data flow: AI edit

1. `POST /api/versions/{vid}/suggestions` with an operation (rewrite bullet, improve
   summary, shorten, grammar, tailor, tone/length).
2. The prompt contains only the needed section, with contact PII redacted, wrapped in
   `<resume_data>` delimiters and an instruction that the content is untrusted data.
3. The response must validate against a Pydantic schema; invalid output is retried once
   then fails without side effects.
4. `grounding.verify()` compares numbers, dates, organisations, credentials and skills in
   the output against the confirmed fact base. Unsupported claims are converted to
   `[placeholder]` markers or the suggestion is marked `needs_facts` with questions.
5. User sees a diff and explicitly accepts; acceptance creates a new version
   (`source=ai_accepted`). Undo = restore a previous version (creates a new version; history
   is append-only). The original upload is never modified.

## Versioning

Every derived result stores `rubric_version`, `taxonomy_version`, `embedding_model`,
`recommender_version`, `prompt_version`, `provider`, `model`. See `app/versions.py`.

## Implementation phases

1. Auth, upload, extraction, extraction review.
2. Analysis dashboard and persisted results.
3. Role recommendations and JD matching.
4. AI editing, version history, export.
5. Career features and application tracker.
6. Hardening, evaluation, monitoring, deployment.
