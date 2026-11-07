# Resume Intelligence — AI Resume & Career Assistant

Analyzes resumes, recommends suitable roles, compares resumes against job descriptions and
helps users improve their resumes with AI — **without inventing qualifications**.

All scores are advisory indicators with published rules. They are not ATS scores, hiring
probabilities or guarantees of interviews or employment.

| | |
|---|---|
| Frontend | Next.js (App Router) · TypeScript · Tailwind — `frontend/` |
| API | FastAPI · Pydantic v2 · SQLAlchemy 2 · Alembic — `backend/app/` |
| Workers | Celery + Redis (parsing/OCR, exports, retention, stale-job recovery) |
| Storage | PostgreSQL · private S3-compatible bucket (SeaweedFS locally), app-level Fernet encryption |
| ML | Taxonomy-based skill normalisation · Sentence Transformers (TF-IDF fallback) · transparent hybrid ranker |
| AI | Provider-independent adapter (Anthropic, OpenAI, local fixture, disabled) + deterministic grounding verifier |

## Leaderboards (what a candidate sees)

| | Feature | Where |
|---|---|---|
| A | **Roles for me**: every role ranked for the resume, with matched / listed-only / missing keywords | Resume → Leaderboard |
| B | **Openings for me**: vacancies posted by the HR team, ranked for the resume | Resume → Leaderboard, Openings |
| C | **Where I stand**: rank and "top X%" among applicants to one opening (shown from 3 applicants; never other people's details) | Opening page |
| D | **Improve for this target**: concrete resume tips, **only when the resume is already related** (score ≥ 40 and ≥ ⅓ of core skills shown); otherwise a learning path | Leaderboard rows, opening page |

HR staff (`RECRUITER_EMAILS`) post openings and see applicants ranked, only for people who applied
and agreed to share. See [docs/SCORING.md](docs/SCORING.md#5-leaderboards-and-the-relevance-gate).

## Quick start (Docker)

```bash
cp .env.example .env            # defaults work for local development
docker compose up --build
```

- App: http://localhost:3000 · API docs: http://localhost:8000/api/docs · Email catcher: http://localhost:8025
- With no AI key configured, `LLM_PROVIDER=fixture` produces deterministic, rule-based edits that the
  UI labels **"Development fixture — not live AI"**. Set `LLM_PROVIDER=anthropic` and
  `ANTHROPIC_API_KEY` (or `openai`) to use a real model; users must consent before any resume text is sent.
- Set `ADMIN_EMAILS=you@example.com` to get the admin dashboard after verifying that email.
- Set `RECRUITER_EMAILS=hr@yourfirm.com` for HR staff who post job openings and review ranked applicants.
- Optional demo vacancies (stored with `is_demo=true`, badged "Sample opening"):
  `docker compose exec api python scripts/seed_demo_openings.py` (remove with `--remove`).

## Local development without Docker

```bash
# backend (Python 3.11+)
cd backend
python -m venv .venv && . .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -c constraints.txt ".[dev]"                 # add ",ml" for Sentence Transformers (+PyTorch)
alembic upgrade head                                    # SQLite by default (DATABASE_URL in .env)
uvicorn app.main:app --reload --port 8000               # TASK_ALWAYS_EAGER=true runs jobs inline

# frontend
cd frontend && npm install && npm run dev               # proxies /api to BACKEND_URL (default :8000)
```

Verification emails print to the API console when `EMAIL_BACKEND=console`.

## Checks

```bash
cd backend
ruff check app eval tests
pytest                                                  # SQLite
TEST_DATABASE_URL=postgresql+psycopg://ri:ri@localhost:5432/ri pytest   # PostgreSQL
python -m eval.run_eval --split all                     # synthetic evaluation report -> eval/reports/
cd ../frontend && npm run lint && npx tsc --noEmit && npm run build
```

CI (`.github/workflows/ci.yml`) runs lint, tests on SQLite and PostgreSQL, a migration
round-trip with `alembic check`, the synthetic evaluation, `pip-audit`, `npm audit`, image
builds and Trivy container scans.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, API boundaries, data flows, versioning |
| [docs/SCORING.md](docs/SCORING.md) | Rubric, recommender and JD-matching formulas; what the numbers do and do not mean |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) | Threat model, controls, AI data disclosure, retention, deletion |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Evaluation workflow, current synthetic results, protocol for consented real data |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment, configuration, backup/restore, operations runbook |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Operational dependencies and known limitations |
| [docs/openapi.json](docs/openapi.json) | OpenAPI 3 contract (also served live at `/api/openapi.json`) |
