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

On a platform with managed PostgreSQL / Redis / S3, use the topology above. For a single Docker host,
`deploy/docker-compose.prod.yml` runs the whole stack with automatic HTTPS and scheduled backups: see
[Single-host production (Docker Compose)](#single-host-production-docker-compose).

## Required production configuration

`ENV=production` refuses to start unless these hold (`backend/app/config.py`, `_production_guards`):

- `SECRET_KEY` random ≥ 32 chars; `ENCRYPTION_KEYS` set to valid Fernet keys, newest first
  (`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`). The data key
  must not depend on `SECRET_KEY`: without `ENCRYPTION_KEYS` (allowed only outside production) it is derived
  from `SECRET_KEY`, and rotating that secret would make every encrypted file and column unreadable.
- `COOKIE_SECURE=true` (TLS everywhere), `TASK_ALWAYS_EAGER=false`
- `DATABASE_URL` is PostgreSQL; `STORAGE_BACKEND=s3`
- `RATE_LIMIT_BACKEND=redis`; `EMAIL_BACKEND=smtp` (+ `SMTP_*`)
- `PUBLIC_BASE_URL` and every `CORS_ORIGINS` entry use `https://`
- `METRICS_TOKEN` set (or `METRICS_ENABLED=false`); `REQUIRE_MFA_FOR_STAFF=true`
- `LLM_PROVIDER` is `anthropic`, `openai` or `disabled` (never `fixture`); `LLM_MODEL` set for a real provider

Also set: `API_BASE_URL`, `TRUSTED_PROXIES=1`, `SENTRY_DSN` (optional), `ADMIN_EMAILS`. Every setting, with
its default, is listed in `.env.example`. **The edge proxy (load balancer / Caddy / nginx) must overwrite
`X-Forwarded-For` with the connecting client's address**, not append to a value the client sent (nginx:
`proxy_set_header X-Forwarded-For $remote_addr;`; the bundled Caddyfile does this). Next.js passes an existing
`X-Forwarded-For` through unchanged, so without that rule a visitor can choose the IP that per-IP rate limits see.
Per-account limits (wrong passwords, wrong 2FA codes, reset emails) do not depend on the IP and hold either way.
Keep secrets in your platform's secret manager (AWS Secrets Manager, GCP Secret Manager, Vault, Kubernetes
Secrets with encryption at rest) or, on a single host, in the git-ignored `deploy/.env`; never bake them into images.

Bucket policy: block all public access; allow the app role `s3:GetObject/PutObject/DeleteObject/ListBucket`
on the bucket only; enable default SSE (SSE-S3 or SSE-KMS → set `S3_SSE=aws:kms`), versioning, and a
lifecycle rule expiring noncurrent versions after 30 days (so deletions become permanent).

## Single-host production (Docker Compose)

`deploy/docker-compose.prod.yml` is a self-contained production stack for one Linux host with Docker
Compose ≥ 2.24:

```
Internet ─▶ caddy :80/:443 (automatic HTTPS, HSTS, refuses /api/metrics) ─▶ frontend :3000 ─▶ api :8000
api, worker, beat ─▶ postgres · redis (password) · s3 (SeaweedFS)       ◀── `data` network: internal, no internet
db-backup ─▶ pg_dump daily ─▶ pgbackups volume ─(profile offsite)─▶ another S3 bucket
```

| File | Purpose |
|---|---|
| `deploy/docker-compose.prod.yml` | the stack: `ENV=production`, restart policies, CPU/memory limits, log rotation, read-only app containers, no host ports except 80/443 |
| `deploy/caddy/Caddyfile` | TLS reverse proxy; obtains and renews certificates for `DOMAIN`; overwrites `X-Forwarded-For` |
| `deploy/env.production.example` | template for `deploy/.env` (git-ignored) with every value the production guards need |
| `deploy/seaweedfs/entrypoint.sh` | writes the S3 identities from the environment; the app's key gets Read/Write/List on the bucket only |
| `deploy/backup/pg-backup.sh`, `pg-restore.sh` | scheduled, verified `pg_dump` with retention; restore |

### First start

```bash
cp deploy/env.production.example deploy/.env && chmod 600 deploy/.env
# fill in DOMAIN, ACME_EMAIL, the https URLs, every secret (generation commands are in the file) and SMTP_*
mkdir -p deploy/secrets && chmod 700 deploy/secrets
python -c "import secrets; print(secrets.token_urlsafe(32))" > deploy/secrets/s3_admin_secret_access_key
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml ps        # every service healthy within ~2 minutes
```

DNS for `DOMAIN` must point at the host and ports 80 and 443 must be reachable for the certificate. Keep the
`caddy_data` volume (certificates, ACME account) across upgrades.

**Secrets.** Nothing secret is in git. Application secrets live in `deploy/.env`, which Compose reads to fill in
the file and passes to api/worker/beat only (other services get only the variables they need). The SeaweedFS
admin key, which only creates the bucket, is a Docker secret mounted into `s3` and `s3-init` only; the app's S3
key cannot create or delete buckets or reach other buckets. Passwords are put into connection URLs, so generate
them URL-safe (`secrets.token_urlsafe`). Keep an offline copy of `deploy/.env` (above all `ENCRYPTION_KEYS`) in
your password manager or secret store.

**Upgrades.** Take a backup first
(`docker compose -f deploy/docker-compose.prod.yml exec db-backup sh /scripts/pg-backup.sh once`), then
`git pull && docker compose -f deploy/docker-compose.prod.yml up -d --build`; the api container applies
migrations on start.

**Managed services instead.** For AWS S3 (or another provider) set `S3_ENDPOINT_URL=` (empty for AWS),
`S3_REGION`, `S3_SSE=AES256` and the app's key in `deploy/.env`, and remove the `s3` / `s3-init` services and
`api`'s dependency on `s3-init`. A managed PostgreSQL works the same way: override `DATABASE_URL`, remove
`postgres`, and point `db-backup`'s `PG*` variables at it (or rely on the provider's backups).

**Local trial.** `DOMAIN=localhost` makes Caddy use its own CA (browsers warn; use `curl -k`). Run it next to
the dev stack with `docker compose -p <name>`, `HTTP_PORT`/`HTTPS_PORT` and
`PUBLIC_BASE_URL=https://localhost:<HTTPS_PORT>`. Production refuses console email, so add an SMTP catcher
(e.g. Mailpit on the `app` network) for a trial.

## Release checklist

1. CI green (tests on SQLite + PostgreSQL, `alembic check`, audits, Trivy).
2. Build and push `backend` (`--build-arg INSTALL_ML=true`) and `frontend` images, tagged by git SHA.
3. Run `alembic upgrade head` as a release job. Migrations are forward-compatible with the previous app
   version (additive first, destructive changes in a later release), except where noted below. The release
   job needs the same `ENCRYPTION_KEYS` as the app.
   - **0005 (encrypts resume content at rest)** rewrites every resume version, extraction, AI suggestion,
     career artefact and opening application in one transaction, and the previous app version cannot read
     the encrypted columns: stop api/worker/beat (or put the site in maintenance) while it runs, then deploy
     the new version. Rough cost: a few seconds per 10,000 rows. `alembic downgrade 0004` decrypts again.
4. Roll out api → worker → beat. Check `/api/health/ready` and the admin dashboard.

## Observability

- **Logs:** JSON to stdout with `request_id`; content-like keys are redacted. Ship to your log platform. The
  production compose file rotates container logs (json-file, 5 × 20 MB per container).
- **Metrics:** `ri_http_requests_total`, `ri_http_request_seconds`, `ri_job_seconds`, `ri_job_failures_total`,
  `ri_queue_depth`, `ri_llm_calls_total`, `ri_llm_cost_usd_total`, `ri_llm_seconds`. Two scrape targets per
  replica, both requiring `Authorization: Bearer $METRICS_TOKEN` (required in production):
  - **api:** `GET http://api:8000/api/metrics`. The website does not forward this path (the Next.js rewrite and
    Caddy both refuse it), so scrape the API on the internal network.
  - **worker:** `GET http://worker:9100/metrics` (`WORKER_METRICS_PORT`, 9100 in both compose files; 0 = off).
    Background-job durations and failures, and LLM calls made by jobs, are recorded here.

  Each container adds up its own processes: the image sets `PROMETHEUS_MULTIPROC_DIR=/tmp/ri-metrics`
  (prometheus_client multiprocess mode), so one scrape returns the total over all uvicorn workers or all Celery
  pool children, not just the process that answered. Compose mounts a tmpfs there, so it starts empty on every
  container start. Celery replaces pool children every 200 tasks; their files stay so counters never go
  backwards, until the container restarts. Scrape every replica (Prometheus labels them by `instance`);
  `ri_queue_depth` is read from the database and is the same on every target.

  ```yaml
  # prometheus.yml: Prometheus attached to the compose `app` network (or with access to it)
  scrape_configs:
    - job_name: ri-api
      metrics_path: /api/metrics
      authorization: { credentials_file: /etc/prometheus/ri_metrics_token }
      static_configs: [{ targets: ["api:8000"] }]
    - job_name: ri-worker
      authorization: { credentials_file: /etc/prometheus/ri_metrics_token }
      static_configs: [{ targets: ["worker:9100"] }]
  ```
- **Suggested alerts:** 5xx rate > 2% for 5 min; p95 latency > 2 s; `ri_queue_depth{status="queued"}` > 50
  for 10 min; job failure rate > 10%; LLM error rate > 20%; daily LLM cost above budget; `db-backup`
  container unhealthy (no successful backup in 26 h).
- **Errors:** set `SENTRY_DSN` (PII sending disabled).
- **Health:** `/api/health/live` (process up), `/api/health/ready` (DB, Redis, storage).

## Backup & restore

| Data | Backup | Restore |
|---|---|---|
| PostgreSQL | Managed automated backups + PITR (≥ 7 days), or nightly `pg_dump -Fc` to a separate, encrypted bucket (the compose stack's `db-backup` service) | see below |
| Object storage | Bucket versioning + cross-region replication, or nightly `aws s3 sync` to a backup bucket | sync back |
| Encryption keys | **Back up `ENCRYPTION_KEYS` separately** in the secret manager. Without them, files and encrypted columns are unrecoverable. | — |
| Redis | Not a system of record (jobs live in PostgreSQL). AOF on for broker durability only. | — |

### Scheduled backups in the compose stack

The `db-backup` service runs `deploy/backup/pg-backup.sh`: `pg_dump -Fc` every day at `BACKUP_TIME` (UTC,
default 02:30), and once at start when the newest dump is older than a day. Each dump is checked with
`pg_restore --list` before it is kept and gets a `.sha256` file. Dumps older than `BACKUP_KEEP_DAYS` (default 14)
are deleted, and only after a successful backup, so a failing job never empties the directory. The container
turns **unhealthy** when no backup has succeeded for 26 hours.

```bash
C="docker compose -f deploy/docker-compose.prod.yml"
$C exec db-backup sh /scripts/pg-backup.sh once          # back up now (e.g. before an upgrade)
$C exec db-backup ls -l /backups                         # list dumps
$C logs db-backup                                        # schedule, results, expired files
```

The dumps are in the `pgbackups` volume **on the same host**, which does not protect against losing the host.
Copy them elsewhere: set `BACKUP_S3_URI` and `BACKUP_S3_*` in `deploy/.env` and add `--profile offsite` (the
`backup-offsite` service mirrors the directory to that bucket every hour), or copy the volume with your own job.
Dumps contain personal data, so the target bucket must be private and encrypted, with a lifecycle rule that
matches your retention period.

Uploaded files are in the `s3data` volume (SeaweedFS), already encrypted by the app. Back them up with a volume
snapshot or `aws s3 sync` using the admin key, and back up `ENCRYPTION_KEYS` separately.

### Restore (compose stack)

```bash
C="docker compose -f deploy/docker-compose.prod.yml"
$C stop caddy frontend api worker beat                   # nothing may write during the restore
$C exec db-backup ls -l /backups                         # pick ri-<timestamp>.dump
$C exec db-backup sh /scripts/pg-restore.sh /backups/ri-YYYYMMDDTHHMMSSZ.dump
#   verifies the .sha256, then pg_restore --clean --if-exists --single-transaction (all or nothing)
$C up -d                                                 # api runs alembic upgrade head on start
# then, as an admin: POST /api/admin/jobs/recover to re-dispatch jobs interrupted by the restore
```

A dump fetched back from offsite storage goes into the volume first:
`docker cp ri-<timestamp>.dump "$($C ps -q db-backup)":/backups/`. On a new host, start only `postgres` and
`db-backup` (`$C up -d postgres db-backup`), restore, then start the rest.

### Other platforms

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

Compose runs PostgreSQL (not published on the host), Redis, SeaweedFS S3 (+ private bucket init), Mailpit, api,
worker, beat and frontend. Ports bind to 127.0.0.1 only (`FRONTEND_HOST_PORT`, `API_HOST_PORT` and
`MAILPIT_HOST_PORT` change them).

- **`.env` reaches api, worker and beat** (`env_file`; optional). The compose file then overrides what it needs
  to wire the containers together (database, Redis, S3, Mailpit, URLs, `ENV=development`).
- **S3:** SeaweedFS gets two identities from the environment (`deploy/seaweedfs/entrypoint.sh`): an admin key
  used only by `s3-init` to create the bucket, and the app's key with Read/Write/List on `S3_BUCKET` only.
  Without values in `.env`, dev-only defaults are used.
- Restart policies (`unless-stopped`) and CPU/memory limits are set per service (api and worker 3 GB each, sized
  for Sentence Transformers).
- Images are pinned by digest (`image:tag@sha256:…`), as are the `FROM` lines of both Dockerfiles. To refresh a
  pin: `docker buildx imagetools inspect <image:tag> --format '{{.Manifest.Digest}}'`, then rebuild and re-run
  the Trivy scan.

The frontend image resolves its `/api` rewrite at **build time** (`--build-arg BACKEND_URL=...`).

Verified end to end on 2026-11-07 with `python backend/scripts/smoke.py` against this stack (Celery worker,
Redis, SeaweedFS S3, Mailpit SMTP, Sentence Transformers image). MinIO is not used because its community
images are no longer published; any S3-compatible store works.
