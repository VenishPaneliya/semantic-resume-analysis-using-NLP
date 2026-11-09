# Resume Intelligence — AI Resume & Career Assistant

*(Repository: `semantic-resume-analysis-using-NLP`)*

Analyzes resumes, recommends suitable roles, compares resumes against job descriptions and
helps users improve their resumes with AI — **without inventing qualifications**.

All scores are advisory indicators with published rules. They are not ATS scores, hiring
probabilities or guarantees of interviews or employment.

> **Status: working prototype, not production-ready.** The features below work end to end and are
> tested, but there are open security, deployment and quality items. See
> [Road to production](#road-to-production) for the full list and what has been fixed so far.

| | |
|---|---|
| Frontend | Next.js (App Router) · TypeScript · Tailwind — `frontend/` · English, Hindi, Gujarati interface |
| API | FastAPI · Pydantic v2 · SQLAlchemy 2 · Alembic — `backend/app/` |
| Workers | Celery + Redis (parsing/OCR, exports, retention, stale-job recovery, job alerts) |
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

## More features

| For | Feature |
|---|---|
| Recruiters | Shortlisting filters (must-have skills, years, score, stage), side-by-side comparison, private notes, pipeline board (submitted → hired), consent-attested bulk upload (auto-deleted after 90 days), firm analytics, fairness report |
| Candidates | Live "what-if" score while editing, job alerts by email (opt-in), learning plan with progress and link-checked official resources, resume health over time, mock interview practice (rule-based checks + optional AI coaching) |
| Everyone | Two-factor login (required for staff), voluntary self-identification for fairness monitoring only, interface in English / हिन्दी / ગુજરાતી |

**Languages:** the interface (menus, buttons, help text) is available in Hindi and Gujarati. Resume
content, analysis results, tips and AI output stay in English, and pages say so. The Hindi and
Gujarati text is machine-drafted and needs native-speaker review — see
[docs/TRANSLATIONS.md](docs/TRANSLATIONS.md).

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build
```

- App: http://localhost:3000 · API docs: http://localhost:8000/api/docs · Email catcher (verification emails): http://localhost:8025
- **Only the variables listed in `docker-compose.yml` reach the containers**; other values in `.env`
  are currently ignored (tracked below).
- `INSTALL_ML=false docker compose up --build` builds a ~0.9 GB API image with the TF-IDF fallback
  instead of ~2.7 GB with Sentence Transformers.
- With no AI key configured, `LLM_PROVIDER=fixture` produces deterministic, rule-based edits that the
  UI labels **"Development fixture — not live AI"**. Set `LLM_PROVIDER=anthropic` and
  `ANTHROPIC_API_KEY` (or `openai`) to use a real model; users must consent before any resume text is sent.
- Set `ADMIN_EMAILS=you@example.com` to get the admin dashboard after verifying that email.
- Set `RECRUITER_EMAILS=hr@yourfirm.com` for HR staff who post job openings and review ranked applicants.
- **Staff must turn on two-factor login** (Settings) before admin or recruiter pages work. For local
  testing only, `REQUIRE_MFA_FOR_STAFF=false` turns this off; it cannot be off in production.
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
pytest                                                  # SQLite — 196 tests
TEST_DATABASE_URL=postgresql+psycopg://ri:ri@localhost:<port>/ri pytest   # PostgreSQL
python -m eval.run_eval --split all                     # synthetic evaluation report -> eval/reports/
cd ../frontend && npm run lint && npx tsc --noEmit && npm run build
node e2e/overflow-check.mjs                             # no sideways scrolling on any page (needs the app running)
```

CI is defined in `.github/workflows/ci.yml` (lint, tests on SQLite and PostgreSQL, migration
round-trip, evaluation, `pip-audit`, `npm audit`, image builds, Trivy scans). The causes of the
earlier failures are fixed locally (see below); a green run is confirmed once these changes are pushed.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, API boundaries, data flows, versioning |
| [docs/SCORING.md](docs/SCORING.md) | Rubric, recommender and JD-matching formulas; what the numbers do and do not mean |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) | Threat model, controls, AI data disclosure, retention, deletion |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Evaluation workflow, current synthetic results, protocol for consented real data |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment, configuration, backup/restore, operations runbook |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Operational dependencies and known limitations |
| [docs/TRANSLATIONS.md](docs/TRANSLATIONS.md) | Hindi/Gujarati interface: glossary, terms to review, adding a language |
| [docs/openapi.json](docs/openapi.json) | OpenAPI 3 contract (also served live at `/api/openapi.json`) |

## Road to production

Findings from a full review of the system on 2026-11-08 (security, backend logic and scoring,
user-facing screens, deployment and docs). Each item was confirmed by reading the code path and,
where possible, reproducing it. Severity: **H** high · **M** medium · **L** low.
Tick items off here as they are fixed.

### Fixed

Round 2 (2026-11-09) — repository, security and the leaderboard:

- [x] **H** Root `.gitignore` added; caches, test databases, test resume files and mock-up files are no longer
  tracked (they remain in earlier commits of the public repo; all synthetic test data).
- [x] **H** Build/CI blockers: `pyproject.toml` now lists its package (local `pip install` works), `setuptools`
  pinned to a release without known advisories (`pip-audit`: none), Next.js's bundled PostCSS forced to a
  patched version (`npm audit`: 0 vulnerabilities).
- [x] **H** Password guessing: wrong passwords are now limited **per account** (10 per 15 min) regardless of the
  client IP, and reset emails are capped per address (5 an hour). Proven with spoofed `X-Forwarded-For` in tests.
  Remaining for production: the edge proxy must overwrite `X-Forwarded-For` (documented in DEPLOYMENT.md).
- [x] **H** Fairness report: admin-only, a daily snapshot (today's stage changes don't show), shown only when 2+
  groups each have 10+ people, no hidden/self-identified counts. Tests reproduce the old attack and show it fails.
- [x] **H** `/api/metrics` is no longer forwarded by the website; production requires `METRICS_TOKEN` and turns off
  `/api/docs`.
- [x] **H** Roles and Leaderboard merged into one Leaderboard (seniority estimate and saved preferences in its
  sidebar, preference boost shown on each row, model names removed from explanations); 9 tabs → 8. Old
  `/roles` links redirect.
- [x] **M** Data export no longer contains the two-factor secret or recovery-code hashes.
- [x] **M** Two-factor guessing: 10 wrong codes per account per hour across all entry points, and a sign-in
  attempt is cancelled after 5 wrong codes; new-recovery-codes endpoint has its own limit.
- [x] **M** Production configuration now also rejects console email, in-memory rate limits, a missing metrics
  token and non-https URLs.
- [x] **L** `eval/run_eval.py` no longer crashes on a Windows console.

Round 1 (2026-11-08) — text matching:

- [x] **H** Skill detection missed common abbreviations ("ML", "JS", "S3", "K6") and counted everyday
  words as skills ("Go-to-market" → Go, "excel at" → Excel, "took the helm" → Kubernetes,
  "Bert" → Transformers, "react to incidents" → React). `services/taxonomy.py`; 27 regression cases in `tests/test_text_matching.py`.
- [x] **H** Degree reading: "Bachelor's in Information *Systems*" and "BSc Systems Engineering" were read as a
  master's; "must *be* able to" and "contact *me*" could read as degrees; "Associate degree" and "High
  school diploma" were mislevelled; "MS Office" counted as a master's. `services/ml/jd.py`; 17 cases.
- [x] **M** "Jan 2019 to date" / "till date" end dates were not recognised, so the job looked undated.
  `services/extraction/dates.py`; 5 cases.
- [x] Engine versions bumped (extractor, rubric, recommender, JD matcher, leaderboard → 1.1.0) so results
  computed before these fixes are distinguishable.

### Repository and CI

- [ ] **H** Most of the current work (migration 0004, 2FA, recruiter tools, translations) is not committed or pushed.
- [ ] **L** No LICENSE or CONTRIBUTING file; frontend dependencies use caret ranges.

### Security and privacy

- [ ] **M** Resume content, AI suggestions, cover letters and bulk-upload results are stored unencrypted in the
  database (only raw text and files are encrypted).
- [ ] **M** Without `ENCRYPTION_KEYS`, the encryption key comes from `SECRET_KEY`, so changing `SECRET_KEY` makes
  every stored file unreadable (docs say otherwise).
- [ ] **M** "Where I stand" with only 3 applicants shows a median and histogram that reveal other applicants' scores.
  Raise the pool size for those. `services/ml/leaderboard.py:179`.
- [ ] **L** PDF page counting runs inside the API process; bulk upload parses up to 25 files in one request.
- [ ] **L** Registration says "email already in use" (account enumeration).
- [ ] **L** Turning on 2FA doesn't sign out other sessions; Google login puts the 2FA token in the URL.
- [ ] **L** Unverified accounts are never deleted (`UNVERIFIED_ACCOUNT_RETENTION_DAYS` is unused).

### Scoring and backend logic

- [ ] **H** JD parsing: "Nice to have: Kafka, Terraform" is treated as required, and "5+ years Python" shows
  as "not stated". A JD saved without a title shows "Untitled role".
- [ ] **H** The openings leaderboard re-runs the full matcher for every opening on every request
  (~17 s for 200 openings with Sentence Transformers). Cache resume embeddings and per-opening results.
  Job alerts do the same for every user.
- [ ] **M** Resume retention deletes the whole resume (versions, applications, recruiter notes) after 365 days
  from upload, even if it is in active use.
- [ ] **M** One Celery time limit (75 s) for every task; the nightly retention sweep commits once at the end, so a
  large sweep can be killed and roll back every night.
- [ ] **M** `docs/EVALUATION.md` overstates: skill P/R 1.0 only measures skills-section strings, role metrics use
  ground-truth content rather than extracted content, and the tier thresholds have no script behind them.
- [ ] **L** "Required coverage" is computed three different ways (rubric, recommender, openings); the role
  leaderboard order includes a hidden +5/+3 preference adjustment.
- [ ] **L** A prose-only JD is scored on semantic similarity alone; a missing score shows as "Not a match".
- [ ] **L** Concurrent apply/save returns 500 instead of 409; recruiter candidate lists aren't paginated;
  processing-job rows are never purged.
- [ ] **L** JD-match cache key ignores the taxonomy version; applications aren't rescored when the matcher changes.

### Screens and experience

- [ ] **M** Developer details shown to users: AI cost "$0.0000", "Development fixture", raw browser strings,
  rubric weights, "no job-listings provider is configured" (model names in role explanations: fixed).
- [ ] **M** Hindi/Gujarati: analysis results, role names and dates stay in English; translations need native review.
- [ ] **M** Phones: the active resume tab can be off-screen; the improvements table is cut off.
- [ ] **M** Form errors only say "Some fields are invalid" without saying which field.
- [ ] **M** Closed openings still show tips and a Re-apply button that fails.
- [ ] **M** Every page has the same browser-tab title.
- [ ] **M** Editor preview is squeezed into ~250 px under the section-order controls.
- [ ] **L** A wrong resume link shows "Something went wrong" with Retry instead of "not found"; destructive actions
  use the browser's plain confirm dialog; "Rank openings" is active when there are none.
- [ ] **L** Copy: "Hello" without the user's name, titles taken from file names ("p02"), "1 of 5 bullets are",
  landing page never mentions HR firms.
- [ ] **L** Accessibility: skipped heading levels, editor tabs without arrow-key support, low-contrast disabled tabs.
- [ ] **L** Code: all three language files load for every user; static data refetched on each tab switch;
  saved cover letters can't be reopened; interview list shows sessions from all resumes.

### Deployment and operations

- [ ] **M** No production deployment files: `deploy/` only has the SeaweedFS config; compose hard-codes
  `ENV=development`; no TLS proxy, secret management or backup jobs.
- [ ] **M** Compose ignores most of `.env` (no `env_file`); no restart policies or resource limits; the S3
  identity has Admin rights and a dev secret.
- [ ] **M** Metrics from Celery workers are never exposed, and the API's two workers each report their own counters.
- [ ] **L** Settings `.env.example` is missing several variables; `LEARNING_RESOURCES_PROVIDER` default differs from code.
- [ ] **L** API image is 2.7 GB and includes tests/eval; base images are not digest-pinned.

### Already checked and sound

No user can read another user's data (every owned route checks ownership); sessions, tokens and
downloads are hashed, expiring and user-bound; uploads are type-checked and parsed in a sandbox; files
are encrypted; self-ID data is never used for ranking; AI prompts are pseudonymised and every AI
suggestion is checked against the resume before it can be accepted; account deletion covers every table;
database models match the migrations; the page layout is consistent with no sideways scrolling.
