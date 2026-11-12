# Operational dependencies & known limitations

## Dependencies

| Dependency | Required | Purpose | If unavailable |
|---|---|---|---|
| PostgreSQL 14+ (tested 16) | yes | system of record, durable job state | API not ready (`/api/health/ready` 503) |
| Redis 6+ (tested 7) | yes (prod) | Celery broker, shared rate limits | uploads queue but are not processed; `recover_stale_jobs` re-dispatches when back |
| S3-compatible storage | yes (prod) | private files | uploads/exports fail; analysis of existing versions still works |
| SMTP provider | yes (prod) | verification and reset emails | users cannot verify/reset |
| LLM provider (Anthropic/OpenAI) | optional | rewriting, cover letters, interview questions | AI actions return a clear 503; deterministic analysis, recommendations and matching unaffected; interview questions fall back to templates |
| Sentence Transformers + PyTorch | optional | semantic similarity | TF-IDF fallback, recorded as `embedding_model` |
| Tesseract + Poppler | optional | OCR for scanned PDFs | scanned PDFs fail with `scanned_pdf` and a clear message |
| Google OAuth client | optional | Google sign-in | button hidden |
| Learning-resource / job-listing providers | optional | resources, listings | explicit "unavailable" state; nothing is fabricated |
| Sentry | optional | error tracking | logs only |

Runbook entries:

- **Jobs stuck in `queued`/`running`:** check worker health and Redis; beat runs `recover_stale_jobs` every
  2 minutes; admins can trigger `POST /api/admin/jobs/recover`.
- **LLM outage:** `ri_llm_calls_total{outcome="error"}` rises; set `LLM_PROVIDER=disabled` to stop calls
  cleanly — the UI shows AI as unavailable and everything else keeps working.
- **Cost spike:** lower `AI_REQUESTS_PER_DAY` / `AI_MONTHLY_COST_LIMIT_USD`; usage per provider is on the admin dashboard.
- **Backups failing:** the `db-backup` container is unhealthy when no dump succeeded for 26 h;
  `docker compose -f deploy/docker-compose.prod.yml logs db-backup` shows the error (database unreachable,
  disk full). Restore procedure: DEPLOYMENT.md, "Restore (compose stack)".
- **Certificate problems:** `docker compose -f deploy/docker-compose.prod.yml logs caddy`; DNS must point at the
  host and ports 80/443 must be open. Certificates are kept in the `caddy_data` volume.
- **Container restarted on its memory limit** (`docker inspect <container> --format '{{.State.OOMKilled}}'`):
  raise the `deploy.resources.limits.memory` of that service, or lower `--concurrency` / `WEB_CONCURRENCY`.
- **Key rotation:** prepend a new key to `ENCRYPTION_KEYS`, deploy; data is re-encrypted lazily on write
  (old keys stay for reads, so never remove a key that still protects data). Rotating `SECRET_KEY` does not
  touch encrypted data **when `ENCRYPTION_KEYS` is set** (always in production), but it invalidates download
  links, Google sign-in state and everyone's 2FA **recovery codes** (keyed hashes; users must generate new
  ones), and audit-log IP hashes stop matching older entries. To keep them (and, without `ENCRYPTION_KEYS`,
  the data key derived from `SECRET_KEY`) working, put the old value in `ENCRYPTION_FALLBACK_SECRET_KEYS`.
- **"Unable to decrypt stored data" after an upgrade (development):** the effective `SECRET_KEY` changed and
  no `ENCRYPTION_KEYS` is set. The old compose default (`dev-insecure-change-me-dev-insecure-change-me`) and
  the config default are accepted automatically outside production; any other earlier value must be listed
  in `ENCRYPTION_FALLBACK_SECRET_KEYS`. Better: set `ENCRYPTION_KEYS` and keep `SECRET_KEY` fixed in `.env`.
- **Retention sweep stopped by its time limit:** each batch of 200 rows is committed, so finished work stays
  done and the next nightly run continues; `retention.time_limit` is logged. Run it by hand with
  `celery -A app.worker.celery_app call ri.retention_sweep` if a backlog built up.
- **Worker time limits:** parse/export jobs 75 s soft / 105 s hard (`PARSE_TIMEOUT_SECONDS` + 30 / + 60),
  stale-job recovery 60/90 s, queue gauge 20/30 s, job alerts 10/11 min, retention sweep 55/60 min
  (`app/worker/tasks.py`).

## Known limitations

**Extraction & analysis**
- Rule-based extraction is tuned on clean, single-column layouts. Multi-column PDFs, text boxes, tables
  used for layout, icons and creative templates may extract poorly; such fields are flagged as uncertain
  and the user must correct them in review. English headings only.
- DOCX has no fixed pagination, so page count is not reported for DOCX.
- Formatting checks are limited to properties read from the file; no visual layout analysis.
- Non-Latin glyphs (e.g. ₹, Devanagari) are not in the built-in PDF export fonts; register a Unicode TTF
  font in `services/export/render.py` for those markets.
- Exported PDFs have selectable text and document metadata but are not fully tagged (PDF/UA).

**Recommendations & matching**
- Role taxonomy covers 12 technology roles; other professions get low-confidence or insufficient-evidence results.
- Fit scores and compatibility indicators are heuristic and uncalibrated. Role fit scores compare roles for one
  resume. For one opening, the compatibility indicator is computed identically for every applicant, so it is
  used to *order* applicants ("where I stand", recruiter ranking), but differences of a few points are not
  meaningful and it has not been validated against hiring outcomes. Recruiters are told to use it to
  prioritise reading, never to auto-reject.
- Fairness monitoring depends on voluntary self-identification; with low participation, groups under 10, or
  only one group large enough, it shows nothing. It is a daily snapshot, so today's changes appear tomorrow. The counterfactual test proves identity fields do not move scores, but cannot rule out
  proxies inside the work history itself (e.g. career gaps).
- Seniority is inferred from dated experience only.
- Location and work-arrangement preferences are recorded but not used for ranking (no listings provider).

**AI**
- Grounding is presence-based: a real value placed in the wrong context is not detected; capitalised-word
  checks can produce false positives that the user resolves by confirming or editing.
- The fixture provider is rule-based and exists only for development; production refuses it.
- Prompt-injection defences reduce but cannot eliminate risk; grounding and user acceptance are the backstop.

**Evaluation**
- Only a 12-persona synthetic dataset is included; there are no real-data results. See EVALUATION.md.

**Platform**
- Resource limits for the parser child process (CPU, memory, file descriptors) are enforced on Linux/macOS;
  on Windows only the wall-clock timeout applies. Production containers run on Linux.
- Prometheus metrics are per container (all processes of one api or worker container are added up); with
  several replicas, sum across scrape targets. The worker's metrics files grow by one per recycled pool child
  until the container restarts (small sparse files; restarting clears them).
- Google OAuth is implemented with Authlib but was not exercised end-to-end (requires real client credentials).
- Job alerts are evaluated when an opening is posted or reopened, by scanning opted-in users; fine for
  thousands of users, but a large deployment should move this to a batched/indexed job.
- Learning resources are a bundled list of official documentation links, link-checked on 2026-11-08; links
  can break later. Re-run the check before releases or point `LEARNING_RESOURCES_FILE` at a maintained list.
