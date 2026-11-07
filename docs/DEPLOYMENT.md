# Deployment

## Topology

```
Internet ─▶ TLS load balancer / ingress ─┬─▶ frontend (Next.js, :3000)   ── /api/* rewrite ──┐
                                          └─▶ api (FastAPI/uvicorn, :8000) ◀──────────────────┘
api, worker, beat ─▶ PostgreSQL 16 (managed, encrypted, PITR)
                  ─▶ Redis 7 (broker + rate limits; TLS, persistence on)
                  ─▶ S3 bucket (private, SSE, versioning, lifecycle for exports/)
                  ─▶ SMTP provider · optional LLM provider · optional Sentry
```

Run **one image** (`backend/Dockerfile`) as three process types:

| Process | Command | Scale |
|---|---|---|
| api | default `CMD` (runs `alembic upgrade head`, then uvicorn) | ≥2 replicas; ~1 vCPU / 1 GB each (2 GB with Sentence Transformers) |
| worker | `celery -A app.worker.celery_app worker --concurrency=2 -O fair` | scale on `ri_queue_depth{status="queued"}` |
| beat | `celery -A app.worker.celery_app beat` | **exactly one** replica |

For multiple api replicas, run migrations as a one-off release job instead of in `CMD`
(`alembic upgrade head`) and start uvicorn directly.

## Required production configuration

`ENV=production` refuses to start unless these hold:

- `SECRET_KEY` random ≥ 32 chars; `ENCRYPTION_KEYS` set (Fernet keys, newest first)
- `COOKIE_SECURE=true` (TLS everywhere), `TASK_ALWAYS_EAGER=false`
- `DATABASE_URL` is PostgreSQL; `STORAGE_BACKEND=s3`
- `LLM_PROVIDER` is `anthropic`, `openai` or `disabled` (never `fixture`)

Also set: `PUBLIC_BASE_URL`, `API_BASE_URL`, `CORS_ORIGINS`, `TRUSTED_PROXIES` (number of proxies in front — the
Next.js server counts as one, so behind a load balancer use 2; per-IP rate limits otherwise see every user as the proxy's IP;
never set it higher than the real number of proxies or clients can spoof `X-Forwarded-For`),
`RATE_LIMIT_BACKEND=redis`, `EMAIL_BACKEND=smtp` + SMTP settings, `METRICS_TOKEN`, `SENTRY_DSN` (optional),
`ADMIN_EMAILS`. Keep secrets in your platform's secret manager (AWS Secrets Manager, GCP Secret Manager,
Vault, Kubernetes Secrets with encryption at rest) — never bake them into images.

Bucket policy: block all public access; allow the app role `s3:GetObject/PutObject/DeleteObject/ListBucket`
on the bucket only; enable default SSE (SSE-S3 or SSE-KMS → set `S3_SSE=aws:kms`), versioning, and a
lifecycle rule expiring noncurrent versions after 30 days (so deletions become permanent).

## Release checklist

1. CI green (tests on SQLite + PostgreSQL, `alembic check`, audits, Trivy).
2. Build and push `backend` (`--build-arg INSTALL_ML=true`) and `frontend` images, tagged by git SHA.
3. Run `alembic upgrade head` as a release job. Migrations are forward-compatible with the previous app
   version (additive first, destructive changes in a later release).
4. Roll out api → worker → beat. Check `/api/health/ready` and the admin dashboard.

## Observability

- **Logs:** JSON to stdout with `request_id`; content-like keys are redacted. Ship to your log platform.
- **Metrics** (`GET /api/metrics`, bearer `METRICS_TOKEN`): `ri_http_requests_total`, `ri_http_request_seconds`,
  `ri_job_seconds`, `ri_job_failures_total`, `ri_queue_depth`, `ri_llm_calls_total`, `ri_llm_cost_usd_total`,
  `ri_llm_seconds`. Note: Prometheus counters are per process; scrape each api/worker replica.
- **Suggested alerts:** 5xx rate > 2% for 5 min; p95 latency > 2 s; `ri_queue_depth{status="queued"}` > 50
  for 10 min; job failure rate > 10%; LLM error rate > 20%; daily LLM cost above budget.
- **Errors:** set `SENTRY_DSN` (PII sending disabled).
- **Health:** `/api/health/live` (process up), `/api/health/ready` (DB, Redis, storage).

## Backup & restore

| Data | Backup | Restore |
|---|---|---|
| PostgreSQL | Managed automated backups + PITR (≥ 7 days), or nightly `pg_dump -Fc` to a separate, encrypted bucket | see below |
| Object storage | Bucket versioning + cross-region replication, or nightly `aws s3 sync` to a backup bucket | sync back |
| Encryption keys | **Back up `ENCRYPTION_KEYS` separately** in the secret manager. Without them, files and encrypted columns are unrecoverable. | — |
| Redis | Not a system of record (jobs live in PostgreSQL). AOF on for broker durability only. | — |

```bash
# backup
pg_dump --format=custom --no-owner "$DATABASE_URL_PSQL" > ri-$(date +%F).dump
aws s3 sync s3://resume-intelligence-private s3://ri-backups/objects-$(date +%F)

# restore into an empty database (stop api/worker/beat first)
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL_PSQL" ri-YYYY-MM-DD.dump
aws s3 sync s3://ri-backups/objects-YYYY-MM-DD s3://resume-intelligence-private
alembic upgrade head        # bring schema to the deployed version
# start services, then: POST /api/admin/jobs/recover to re-dispatch interrupted jobs
```

Test restores quarterly into an isolated environment. **Deletion and backups:** deleted accounts persist in
backups until those expire; document the backup retention period in your privacy notice and, on restore,
re-apply deletions recorded in `audit_logs` (`action = 'account.deleted'`) before reopening the service.

## Local Docker Compose

```bash
cp .env.example .env
docker compose up --build        # INSTALL_ML=false in .env for a smaller, faster image (TF-IDF embeddings)
```

Compose runs PostgreSQL (not published on the host), Redis, SeaweedFS S3 (+ private bucket init), Mailpit, api, worker, beat and frontend.
Ports bind to 127.0.0.1 only.

The frontend image resolves its `/api` rewrite at **build time** (`--build-arg BACKEND_URL=...`).

Verified end to end on 2026-11-07 with `python backend/scripts/smoke.py` against this stack (Celery worker,
Redis, SeaweedFS S3, Mailpit SMTP, Sentence Transformers image). MinIO is not used because its community
images are no longer published; any S3-compatible store works.
