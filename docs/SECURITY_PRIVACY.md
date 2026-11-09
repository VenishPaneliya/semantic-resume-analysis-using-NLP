# Security & privacy

## Threat model (summary)

| Threat | Controls |
|---|---|
| Account takeover | Argon2id passwords, password policy, login rate limits per IP and a per-account limit on wrong passwords (10 per 15 min, independent of IP), reset emails capped per address, opaque server-side sessions (SHA-256 hashed tokens) in `HttpOnly; SameSite=Lax; Secure` cookies, all sessions revoked on reset, other sessions revoked on password change, session list + revoke |
| CSRF | Double-submit token (`ri_csrf` cookie ↔ `x-csrf-token` header) on every authenticated unsafe request, plus SameSite cookies and strict CORS |
| Cross-user access (IDOR) | Every object lookup goes through `get_owned()`, which returns **404** for other users' IDs; covered by `tests/test_isolation.py` across all resource types |
| User enumeration | Identical responses for forgot-password; constant-work password verification |
| Malicious documents | Extension + declared MIME + magic bytes; size, page-count and DOCX expansion limits; zip-bomb ratio check; macro (`vbaProject.bin`), encrypted and path-traversal containers rejected; PDF active content (`/JavaScript`, `/Launch`) never executed and flagged; parsing in a **child process** with timeout, CPU and address-space limits (POSIX), no secrets in its environment |
| Prompt injection | Resume/JD text is treated as untrusted data: wrapped in tagged blocks with delimiter characters neutralised, system prompt forbids following embedded instructions, outputs must validate against a schema, unknown target IDs are discarded, every claim is checked by the deterministic grounding verifier, and instruction-like text in uploads is flagged to the user |
| Data exfiltration via AI provider | Contact block (name, email, phone, location, links) is removed before sending; only the sections needed for the operation are sent; explicit per-provider consent is required; consent is invalidated if the provider changes |
| Abuse / cost | Per-IP and per-user rate limits, daily upload quota, daily AI request quota, monthly AI cost cap, token and cost accounting per call |
| Storage compromise | Files and sensitive text columns (raw resume text, JD text) are Fernet-encrypted by the application (key rotation via `ENCRYPTION_KEYS`); S3 SSE on top; private bucket; downloads only via short-lived (default 5 min) signed tokens bound to the requesting user |
| Output injection (XSS) | API returns JSON only with `nosniff`, `default-src 'none'` CSP and `X-Frame-Options: DENY`; React escapes text; links are restricted to http(s)/mailto; exported documents escape all text |
| Supply chain | Pinned constraints, `pip-audit`, `npm audit`, Trivy image scans in CI; non-root container user; model weights baked at build time (no runtime downloads) |

## Encryption

- **In transit:** terminate TLS at the load balancer/ingress; set `COOKIE_SECURE=true` (enforced when
  `ENV=production`) — the API then sends HSTS. Use TLS to PostgreSQL (`?sslmode=require`) and Redis (`rediss://`).
- **At rest:** application-level Fernet for stored files and the free-text columns `extractions.raw_text`
  and `job_descriptions.raw_text`, plus storage-level encryption (S3 SSE, encrypted PostgreSQL volumes /
  managed DB encryption). **Structured resume content** (`resume_versions.content`, derived analyses)
  is stored as JSONB so it can be validated and diffed; it relies on database-level encryption — enable
  it on your PostgreSQL volume or managed instance. Production refuses to start
  without `ENCRYPTION_KEYS`. Rotate by prepending a new key; old keys remain for decryption.

## AI data disclosure (shown to users in Settings → Privacy)

- Which provider and model receive data (`GET /api/account/privacy`).
- What is sent: only the resume sections needed for the requested edit (and the job description when
  tailoring), with contact details removed.
- Nothing is sent when the provider is `fixture` or `disabled`.
- Uploaded resumes are **not used for model training** (`allow_training_use` defaults to false). Check
  your provider's API data-usage terms and configure zero-retention where available.

## Two-factor authentication

- TOTP (RFC 6238; any authenticator app) with 10 single-use recovery codes stored as keyed hashes.
  Login becomes two steps: password → 5-minute single-use token → code. An accepted code can't be replayed
  (`totp_last_step`). Wrong codes are counted per account wherever a code is entered (sign-in, turning 2FA off,
  new recovery codes): after 10 in an hour further attempts are refused, and one sign-in attempt is cancelled
  after 5 wrong codes, so the password must be entered again. Data exports never contain the 2FA secret,
  recovery-code hashes or password hash.
- **Staff must use it:** with `REQUIRE_MFA_FOR_STAFF=true` (default; mandatory in production) recruiter and
  admin APIs return `403 mfa_required` until 2FA is on, because staff can read many candidates' data.
- Google sign-in also requires the second step when 2FA is on.

## Recruiter access to candidate data

- Recruiters see a candidate only if the candidate applied to that opening and ticked the sharing consent,
  or the recruiter bulk-uploaded the resume after attesting the person agreed to be considered.
- Bulk-uploaded candidates have no account: only the extracted content is kept (encrypted, no original file)
  and it is deleted after `BULK_UPLOAD_RETENTION_DAYS` (default 90) by the nightly sweep, or earlier by staff.
- Uploaded candidates never affect applicants' "where I stand" figures.
- Recruiter notes are encrypted and never shown to candidates. Viewing a candidate, comparing, changing a
  stage, uploading and viewing fairness reports are audit-logged.
- Candidates see only their own rank, the applicant count, the median and an anonymous histogram, and only
  once 3+ people applied.

## Voluntary self-identification (fairness monitoring)

- Optional gender and age band, with explicit consent, stored encrypted in a separate table.
- Never read by ranking, matching, tips or recruiter candidate views (a test asserts scores are identical
  with and without it, and that it does not appear in the recruiter's candidate detail).
- The report is **admin-only** (recruiters move candidates between stages, so they must not also see group
  outcomes) and every view is audit-logged.
- It is a snapshot as of the start of the current UTC day, so moving one candidate and reloading reveals
  nothing. A breakdown appears only when at least 2 groups each have 10 or more people (one group alone would
  reveal everyone's answer), and no counts of hidden or self-identified people are returned.
- It applies the four-fifths rule as a prompt to investigate, not as proof of bias. Users can delete it at any time; it is included in export
  and removed on account deletion.

## Retention & deletion

- `FILE_RETENTION_DAYS` / `ANALYSIS_RETENTION_DAYS` are enforced by the nightly `retention_sweep` beat task.
  Exports are removed after 30 days.
- **Document deletion** removes the original file (unless a variant still references it), all versions,
  extraction, analyses, recommendations, JD matches, AI suggestions, exports and processing jobs.
- **Account deletion** removes everything above plus JDs, applications, career artefacts, sessions,
  tokens and every object under `users/{id}/` in storage. Usage events are kept anonymised (user id
  nulled) for aggregate cost reporting; a content-free audit record of the deletion is kept.
- **Data export** (`GET /api/account/export`) returns a ZIP of all records plus original uploads, including
  opening applications, learning plan, mock interviews, job alerts sent and self-identification.
- Mock interview answers and recruiter notes are free text and are encrypted at rest.

## Audit logging

`audit_logs` stores action, user id, target type/id, a keyed hash of the IP and a small allow-listed
metadata set. Resume and JD content can never be written to it (non-allow-listed keys are dropped),
and the structured logger redacts content-like keys.

## Reporting vulnerabilities

Report privately to the maintainers; do not open public issues for security problems.
