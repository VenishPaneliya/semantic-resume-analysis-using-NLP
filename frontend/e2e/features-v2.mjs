// E2E for the v2 features: staff 2FA, shortlisting filters, comparison, notes, pipeline board, bulk upload,
// HR analytics, fairness monitoring, what-if scoring, job alerts, learning plan, resume health history,
// mock interviews and voluntary self-ID.
// Usage (from frontend/):
//   BASE_URL=http://localhost:3011 BACKEND_LOG=<backend log> node e2e/features-v2.mjs
// Backend: ADMIN_EMAILS=hr@example.com (admins can do everything recruiters can, and the fairness report is admin-only;
// RECRUITER_EMAILS=hr@example.com alone also works, then the fairness checks are skipped) REQUIRE_MFA_FOR_STAFF=true EMAIL_BACKEND=console LLM_PROVIDER=fixture,
// demo openings seeded. Verification tokens are read from the backend log; TOTP codes are computed here.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshCode, loadSecret, saveSecret } from "./totp.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3011";
const LOG = process.env.BACKEND_LOG ?? "e2e/backend-v2.log";
const FIX = "e2e/fixtures/personas";
const OUT = "e2e/screenshots";
const HR_EMAIL = process.env.HR_EMAIL ?? "hr@example.com";
const HR_TOTP_FILE = process.env.HR_TOTP_FILE ?? path.join(os.tmpdir(), "ri-e2e-hr-totp.json"); // outside the project so `next dev` does not recompile
const FAIRNESS_SEED = Number(process.env.FAIRNESS_SEED ?? 20); // self-identified applicants to create (0 = skip)
// Screenshots are written outside the project during the run (files appearing under frontend/ make `next dev`
// recompile and sometimes full-reload the page mid-test) and copied into e2e/screenshots at the end.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "ri-e2e-shots-"));
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const password = "Correct-horse-42";
const results = [];
let step = "";

async function check(name, fn) {
  step = name;
  const t0 = Date.now();
  try {
    await fn();
    results.push(["PASS", name]);
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push(["FAIL", name, e.message.split("\n")[0]]);
    console.log(`FAIL  ${name}: ${e.message.split("\n")[0]}`);
    throw e;
  }
}
const shot = (page, name, full = true) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tokenFromLog(addr) {
  const txt = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`EMAIL to ${addr.replace(/[.+]/g, "\\$&")}[\\s\\S]*?verify-email\\?token=([\\w-]+)`, "g");
  let m, last = null;
  while ((m = re.exec(txt))) last = m[1];
  if (!last) throw new Error(`verification token for ${addr} not found in backend log`);
  return last;
}

async function csrf(ctx) {
  return (await ctx.cookies()).find((c) => c.name === "ri_csrf")?.value ?? "";
}
// The backend rate-limits auth POSTs per IP (LOGIN_RATE_PER_MINUTE, default 10). Wait it out instead of failing.
let throttled = 0;
async function call(ctx, method, p, opts = {}) {
  for (let i = 0; ; i++) {
    const r = await ctx.request.fetch(BASE + p, { method, timeout: 240000, headers: { "x-csrf-token": await csrf(ctx) }, ...opts });
    if (r.status() !== 429 || i >= 30) return r;
    throttled++;
    await sleep(5000);
  }
}
/** Applying is idempotent (re-applying updates the application). The first match after a cold backend start can
    outlast the `next dev` proxy timeout (about 30 s) and come back as a 500 even though it succeeded, so retry. */
async function applyTo(ctx, openingId, versionId) {
  for (let i = 0; ; i++) {
    const r = await call(ctx, "POST", `/api/openings/${openingId}/apply`, { data: { version_id: versionId, share_consent: true } });
    if (r.status() < 500 || i >= 3) return ok(r, "apply");
    await sleep(3000);
  }
}

async function ok(r, what) {
  if (!r.ok()) throw new Error(`${what}: HTTP ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
}

/* Registration answers 201 the same way for new and already-registered addresses and starts no session.
   Which one it was shows in the email: a verification link, or "…already has an account". Only the part of
   the log written after `from` (bytes) is read, so links from earlier runs are never reused. */
async function registrationMail(addr, from) {
  for (let i = 0; i < 80; i++) {
    const txt = fs.existsSync(LOG) ? fs.readFileSync(LOG).subarray(from).toString("utf8") : "";
    const blocks = txt.split("EMAIL to ").filter((b) => b.startsWith(addr));
    const last = blocks[blocks.length - 1];
    if (last) {
      const v = /verify-email\?token=([\w-]+)/.exec(last);
      if (v) return { token: v[1] };
      if (/already has an\s+account/.test(last)) return { existing: true };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no registration email for ${addr} in ${LOG}`);
}

async function newUser(browser, email, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const from = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  await ok(await call(ctx, "POST", "/api/auth/register", { data: { email, password } }), "register " + email);
  const m = await registrationMail(email, from);
  if (m.existing) throw new Error(`${email} is already registered`);
  await ok(await call(ctx, "POST", "/api/auth/verify-email", { data: { token: m.token } }), "verify " + email);
  // registering no longer signs in: sign in once the address is verified
  await ok(await call(ctx, "POST", "/api/auth/login", { data: { email, password } }), "sign in " + email);
  return ctx;
}

async function uploadConfirmed(ctx, persona) {
  const buffer = fs.readFileSync(path.join(FIX, `${persona}.pdf`));
  const up = await ok(await call(ctx, "POST", "/api/resumes", { multipart: { file: { name: `${persona}.pdf`, mimeType: "application/pdf", buffer } } }), "upload");
  let ex;
  for (let i = 0; i < 90; i++) {
    const r = await call(ctx, "GET", `/api/resumes/${up.id}/extraction`);
    if (r.ok()) {
      ex = await r.json();
      break;
    }
    await sleep(1000);
  }
  if (!ex) throw new Error("extraction never became available");
  const rv = await ok(await call(ctx, "PUT", `/api/resumes/${up.id}/review`, { data: { content: ex.content } }), "confirm review");
  return { resumeId: up.id, versionId: rv.version_id };
}

/** page.goto that retries a 5xx: `next dev` occasionally fails the first compile of a route. */
async function go(page, url) {
  for (let i = 0; ; i++) {
    const r = await page.goto(url);
    if (!r || r.status() < 500 || i >= 3) return r;
    await sleep(2000);
  }
}

/** Submit an auth form; if the per-IP auth rate limit answers (shown as "Too many requests"), wait and resubmit. */
async function authSubmit(page, submit, done) {
  for (let i = 0; i < 20; i++) {
    await submit();
    const r = await Promise.race([
      done().then(() => "ok", () => "timeout"),
      page.getByText("Too many requests").waitFor({ timeout: 60000 }).then(() => "limited", () => "timeout"),
    ]);
    if (r === "ok") return;
    if (r === "timeout") throw new Error("auth step timed out");
    throttled++;
    await sleep(8000);
  }
  throw new Error("still rate-limited after retries");
}

async function noOverflow(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) throw new Error(`horizontal overflow of ${over}px on ${label} at ${page.viewportSize().width}px`);
}

/** Sign HR in through the API, completing the second step with a stored TOTP secret if needed. */
async function apiLoginHr(ctx) {
  const r = await ok(await call(ctx, "POST", "/api/auth/login", { data: { email: HR_EMAIL, password } }), "HR login");
  if (!r.mfa_required) return r;
  const saved = loadSecret(HR_TOTP_FILE);
  if (!saved) throw new Error(`HR account has 2FA on but ${HR_TOTP_FILE} has no secret; use a fresh database`);
  const { code, step: s } = await freshCode(saved.secret, saved.lastStep);
  saveSecret(HR_TOTP_FILE, { ...saved, lastStep: s });
  return ok(await call(ctx, "POST", "/api/auth/login/mfa", { data: { mfa_token: r.mfa_token, code } }), "HR login 2nd step");
}

const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const consoleErrors = [];
function watch(page) {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${page.url()} :: ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.setDefaultNavigationTimeout(120000); // first hit of a route compiles it under `next dev`
  page.setDefaultTimeout(45000);
  return page;
}

let page;
let rec, recPage;
let hrSecret = null;
let hrRole = "recruiter"; // set from /api/auth/me once the HR account is ready
try {
  // ================================================================ recruiter: 2FA
  await check("recruiter account ready without 2FA", async () => {
    try {
      rec = await newUser(browser, HR_EMAIL);
    } catch (e) {
      if (!/HTTP 409|HTTP 429|already registered/.test(e.message)) throw e; // existing account (or register rate limit on re-runs)
      // re-run against the same database: sign in and turn 2FA off so the flow starts from scratch
      rec = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await apiLoginHr(rec);
      const st = await ok(await call(rec, "GET", "/api/account/2fa"), "2fa status");
      if (st.enabled) {
        const saved = loadSecret(HR_TOTP_FILE);
        const { code, step: s } = await freshCode(saved.secret, saved.lastStep);
        saveSecret(HR_TOTP_FILE, { ...saved, lastStep: s });
        await ok(await call(rec, "POST", "/api/account/2fa/disable", { data: { password, code } }), "disable 2fa");
      }
    }
    const me = await ok(await call(rec, "GET", "/api/auth/me"), "me");
    // the HR account may be a recruiter or an admin (admin is needed for the fairness report)
    assert((me.role === "recruiter" || me.role === "admin") && me.mfa_required_for_role && !me.mfa_enabled, `unexpected HR state ${JSON.stringify(me)}`);
    hrRole = me.role;
  });

  await check("staff without 2FA get the friendly 'turn on 2FA' prompt, not an error", async () => {
    recPage = watch(await rec.newPage());
    const r = await call(rec, "GET", "/api/recruiter/openings");
    assert(r.status() === 403 && (await r.json()).detail.code === "mfa_required", "recruiter API did not demand 2FA");
    await go(recPage, `${BASE}/recruiter`);
    const prompt = recPage.getByTestId("mfa-required");
    await prompt.waitFor();
    await prompt.getByRole("heading", { name: "Turn on two-factor sign-in to continue" }).waitFor();
    assert((await recPage.getByText("Something went wrong").count()) === 0, "an error was shown instead of the prompt");
    await shot(recPage, "v2-mfa-required-desktop");
    await recPage.setViewportSize({ width: 375, height: 812 });
    await noOverflow(recPage, "mfa prompt");
    await shot(recPage, "v2-mfa-required-375");
    await recPage.setViewportSize({ width: 1280, height: 900 });
    // the analytics page goes through the API path (403 -> event -> prompt) as well
    await go(recPage, `${BASE}/recruiter/analytics`);
    await recPage.getByTestId("mfa-required").waitFor();
  });

  await check("recruiter turns on 2FA in Settings (QR + key, recovery codes shown once)", async () => {
    await go(recPage, `${BASE}/recruiter`);
    await recPage.getByTestId("mfa-required").getByRole("link", { name: "Set up two-factor sign-in" }).click();
    await recPage.waitForURL(/\/settings/);
    await recPage.getByRole("button", { name: "Set up two-factor sign-in" }).click();
    const setup = recPage.getByTestId("mfa-setup");
    await setup.getByRole("img", { name: "QR code for your authenticator app" }).waitFor();
    hrSecret = (await setup.getByTestId("mfa-secret").innerText()).replace(/\s+/g, "");
    assert(/^[A-Z2-7]{16,}$/.test(hrSecret), `unexpected secret ${hrSecret}`);
    await shot(recPage, "v2-2fa-setup-desktop", false);
    const { code, step: s } = await freshCode(hrSecret);
    await setup.getByLabel("Code from the app").fill(code);
    await setup.getByRole("button", { name: "Turn on" }).click();
    const codes = recPage.getByTestId("recovery-codes");
    await codes.waitFor();
    const list = (await codes.getByRole("list", { name: "Recovery codes" }).innerText()).split(/\s+/).filter(Boolean);
    assert(list.length >= 8, `expected recovery codes, got ${list.length}`);
    saveSecret(HR_TOTP_FILE, { secret: hrSecret, lastStep: s, recovery: list });
    await codes.getByRole("button", { name: "Download .txt" }).waitFor();
    await codes.getByRole("button", { name: "Copy" }).waitFor();
    await recPage.getByTestId("recovery-codes").scrollIntoViewIfNeeded();
    await shot(recPage, "v2-2fa-recovery-desktop", false);
    await codes.getByRole("button", { name: "I've saved them" }).click();
    await recPage.getByTestId("mfa-on").waitFor();
    assert((await recPage.getByTestId("recovery-codes").count()) === 0, "recovery codes still visible after dismissing");
  });

  await check("recruiter signs out and back in with an authenticator code", async () => {
    await recPage.getByRole("button", { name: "Sign out" }).first().click();
    await recPage.waitForURL(/\/login/);
    await recPage.getByLabel("Email").fill(HR_EMAIL);
    await recPage.getByLabel("Password").fill(password);
    await authSubmit(
      recPage,
      () => recPage.getByRole("button", { name: "Sign in" }).click(),
      () => recPage.getByRole("heading", { name: "Two-factor sign-in" }).waitFor({ timeout: 60000 }),
    );
    await recPage.getByRole("button", { name: "Use a recovery code" }).waitFor();
    // a wrong code is refused
    await recPage.getByLabel("Authentication code").fill("000000");
    await authSubmit(
      recPage,
      () => recPage.getByRole("button", { name: "Verify and sign in" }).click(),
      () => recPage.getByText(/didn't work/).waitFor({ timeout: 60000 }),
    );
    await shot(recPage, "v2-login-mfa-desktop");
    await authSubmit(
      recPage,
      async () => {
        const saved = loadSecret(HR_TOTP_FILE);
        const { code, step: s } = await freshCode(hrSecret, saved.lastStep);
        saveSecret(HR_TOTP_FILE, { ...saved, lastStep: s });
        await recPage.getByLabel("Authentication code").fill(code);
        await recPage.getByRole("button", { name: "Verify and sign in" }).click();
      },
      () => recPage.waitForURL(/\/dashboard/, { timeout: 60000 }),
    );
    await go(recPage, `${BASE}/recruiter`);
    await recPage.getByRole("heading", { name: "Your openings" }).waitFor();
  });

  await check("a recovery code also works (375px login)", async () => {
    const m = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const p = watch(await m.newPage());
    await go(p, `${BASE}/login`);
    await p.getByLabel("Email").fill(HR_EMAIL);
    await p.getByLabel("Password").fill(password);
    await authSubmit(
      p,
      () => p.getByRole("button", { name: "Sign in" }).click(),
      () => p.getByRole("button", { name: "Use a recovery code" }).waitFor({ timeout: 60000 }),
    );
    await p.getByRole("button", { name: "Use a recovery code" }).click();
    const saved = loadSecret(HR_TOTP_FILE);
    await p.getByLabel("Recovery code").fill(saved.recovery[0]);
    await noOverflow(p, "login mfa");
    await shot(p, "v2-login-mfa-375");
    await authSubmit(
      p,
      () => p.getByRole("button", { name: "Verify and sign in" }).click(),
      () => p.getByRole("heading", { name: "Signed in with a recovery code" }).waitFor({ timeout: 60000 }),
    );
    await p.getByText(/recovery codes? left/).waitFor();
    await p.getByRole("button", { name: "Continue" }).click();
    await p.waitForURL(/\/dashboard/);
    await m.close();
  });

  // ================================================================ candidates apply to a fresh opening
  let openingId, A, a, B, b, C, c;
  await check("recruiter posts an opening; three candidates apply", async () => {
    const o = await ok(
      await call(rec, "POST", "/api/recruiter/openings", {
        data: {
          title: `Backend Engineer ${stamp}`,
          company: "Northwind Payments",
          location: "Pune",
          work_arrangement: "hybrid",
          employment_type: "full_time",
          description:
            "We build payment APIs used by thousands of merchants.\nRequirements\n- 2+ years of professional experience building REST APIs\n- Strong Python and SQL\n- PostgreSQL\n- Docker\nNice to have\n- AWS\n- Redis\n- Kubernetes",
        },
      }),
      "create opening",
    );
    openingId = o.id;
    a = await newUser(browser, `v2-a-${stamp}@example.com`);
    b = await newUser(browser, `v2-b-${stamp}@example.com`);
    c = await newUser(browser, `v2-c-${stamp}@example.com`);
    [A, B, C] = await Promise.all([uploadConfirmed(a, "p02"), uploadConfirmed(b, "p09"), uploadConfirmed(c, "p06")]);
    for (const [ctx, X] of [[a, A], [b, B], [c, C]])
      await applyTo(ctx, openingId, X.versionId);
    page = watch(await a.newPage());
  });

  if (FAIRNESS_SEED > 0) {
    await check(`seed ${FAIRNESS_SEED} self-identified applicants (fairness data)`, async () => {
      const personas = ["p01", "p02", "p03", "p05", "p06", "p09"];
      const jobs = Array.from({ length: FAIRNESS_SEED }, (_, i) => i);
      const worker = async () => {
        while (jobs.length) {
          const i = jobs.shift();
          const ctx = await newUser(browser, `v2-f${i}-${stamp}@example.com`);
          const X = await uploadConfirmed(ctx, personas[i % personas.length]);
          const woman = i % 2 === 0;
          await ok(await call(ctx, "PUT", "/api/account/self-id", { data: { gender: woman ? "woman" : "man", age_band: i < FAIRNESS_SEED / 2 ? "25_34" : "35_44", consent: true } }), "self-id");
          await applyTo(ctx, openingId, X.versionId);
          await ctx.close();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      // advance more men than women so the four-fifths flag has something to show
      const list = await ok(await call(rec, "GET", `/api/recruiter/openings/${openingId}/candidates`), "candidates");
      const byEmail = Object.fromEntries(list.candidates.map((r) => [r.email, r.application_id]));
      for (let i = 0; i < FAIRNESS_SEED; i++) {
        const aid = byEmail[`v2-f${i}-${stamp}@example.com`];
        const advance = i % 2 === 1 ? i % 4 !== 3 || i < 8 : i % 6 === 0;
        if (aid && advance) await ok(await call(rec, "PATCH", `/api/recruiter/applications/${aid}`, { data: { stage: "shortlisted" } }), "shortlist");
      }
    });
  }

  // ================================================================ recruiter: bulk upload
  const oUrl = () => `${BASE}/recruiter/openings/${openingId}`;
  await check("bulk upload: consent is required (UI and server)", async () => {
    await go(recPage, oUrl());
    await recPage.getByTestId("candidate-row").first().waitFor({ timeout: 60000 });
    await recPage.getByRole("button", { name: "Bulk upload" }).click();
    const bu = recPage.getByTestId("bulk-upload");
    await bu.getByText("deleted automatically after 90 days").waitFor();
    await bu.getByLabel(/Resume files/).setInputFiles(path.join(FIX, "p01.pdf"));
    await bu.getByRole("button", { name: "Upload and score" }).click();
    await bu.getByText(/Tick the box to confirm these candidates agreed/).waitFor();
    assert((await recPage.getByTestId("bulk-results").count()) === 0, "uploaded without consent");
    const r = await call(rec, "POST", `/api/recruiter/openings/${openingId}/bulk-upload`, {
      multipart: { files: { name: "p01.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(FIX, "p01.pdf")) }, consent_attested: "false" },
    });
    assert(r.status() === 422 && (await r.json()).detail.code === "consent_required", `server accepted a bulk upload without consent (${r.status()})`);
  });

  await check("bulk upload with consent: per-file results, then remove one", async () => {
    const bu = recPage.getByTestId("bulk-upload");
    await bu.getByLabel(/Resume files/).setInputFiles([
      { name: "p01.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(FIX, "p01.pdf")) },
      { name: "p03.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(path.join(FIX, "p03.pdf")) },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a resume") },
    ]);
    await bu.getByLabel(/These candidates agreed to be considered for this opening/).check();
    await bu.getByRole("button", { name: "Upload and score" }).click();
    const res = recPage.getByTestId("bulk-results");
    await res.waitFor({ timeout: 120000 });
    assert((await res.getByTestId("bulk-added").count()) === 2, "expected 2 added");
    assert((await res.getByTestId("bulk-failed").count()) === 1, "expected 1 failed");
    await res.getByTestId("bulk-failed").getByText("notes.txt").waitFor();
    await shot(recPage, "v2-bulk-upload-desktop");
    await res.getByTestId("bulk-added").first().getByRole("button", { name: "Remove" }).click();
    await recPage.getByTestId("confirm-dialog").getByTestId("confirm-ok").click(); // in-app confirm dialog
    await res.getByTestId("bulk-added").first().getByText("Removed").waitFor();
    await recPage.getByRole("button", { name: "Bulk upload" }).click(); // close the panel
    const uploadedRows = recPage.getByTestId("candidate-row").filter({ hasText: "Uploaded" });
    // onDone() reloads the candidate list in the background: wait for it to settle on the expected count
    // instead of counting rows that may still be from before the upload / removal
    const deadline = Date.now() + 20000;
    let n = await uploadedRows.count();
    while (n !== 1 && Date.now() < deadline) {
      await recPage.waitForTimeout(250);
      n = await uploadedRows.count();
    }
    assert(n === 1, `expected 1 uploaded row, got ${n}`);
    await uploadedRows.first().getByText(/deleted \w/).waitFor();
  });

  // ================================================================ recruiter: filters
  await check("shortlisting filters: source, must-have skill, min score; years + notes columns", async () => {
    const f = recPage.getByTestId("candidate-filters");
    const total = await recPage.getByTestId("candidate-row").count();
    await recPage.getByRole("columnheader", { name: "Years" }).waitFor();
    await recPage.getByRole("columnheader", { name: "Notes" }).waitFor();
    await f.getByLabel("Source").selectOption("uploaded");
    let resp = recPage.waitForResponse((r) => r.url().includes("/candidates?") && r.url().includes("source=uploaded"));
    await f.getByRole("button", { name: "Apply filters" }).click();
    await resp;
    await recPage.waitForFunction(() => document.querySelectorAll("[data-testid=candidate-row]").length === 1);
    await recPage.getByTestId("candidate-row").first().getByText("Uploaded").waitFor();
    await f.getByLabel("Source").selectOption("");
    await f.getByLabel("Must-have skills").selectOption("Python");
    await f.getByRole("list", { name: "Selected must-have skills" }).getByText("Python").waitFor();
    await f.getByLabel("Min. score").fill("20");
    resp = recPage.waitForResponse((r) => r.url().includes("must_have=Python") && r.url().includes("min_score=20"));
    await f.getByRole("button", { name: "Apply filters" }).click();
    const body = await (await resp).json();
    assert(body.filters.must_have.includes("Python") && body.filters.min_score === 20, "filters not applied server-side");
    assert(body.candidates.every((r) => r.score >= 20), "min score filter not respected");
    await recPage.getByText("2 active").waitFor();
    await shot(recPage, "v2-filters-desktop");
    const n = body.candidates.length;
    assert(n <= total, "filtered list longer than unfiltered");
    await f.getByRole("button", { name: "Clear" }).click();
    await recPage.waitForFunction((t) => document.querySelectorAll("[data-testid=candidate-row]").length === t, total);
  });

  // ================================================================ recruiter: compare
  await check("side-by-side comparison of two candidates", async () => {
    const rows = recPage.getByTestId("candidate-row");
    await rows.nth(0).getByRole("checkbox").check();
    await rows.nth(1).getByRole("checkbox").check();
    await recPage.getByRole("link", { name: "Compare 2" }).click();
    await recPage.waitForURL(/\/compare\?ids=/);
    const t = recPage.getByTestId("compare");
    await t.waitFor({ timeout: 60000 });
    assert((await t.getByRole("columnheader").count()) === 3, "expected requirement + 2 candidate columns");
    assert((await t.getByTestId("compare-row").count()) >= 3, "expected requirement rows");
    const statuses = await t.getByTestId("compare-cell").locator("[role=img]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    assert(statuses.every((s) => /: (matched|partial|missing|unknown)$/.test(s)), `bad status cells ${statuses.slice(0, 3)}`);
    await t.getByText("Evidence").first().click();
    await shot(recPage, "v2-compare-desktop");
  });

  // ================================================================ recruiter: notes
  let noteCandidate = "";
  await check("private note on a candidate (HR staff only)", async () => {
    await go(recPage, oUrl());
    const first = recPage.getByTestId("candidate-row").first();
    await first.waitFor();
    noteCandidate = (await first.getByRole("link").first().innerText()).trim();
    await first.getByRole("link").first().click();
    await recPage.waitForURL(/\/recruiter\/applications\//);
    const notes = recPage.getByTestId("notes");
    await notes.getByText("Visible to HR staff only").waitFor();
    await notes.getByLabel("Add a note").fill("Strong API design examples. Ask about on-call experience.");
    await notes.getByRole("button", { name: "Save note" }).click();
    await notes.getByTestId("note").filter({ hasText: "Strong API design examples" }).waitFor();
    await shot(recPage, "v2-notes-desktop");
    // candidates never see notes: the candidate API has no notes in its output
    const mine = await ok(await call(a, "GET", `/api/openings/${openingId}?version_id=${A.versionId}`), "candidate opening");
    assert(!JSON.stringify(mine).includes("on-call experience"), "note leaked to a candidate");
    await go(recPage, oUrl());
    const row = recPage.getByTestId("candidate-row").filter({ hasText: noteCandidate }).first();
    await row.getByLabel("1 private note").waitFor();
  });

  // ================================================================ recruiter: pipeline board
  await check("pipeline board: move a card with the keyboard-accessible control", async () => {
    await recPage.getByRole("button", { name: "Board" }).click();
    const board = recPage.getByTestId("pipeline-board");
    await board.waitFor();
    for (const s of ["submitted", "shortlisted", "interview", "offer", "hired", "rejected"]) await board.getByTestId(`board-col-${s}`).waitFor();
    const card = board.getByTestId("board-col-submitted").getByTestId("board-card").first();
    const name = (await card.getByRole("link").innerText()).trim();
    const sel = card.getByLabel(`Stage for ${name}`);
    await sel.focus();
    const resp = recPage.waitForResponse((r) => r.url().includes("/api/recruiter/applications/") && r.request().method() === "PATCH");
    await sel.selectOption("interview");
    assert((await resp).ok(), "stage PATCH failed");
    await board.getByTestId("board-col-interview").getByTestId("board-card").filter({ hasText: name }).waitFor();
    await shot(recPage, "v2-board-desktop");
    const list = await ok(await call(rec, "GET", `/api/recruiter/openings/${openingId}/candidates?stage=interview`), "interview list");
    assert(list.candidates.some((r) => r.name === name), "stage change not saved");
  });

  // ================================================================ recruiter: analytics & fairness
  await check("HR analytics page renders totals, missing skills and openings", async () => {
    await go(recPage, `${BASE}/recruiter/analytics`);
    await recPage.getByTestId("analytics-totals").waitFor({ timeout: 60000 });
    await recPage.getByRole("heading", { name: "Most-missing skills" }).waitFor();
    await recPage.getByTestId("missing-skills").waitFor();
    await recPage.getByTestId("analytics-openings").getByText(`Backend Engineer ${stamp}`).waitFor();
    await recPage.getByText(/Hard to fill' = open for 14\+ days/).waitFor();
    await recPage.getByLabel("Include sample openings").check();
    await recPage.getByTestId("analytics-openings").getByText("Sample opening").first().waitFor();
    await shot(recPage, "v2-analytics-desktop");
  });

  await check("fairness page renders snapshot date, notes and 'not proof' wording", async () => {
    await go(recPage, `${BASE}/recruiter/fairness`);
    if (hrRole !== "admin") {
      // recruiters must not see group outcomes: the page refuses and the API answers 403
      const r = await call(rec, "GET", "/api/recruiter/fairness");
      assert(r.status() === 403, `fairness report open to a recruiter (${r.status()})`);
      console.log("      (HR account is a recruiter, not an admin: fairness content checks skipped)");
      return;
    }
    await recPage.getByTestId("fairness-totals").waitFor({ timeout: 60000 });
    await recPage.getByText("Prompts to investigate, not proof").waitFor();
    await recPage.getByTestId("fairness-notes").getByText(/not proof of bias/).waitFor();
    await recPage.getByRole("heading", { name: "By gender" }).waitFor();
    await recPage.getByRole("heading", { name: "By age band" }).waitFor();
    // The report is a snapshot as of the start of today, so applicants seeded during this run are not in it yet;
    // group rows are covered by backend tests (test_fairness_report_*).
    await recPage.getByTestId("fairness-totals").getByText("Data as of").waitFor();
    await recPage.getByTestId("fairness-notes").getByText(/changes made today appear tomorrow/).waitFor();
    await shot(recPage, "v2-fairness-desktop");
  });

  // ================================================================ candidate: settings
  await check("candidate saves job alerts", async () => {
    await go(page, `${BASE}/settings`);
    const ja = page.getByTestId("job-alerts");
    await ja.waitFor();
    await ja.getByLabel(/Email me when a new opening scores well/).check();
    const slider = ja.getByLabel("Only when the score is at least");
    await slider.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await ja.getByLabel("Resume to match against").selectOption(A.resumeId);
    await ja.getByRole("button", { name: "Save alerts" }).click();
    await ja.getByText("Saved.").waitFor();
    const me = await ok(await call(a, "GET", "/api/auth/me"), "me");
    assert(me.notification_prefs.job_alerts === true, "alerts not enabled");
    assert(me.notification_prefs.job_alert_min_score === 75, `min score ${me.notification_prefs.job_alert_min_score}`);
    assert(me.notification_prefs.job_alert_resume_id === A.resumeId, "resume not saved");
    await page.reload();
    assert(await page.getByTestId("job-alerts").getByLabel(/Email me when a new opening scores well/).isChecked(), "toggle not persisted in UI");
  });

  await check("voluntary self-ID: consent required, save, then delete", async () => {
    const sid = page.getByTestId("self-id");
    await sid.getByText("Never affects your scores").waitFor();
    await sid.getByText(/never used to rank, match or score you/).waitFor();
    await sid.getByLabel("Gender (optional)").selectOption("non_binary");
    await sid.getByLabel("Age band (optional)").selectOption("25_34");
    await sid.getByRole("button", { name: "Save my answers" }).click();
    await sid.getByText(/Tick the consent box/).waitFor();
    await sid.getByLabel(/I agree this is used only for anonymous, aggregate fairness checks/).check();
    await sid.getByRole("button", { name: "Save my answers" }).click();
    await sid.getByText("Saved. Thank you.").waitFor();
    let v = await ok(await call(a, "GET", "/api/account/self-id"), "self-id");
    assert(v.value?.gender === "non_binary" && v.value?.age_band === "25_34", "self-id not saved");
    await sid.scrollIntoViewIfNeeded();
    await shot(page, "v2-settings-desktop");
    await sid.getByRole("button", { name: "Delete my answers" }).click();
    await sid.getByText("Your answers were deleted.").waitFor();
    v = await ok(await call(a, "GET", "/api/account/self-id"), "self-id");
    assert(v.value === null, "self-id not deleted");
  });

  // ================================================================ candidate: what-if
  await check("editor what-if: edit a bullet, see before → after and the delta (nothing saved)", async () => {
    await go(page, `${BASE}/resumes/${A.resumeId}/editor`);
    const wi = page.getByTestId("what-if");
    await wi.waitFor({ timeout: 60000 });
    await wi.getByText(/Edit a bullet, skill or summary/).waitFor();
    await page.waitForFunction(() => (document.querySelector("#whatif-target")?.value ?? "") !== "");
    const bullet = page.getByLabel("Bullet 1").first();
    const before = await bullet.inputValue();
    const req = page.waitForRequest((r) => r.url().includes("/what-if") && r.method() === "POST", { timeout: 15000 });
    await bullet.fill(before + " Deployed services with Docker and Kubernetes on AWS, and tuned PostgreSQL queries.");
    const r = await req;
    assert(JSON.parse(r.postData()).content, "what-if did not send content");
    const res = wi.getByTestId("what-if-result");
    await res.waitFor({ timeout: 30000 });
    await wi.getByTestId("what-if-delta").waitFor();
    await res.getByText("Nothing is saved", { exact: false }).waitFor();
    const versions = await ok(await call(a, "GET", `/api/resumes/${A.resumeId}/versions`), "versions");
    assert(versions.length === 1, "what-if saved a version");
    await shot(page, "v2-whatif-desktop", false);
    // then save it, so the history chart has two versions
    await page.getByRole("button", { name: "Save version" }).click();
    await page.getByText("Saved as version 2.").waitFor({ state: "attached" });
  });

  // ================================================================ candidate: learning plan
  await check("learning plan: add from the tips learning path, mark done, next step", async () => {
    await go(page, `${BASE}/resumes/${A.resumeId}/leaderboard`);
    const last = page.getByTestId("role-row").last();
    await last.waitFor({ timeout: 60000 });
    await last.locator("button[aria-expanded]").first().click();
    await last.getByRole("button", { name: "How to improve for this role" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByTestId("not-eligible").waitFor({ timeout: 30000 });
    await dlg.getByRole("button", { name: "Add to learning plan" }).click();
    await dlg.getByTestId("learning-added").waitFor();
    await dlg.getByRole("link", { name: "View learning plan" }).click();
    await page.waitForURL(/\/learning/);
    await page.getByTestId("learning-progress").waitFor();
    const todo = page.getByTestId("learning-col-todo").getByTestId("learning-item");
    const n = await todo.count();
    assert(n >= 1, "nothing added to the plan");
    const skill = (await todo.first().getByRole("heading").innerText()).trim();
    await todo.first().getByRole("button", { name: "Mark done" }).click();
    const done = page.getByTestId("learning-col-done").getByTestId("learning-item").filter({ hasText: skill });
    await done.waitFor();
    await page.getByTestId("learning-progress").getByText(new RegExp(`1\\s+of\\s+${n}`)).waitFor();
    await done.getByTestId("next-step").getByRole("link", { name: "Open the editor" }).waitFor();
    const resources = await page.getByText(/checked on/).count();
    const empty = await page.getByTestId("no-resource").count();
    assert(resources + empty > 0, "no resource or empty-resource state shown");
    await shot(page, "v2-learning-desktop");
  });

  // ================================================================ candidate: history chart
  await check("resume health over time chart", async () => {
    await go(page, `${BASE}/resumes/${A.resumeId}/progress`);
    const chart = page.getByTestId("history-chart");
    await chart.waitFor({ timeout: 60000 });
    await chart.getByText("v1").waitFor();
    await chart.getByText("v2").waitFor();
    await chart.getByText("Resume version").waitFor();
    await chart.getByText("Score (0–100)").waitFor();
    assert((await page.getByTestId("history-change").count()) === 2, "change tiles missing");
    await chart.locator("svg[role=img] rect[fill=transparent]").last().hover();
    await chart.getByRole("status").getByText(/Quality:/).waitFor();
    await shot(page, "v2-history-desktop");
  });

  // ================================================================ candidate: mock interview
  await check("mock interview: answer shows rule-based checks and the AI block separately", async () => {
    await go(page, `${BASE}/resumes/${A.resumeId}/interview`);
    await page.getByRole("button", { name: "Start practice" }).click();
    const pr = page.getByTestId("practice");
    await pr.getByTestId("question").waitFor({ timeout: 60000 });
    await pr
      .getByLabel(/Your answer/)
      .fill(
        "When our checkout API was timing out under load, I investigated the slow queries and I added indexes and a Redis cache. I also wrote load tests. As a result the p95 latency dropped from 900 ms to 180 ms and the timeouts stopped during the next sale.",
      );
    await pr.getByRole("button", { name: "Get feedback" }).click();
    const checks = page.getByTestId("checks-block");
    await checks.waitFor({ timeout: 60000 });
    await checks.getByRole("heading", { name: "Structure checks (rule-based, not AI)" }).waitFor();
    const ai = page.getByTestId("ai-block");
    await ai.waitFor();
    await ai.getByText("Sample response — not live AI").waitFor();
    await page.getByTestId("past-sessions").getByText("1/").waitFor();
    await shot(page, "v2-interview-desktop");
  });

  // ================================================================ layout: 375 and 1280, screenshots
  await check("no horizontal overflow at 375px and 1280px on every new screen (+ screenshots)", async () => {
    const cp = watch(await a.newPage());
    const rp = watch(await rec.newPage());
    const ids = (await ok(await call(rec, "GET", `/api/recruiter/openings/${openingId}/candidates`), "cands")).candidates.slice(0, 3).map((r) => r.application_id);
    const screens = [
      [rp, "recruiter-table", `/recruiter/openings/${openingId}`, (p) => p.getByTestId("candidate-row").first().waitFor({ timeout: 60000 })],
      [rp, "board", `/recruiter/openings/${openingId}?view=board`, (p) => p.getByTestId("pipeline-board").waitFor({ timeout: 60000 })],
      [rp, "compare", `/recruiter/openings/${openingId}/compare?ids=${ids.join(",")}`, (p) => p.getByTestId("compare").waitFor({ timeout: 60000 })],
      [rp, "notes", `/recruiter/applications/${ids[0]}`, (p) => p.getByTestId("notes").waitFor({ timeout: 60000 })],
      [rp, "analytics", `/recruiter/analytics`, (p) => p.getByTestId("analytics-totals").waitFor({ timeout: 60000 })],
      // admin-only page: skipped when the HR account is a recruiter
      ...(hrRole === "admin" ? [[rp, "fairness", `/recruiter/fairness`, (p) => p.getByTestId("fairness-totals").waitFor({ timeout: 60000 })]] : []),
      [rp, "settings-2fa", `/settings`, (p) => p.getByTestId("mfa-on").waitFor({ timeout: 60000 })],
      [cp, "settings", `/settings`, (p) => p.getByTestId("self-id").getByLabel("Gender (optional)").waitFor({ timeout: 60000 })],
      [cp, "whatif", `/resumes/${A.resumeId}/editor`, (p) => p.getByTestId("what-if").waitFor({ timeout: 60000 })],
      [cp, "learning", `/learning`, (p) => p.getByTestId("learning-progress").waitFor({ timeout: 60000 })],
      [cp, "history", `/resumes/${A.resumeId}/progress`, (p) => p.getByTestId("history-chart").waitFor({ timeout: 60000 })],
      [cp, "interview", `/resumes/${A.resumeId}/interview`, (p) => p.getByTestId("past-sessions").waitFor({ timeout: 60000 })],
    ];
    for (const w of [1280, 375]) {
      for (const [p, name, url, ready] of screens) {
        await p.setViewportSize({ width: w, height: w === 375 ? 812 : 900 });
        await go(p, BASE + url);
        await ready(p);
        if (name === "whatif") {
          const bullet = p.getByLabel("Bullet 2").first();
          await bullet.fill((await bullet.inputValue()) + " Built CI pipelines with GitHub Actions.");
          await p.getByTestId("what-if-result").waitFor({ timeout: 30000 });
        }
        if (name === "interview") {
          await p.getByTestId("past-sessions").getByRole("button").first().click();
          await p.getByTestId("practice").waitFor();
          await p.getByRole("button", { name: "Previous" }).click();
          await p.getByTestId("checks-block").waitFor();
        }
        if (name === "recruiter-table" && w === 375) {
          await p.getByRole("button", { name: "Bulk upload" }).click();
          await p.getByTestId("bulk-upload").waitFor();
        }
        await sleep(300);
        await noOverflow(p, name);
        await shot(p, `v2-${name}-${w === 375 ? "375" : "desktop"}`);
      }
    }
    // the 2FA prompt and analytics at 375 are covered above; prompt screenshot at 375 needs a staff user without 2FA
  });

  await check("no uncaught page errors", async () => {
    const real = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
    if (real.length) throw new Error(real.slice(0, 3).join(" | "));
  });
} catch (e) {
  if (!results.some((r) => r[0] === "FAIL")) {
    results.push(["FAIL", step, String(e).split("\n")[0]]);
    console.log(`FAIL  ${step}: ${String(e).split("\n")[0]}`);
  }
  for (const p of [page, recPage]) if (p) await shot(p, "FAILED-v2-" + step.replace(/\W+/g, "-").slice(0, 60)).catch(() => {});
} finally {
  await browser.close();
  for (const f of fs.readdirSync(SHOTS)) fs.copyFileSync(path.join(SHOTS, f), path.join(OUT, f));
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const failed = results.filter((r) => r[0] === "FAIL").length;
  if (throttled) console.log(`(waited out ${throttled} rate-limited API calls)`);
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
