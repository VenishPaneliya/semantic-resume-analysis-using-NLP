# Resume Intelligence — frontend

Next.js 15 (App Router) + TypeScript (strict) + Tailwind CSS 4. Talks to the FastAPI backend through a
same-origin rewrite (`/api/*` → `$BACKEND_URL/api/*`), so the HTTP-only session cookie stays first-party.
Unsafe requests send `x-csrf-token` from the `ri_csrf` cookie (double-submit). See `src/lib/api.ts`.

## Run

```bash
npm install
BACKEND_URL=http://localhost:8000 npm run dev      # http://localhost:3000
```

Note: rewrites are resolved at build time for `next build`/`next start`; set `BACKEND_URL` before building.

## Checks

```bash
npx tsc --noEmit
npm run lint
npm run build
```

## End-to-end smoke test (Playwright)

Requires a running backend with `EMAIL_BACKEND=console` whose stdout is written to a log file (the
verification link is read from it) and a running frontend.

```bash
npx playwright install chromium
BASE_URL=http://localhost:3000 BACKEND_LOG=e2e/backend.log RESUME_PDF=e2e/fixtures/resume.pdf node e2e/smoke.mjs
```

Covers register → verify → upload → review/confirm → analysis → roles → JD match → AI suggestion accept
(fixture provider, badge asserted) → history → PDF export/download → career/applications/settings →
390px mobile overflow check → no uncaught page errors. Screenshots land in `e2e/screenshots/`.
`e2e/fixtures/resume.pdf` is synthetic (persona p02 from `backend/data/synthetic`).

## Structure

- `src/app/(auth)/*` — login, register, verify-email, forgot/reset password
- `src/app/(app)/dashboard` — uploads (XHR progress), processing polling, retry
- `src/app/(app)/resumes/[id]/{review,analysis,roles,match,editor,career}`
- `src/app/(app)/{applications,settings,admin}`
- `src/components/` — `ui.tsx` primitives (incl. `FixtureBadge`, `AIBadge`), `content-form.tsx`
  (structured resume form shared by review + editor), `preview.tsx` (live preview, diff), `suggestion-card.tsx`
- `src/lib/` — API client, hooks, response types
