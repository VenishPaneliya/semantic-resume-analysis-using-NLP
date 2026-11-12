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
- Values in `.env` reach the API, worker and beat containers (`env_file`); values written in
  `docker-compose.yml` take precedence. Host ports: `FRONTEND_HOST_PORT`, `API_HOST_PORT`, `MAILPIT_HOST_PORT`.
- `INSTALL_ML=false docker compose up --build` builds a ~0.9 GB API image with the TF-IDF fallback
  instead of ~2.4 GB with Sentence Transformers.
- Production: `deploy/docker-compose.prod.yml` (Caddy TLS proxy, daily database backups, restore script);
  see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- With no AI key configured, `LLM_PROVIDER=fixture` produces deterministic, rule-based edits that the
  UI labels **"Development fixture — not live AI"**. Set `LLM_PROVIDER=anthropic`,
  `ANTHROPIC_API_KEY` and `LLM_MODEL` (the provider's model ID), or the `openai` equivalents, to use a real model; users must consent before any resume text is sent.
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
pytest                                                  # SQLite — about 300 tests
TEST_DATABASE_URL=postgresql+psycopg://ri:ri@localhost:<port>/ri pytest   # PostgreSQL
python -m eval.run_eval --split all                     # small hand-written synthetic set -> eval/reports/
python -m eval.run_eval_v2                              # 108 generated resumes, 18 profiles, 5 layouts, 36 JDs
python -m eval.real.run_real                            # public labelled datasets + live job postings (downloads to var/)
cd ../frontend && npm run lint && npx tsc --noEmit && npm run build
node e2e/overflow-check.mjs                             # no sideways scrolling on any page (needs the app running)
node e2e/full-scenarios.mjs                             # 289 end-to-end scenarios (needs the app + Mailpit running)
```

CI is defined in `.github/workflows/ci.yml` (lint, tests on SQLite and PostgreSQL, migration
round-trip, evaluation, `pip-audit`, `npm audit`, image builds, Trivy scans) and is green on `main`.

**Model accuracy (2026-11, after improvements):** synthetic data: skill F1 0.998, correct role first 99%,
job-ad skills F1 0.997, ranking nDCG@10 0.978. Real data: skill F1 0.83, correct role first 68% (was 40%),
live job-ad required skills F1 0.83 (was 0.75) and years 83% (was 57%); resume–job fit AUC 0.53 on a
noisy public dataset where even a trained model reaches 0.61. Details: [docs/EVALUATION_REPORT_2026-11.md](docs/EVALUATION_REPORT_2026-11.md).

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data model, API boundaries, data flows, versioning |
| [docs/SCORING.md](docs/SCORING.md) | Rubric, recommender and JD-matching formulas; what the numbers do and do not mean |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) | Threat model, controls, AI data disclosure, retention, deletion |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Evaluation workflow, current synthetic results, protocol for consented real data |
| [docs/EVALUATION_REPORT_2026-11.md](docs/EVALUATION_REPORT_2026-11.md) | Synthetic vs real-data accuracy comparison, whole-system test results, weaknesses found |
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

Round 4 (2026-11-09) — leaderboard speed and standing privacy:

- [x] **H** The openings leaderboard re-ran the full matcher, including re-embedding the resume, for every
  opening on every view: 18 s for 200 openings. Text embeddings are now cached per exact text (bounded, ~30 MB)
  and the resume side is prepared once per request: **0.13 s** (about 3 s on the first view after a restart).
  Job alerts reuse each opening's cached requirement embeddings. Tests confirm results are identical.
- [x] **M** "Where I stand" no longer reveals other applicants' scores in small pools: rank and "top X%" from 3
  applicants; the median (rounded to 5) and score spread only from 10, and a band with 1–2 people shows "a few".

Round 3 (2026-11-09) — job descriptions:

- [x] **H** A job description pasted as one paragraph ("… Requirements: … Nice to have: Kafka, Terraform.
  Responsibilities: …") lost all its sections, so every skill became "required" and the title was
  "Untitled role". Inline headings are now recognised, and comma lists become one requirement each.
- [x] **H** "5+ years Python", "at least five years of Python" and "minimum 3 years in machine learning" are
  experience requirements (they showed as "not stated"). The named skill must be in the resume; years are
  compared with overall experience, and the explanation says years per skill can't be measured.
- [x] **L** The JD title is never a bullet, a section heading or an "About us: …" line.
  10 regression cases; evaluation requirement accuracy unchanged (0.979). JD matcher → 1.2.0.

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

- [x] **H** Review rounds 1–4 merged into `main` (PR #1); CI green including both image scans.
- [x] **L** `e2e/smoke.mjs` regex fixed; `e2e/features-v2.mjs` accepts a recruiter or admin account and no longer races the bulk-upload list.
- [x] **L** Flaky AI-editor test: an item id made only of digits (about 1 in 110) was scrubbed as a phone number;
  ids are now left alone and the test is deterministic.
- [ ] **L** No LICENSE or CONTRIBUTING file (licence choice is the owner's); frontend dependencies use caret ranges.

### Security and privacy

- [x] **M** Resume content, extraction fields, AI suggestions, cover letters and application results are encrypted
  at rest (migration 0005, safe to re-run; stop the app while it runs). Cached analysis/match results and tracker
  notes are not encrypted yet (documented).
- [x] **M** Production requires valid `ENCRYPTION_KEYS`; decryption also accepts the key derived from `SECRET_KEY`
  and `ENCRYPTION_FALLBACK_SECRET_KEYS`, so changing keys no longer orphans data. Docs corrected.
- [x] **L** The API process no longer opens PDFs (page counting runs in the sandbox/worker); bulk upload has a time budget.
- [x] **L** Registration answers the same for new and existing emails; the existing owner gets an email instead.
- [x] **L** Common-password check normalises the password ("P@ssw0rd2024!" → "password") and now rejects common ones.
- [x] **L** Turning 2FA on/off or regenerating codes signs out other sessions; Google login passes the 2FA step in an HttpOnly cookie.
- [x] **L** Unverified accounts are deleted after `UNVERIFIED_ACCOUNT_RETENTION_DAYS`.

### Scoring and backend logic

- [x] **M** Retention counts from the resume's last activity and never deletes a resume with an open application.
- [x] **M** Per-task Celery time limits; the retention sweep commits every 200 rows and stops cleanly.
- [x] **M** `docs/EVALUATION.md` rewritten: three evaluation sets, v1's overstated numbers marked historical, score bands checked by a calibration table.
- [x] **M** Downloading a deleted file returns 404 on S3/SeaweedFS (missing keys raise `FileNotFoundError`).
- [x] **M** Extraction never exceeds schema limits (over-long fields are clipped and reported; bullets over 800
  characters no longer crash extraction).
- [x] **H** Text without line-separated headings: structure is recovered (glued headings, run-on sentences, dates)
  and evidence still points at the original text; text with no sections at all keeps its skills as "mentioned".
  Real resumes with jobs extracted: 0% → 99%; correct role first 40% → 68%.
- [x] **M** JD parsing: many more headings, boilerplate skipped, headline years = main requirement, recency windows
  ignored, better titles, prose sentences read for importance and years, flattened JDs repaired. Live postings:
  required-skill F1 0.75 → 0.83, years accuracy 0.57 → 0.83.
- [x] **M** Title/employer no longer swapped for non-tech titles; B.Ed, B.Des, MBBS, LLB, B.Pharm recognised.
- [ ] **M** JD titles on real postings are still weak (matches the posting's own title 14% of the time).
- [x] **L** Skill matcher finds "Dockerfiles", "ES6 and React", "to Spark", "R and Python" while everyday words stay prose.
- [ ] **L** Non-English headings (Spanish, German) lose all structure; a text PDF under 40 characters is rejected as
  unreadable; Wingdings-style bullets that come out of PDFs as "n " break entries.
- [x] **L** One coverage rule everywhere (shown in work 1, listed only 0.5); the preference boost is shown as a badge.
- [x] **L** A JD with nothing checkable is marked `basis: similarity_only`; a missing score shows "Not enough information".
- [x] **L** Races return 409; recruiter candidate lists are paginated; finished processing jobs are purged after 30 days.
- [x] **L** JD-match cache key includes the taxonomy version; stale openings and applications are re-read and rescored
  nightly (and JDs parsed by an older matcher are re-read on match).
- [ ] **M** Score bands: on synthetic data the "Good match" band (40–59) holds more unrelated pairs (55%) than
  related ones; thresholds need recalibration on real labels.

### Screens and experience

- [x] **M** Developer details hidden from candidates (AI cost, model/provider, rubric weights and versions, raw
  browser strings, "provider not configured"); recruiters and admins still see them. Fixture badge: "Sample response — not live AI".
- [x] **M** Hindi/Gujarati: dates and numbers follow the language; role names, seniority, rubric categories and other
  fixed labels are translated (`messages/terms.ts`). Free text written by the backend stays English.
- [ ] **M** Hindi/Gujarati translations still need review by native speakers (list in docs/TRANSLATIONS.md).
- [x] **M** Phones: the active resume tab scrolls into view; improvements show as cards on small screens.
- [x] **M** Form errors name the field and the problem ("Education 1 › Degree — …").
- [x] **M** Closed openings: badge and explanation, no tips or re-apply; withdraw still works.
- [x] **M** Every page has its own translated browser-tab title.
- [x] **M** Editor: section order collapsed, preview gets the width.
- [x] **L** Wrong links show "not found"; all destructive actions use an accessible in-app confirm dialog;
  "Rank openings" is disabled with a reason when there are none.
- [x] **L** Copy: greeting uses the first name, file-name titles ("p02") show "Untitled resume", correct singular/plural,
  landing page has a section for HR and recruitment firms.
- [x] **L** Accessibility: heading levels, arrow-key tabs, full-contrast disabled tabs with a lock icon.
- [x] **L** Only the active language is sent to the browser; static data cached; saved cover letters reopen;
  interview list filtered to the current resume.

### Deployment and operations

- [x] **M** Production deployment files: `deploy/docker-compose.prod.yml` (ENV=production, Caddy with automatic
  HTTPS, internal data network, read-only app containers, secrets from a git-ignored env file / Docker secret),
  daily verified `pg_dump` backups with retention, and a checksum-verified restore script.
- [x] **M** Compose reads `.env`; restart policies and resource limits everywhere; SeaweedFS identities built from
  env, the app key limited to its bucket (it can still list bucket names).
- [x] **M** Metrics: API workers report combined counters (multiprocess mode); the Celery worker has its own
  token-protected exporter.
- [x] **L** `.env.example` lists every setting with the code default; a test catches drift.
- [x] **L** API image 2.64 → 2.35 GB (tests/eval excluded, torch build leftovers removed); all base images digest-pinned.
- [ ] **L** Owner decisions before going live: domain and ACME email, an off-site backup bucket (dumps stay on
  the host by default), whether to encrypt dumps, backup retention (14 days) in the privacy notice, managed S3 vs
  self-hosted SeaweedFS (uploaded files are not backed up on a schedule yet).

### Already checked and sound

No user can read another user's data (every owned route checks ownership); sessions, tokens and
downloads are hashed, expiring and user-bound; uploads are type-checked and parsed in a sandbox; files
are encrypted; self-ID data is never used for ranking; AI prompts are pseudonymised and every AI
suggestion is checked against the resume before it can be accepted; account deletion covers every table;
database models match the migrations; the page layout is consistent with no sideways scrolling.
