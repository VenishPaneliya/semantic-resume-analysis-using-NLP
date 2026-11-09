// E2E for leaderboards, relevance-gated tips, openings/apply/standing and the recruiter area.
// Usage (from frontend/):
//   BASE_URL=http://localhost:3010 BACKEND_LOG=e2e/backend-lb.log node e2e/leaderboard.mjs
// Backend must run with RECRUITER_EMAILS=hr@example.com, EMAIL_BACKEND=console, LLM_PROVIDER=fixture,
// and demo openings seeded (scripts/seed_demo_openings.py). Verification tokens are read from the backend log.
// Persona PDFs in e2e/fixtures/personas are rendered from backend/eval/synthetic.py (render(persona, "A")).
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshCode, loadSecret, saveSecret } from "./totp.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3010";
const LOG = process.env.BACKEND_LOG ?? "e2e/backend-lb.log";
const FIX = "e2e/fixtures/personas";
const OUT = "e2e/screenshots";
const HR_EMAIL = process.env.HR_EMAIL ?? "hr@example.com";
// shared with features-v2.mjs: the HR account's TOTP secret once two-factor sign-in is on
const HR_TOTP_FILE = process.env.HR_TOTP_FILE ?? path.join(os.tmpdir(), "ri-e2e-hr-totp.json");
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const password = "Correct-horse-42";
const results = [];
let step = "";

async function check(name, fn) {
  step = name;
  try {
    await fn();
    results.push(["PASS", name]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push(["FAIL", name, e.message.split("\n")[0]]);
    console.log(`FAIL  ${name}: ${e.message.split("\n")[0]}`);
    throw e;
  }
}
const shot = (page, name, full = true) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function tokenFromLog(addr) {
  const txt = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`EMAIL to ${addr.replace(/[.+]/g, "\\$&")}[\\s\\S]*?verify-email\\?token=([\\w-]+)`, "g");
  let m, last = null;
  while ((m = re.exec(txt))) last = m[1];
  if (!last) throw new Error(`verification token for ${addr} not found in backend log`);
  return last;
}

// ---- API helpers that act as a given browser context (same cookies + CSRF as the real UI)
async function csrf(ctx) {
  return (await ctx.cookies()).find((c) => c.name === "ri_csrf")?.value ?? "";
}
async function call(ctx, method, p, opts = {}) {
  // the backend rate-limits auth POSTs per IP; wait it out instead of failing
  for (let i = 0; ; i++) {
    const r = await ctx.request.fetch(BASE + p, { method, timeout: 240000, headers: { "x-csrf-token": await csrf(ctx) }, ...opts });
    if (r.status() !== 429 || i >= 30) return r;
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/** Staff need two-factor sign-in (REQUIRE_MFA_FOR_STAFF). Turn it on for a fresh HR account, or complete the
    second step with the stored secret when signing in. */
async function ensureHrMfa(ctx) {
  const st = await ok(await call(ctx, "GET", "/api/account/2fa"), "2fa status");
  if (st.enabled) return;
  const setup = await ok(await call(ctx, "POST", "/api/account/2fa/setup"), "2fa setup");
  const { code, step } = await freshCode(setup.secret);
  const r = await ok(await call(ctx, "POST", "/api/account/2fa/enable", { data: { code } }), "2fa enable");
  saveSecret(HR_TOTP_FILE, { secret: setup.secret, lastStep: step, recovery: r.recovery_codes });
}
async function loginHr(ctx) {
  const r = await ok(await call(ctx, "POST", "/api/auth/login", { data: { email: HR_EMAIL, password } }), "recruiter login");
  if (!r.mfa_required) return;
  const saved = loadSecret(HR_TOTP_FILE);
  if (!saved) throw new Error(`HR has 2FA on but ${HR_TOTP_FILE} has no secret`);
  const { code, step } = await freshCode(saved.secret, saved.lastStep);
  saveSecret(HR_TOTP_FILE, { ...saved, lastStep: step });
  await ok(await call(ctx, "POST", "/api/auth/login/mfa", { data: { mfa_token: r.mfa_token, code } }), "recruiter 2nd step");
}
async function ok(r, what) {
  if (!r.ok()) throw new Error(`${what}: HTTP ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
}

async function newUser(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ok(await call(ctx, "POST", "/api/auth/register", { data: { email, password } }), "register " + email);
  await new Promise((r) => setTimeout(r, 400));
  await ok(await call(ctx, "POST", "/api/auth/verify-email", { data: { token: tokenFromLog(email) } }), "verify " + email);
  return ctx;
}

async function uploadConfirmed(ctx, persona) {
  const buffer = fs.readFileSync(path.join(FIX, `${persona}.pdf`));
  const up = await ok(
    await call(ctx, "POST", "/api/resumes", { multipart: { file: { name: `${persona}.pdf`, mimeType: "application/pdf", buffer } } }),
    "upload",
  );
  let ex;
  for (let i = 0; i < 60; i++) {
    const r = await call(ctx, "GET", `/api/resumes/${up.id}/extraction`);
    if (r.ok()) {
      ex = await r.json();
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!ex) throw new Error("extraction never became available");
  const rv = await ok(await call(ctx, "PUT", `/api/resumes/${up.id}/review`, { data: { content: ex.content } }), "confirm review");
  return { resumeId: up.id, versionId: rv.version_id };
}

async function noOverflow(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) throw new Error(`horizontal overflow of ${over}px on ${label} at ${page.viewportSize().width}px`);
}

const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const consoleErrors = [];
function watch(page) {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.setDefaultNavigationTimeout(120000); // first hit of a route compiles it under `next dev`
  page.setDefaultTimeout(45000);
  return page;
}

let page;
try {
  // ------------------------------------------------------------ candidate A (backend persona)
  const a = await newUser(browser, `lb-a-${stamp}@example.com`);
  page = watch(await a.newPage());
  let A;
  await check("candidate A: upload + confirm backend resume", async () => {
    A = await uploadConfirmed(a, "p02");
  });

  // ------------------------------------------------------------ recruiter posts a fresh opening (so applicant counts are known)
  let rec;
  let recPage;
  let newOpeningId = "";
  await check("recruiter creates an opening", async () => {
    rec = await newUser(browser, HR_EMAIL).catch(async (e) => {
      // already registered in an earlier run: sign in instead
      if (!/HTTP 409|already/i.test(e.message)) throw e;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await loginHr(ctx);
      return ctx;
    });
    await ensureHrMfa(rec);
    recPage = watch(await rec.newPage());
    await recPage.goto(`${BASE}/recruiter`);
    await recPage.getByRole("link", { name: "Recruiter" }).first().waitFor();
    await recPage.getByRole("button", { name: "New opening" }).click();
    await recPage.getByLabel("Job title").fill(`Python API Engineer ${stamp}`);
    await recPage.getByLabel("Company").fill("Acme Payments");
    await recPage.getByLabel("Location (optional)").fill("Bengaluru");
    await recPage.getByLabel("Arrangement").selectOption("hybrid");
    await recPage.getByLabel("Employment").selectOption("full_time");
    await recPage
      .getByLabel("Description")
      .fill(
        "We build payment APIs used by thousands of merchants.\nRequirements\n- 2+ years of professional experience building REST APIs\n- Strong Python and SQL\n- PostgreSQL\n- Docker\nNice to have\n- AWS\n- Redis",
      );
    await recPage.getByRole("button", { name: "Publish opening" }).click();
    await recPage.waitForURL(/\/recruiter\/openings\/[\w-]+/);
    newOpeningId = new URL(recPage.url()).pathname.split("/").pop();
    await recPage.getByText("Opening published.").waitFor();
    await recPage.getByRole("heading", { name: "No applicants yet" }).waitFor();
  });

  await check("roles leaderboard renders ranked rows, bands legend and disclaimer", async () => {
    await page.goto(`${BASE}/resumes/${A.resumeId}/leaderboard`);
    const rows = page.getByTestId("role-row");
    await rows.first().waitFor({ timeout: 60000 });
    assert((await rows.count()) >= 5, "expected several role rows");
    await rows.first().getByText("#1").waitFor();
    await rows.first().getByRole("meter").waitFor();
    await page.getByRole("heading", { name: "Score bands" }).waitFor();
    await page.getByText("Compatibility, not probability").waitFor();
    await page.getByText("listed only").first().waitFor();
    const body = (await page.locator("main").innerText()).toLowerCase();
    assert(!/\d+\s*% (chance|probability)/.test(body), "a score is described as a probability");
    await shot(page, "lb-01-roles");
  });

  await check("tips for the top role show prioritised tips", async () => {
    const top = page.getByTestId("role-row").first();
    await top.locator("button[aria-expanded]").first().click();
    await top.getByRole("button", { name: "How to improve for this role" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByTestId("tips-content").waitFor({ timeout: 30000 });
    await dlg.getByRole("region", { name: /priority/ }).first().waitFor();
    assert((await dlg.getByTestId("not-eligible").count()) === 0, "top role should be eligible for tips");
    await dlg.getByText("Honesty first").waitFor();
  });

  await check("an AI tip creates a suggestion card (not auto-applied)", async () => {
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Draft with AI" }).first().click();
    const card = dlg.locator("article[aria-label^='AI suggestion']").first();
    await card.waitFor({ timeout: 30000 });
    await card.getByText(/AI suggestion — not applied/).waitFor();
    await card.getByRole("button", { name: /^Accept/ }).waitFor();
    await shot(page, "lb-02-tips-eligible-suggestion", false);
    await dlg.getByRole("button", { name: "Close tips" }).click();
    await dlg.waitFor({ state: "detached" });
  });

  await check("tips for a clearly unrelated role show 'not a close match' and no tips", async () => {
    const last = page.getByTestId("role-row").last();
    await last.locator("button[aria-expanded]").first().click();
    await last.getByRole("button", { name: "How to improve for this role" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByTestId("not-eligible").waitFor({ timeout: 30000 });
    await dlg.getByRole("heading", { name: "Not a close match yet" }).waitFor();
    await dlg.getByText("Where to start").waitFor();
    await dlg.getByText("Honesty first").waitFor();
    assert((await dlg.getByRole("button", { name: "Draft with AI" }).count()) === 0, "unrelated role offered AI resume edits");
    assert((await dlg.getByRole("region", { name: /priority/ }).count()) === 0, "unrelated role listed resume-edit tips");
    await shot(page, "lb-03-tips-not-eligible", false);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached" });
  });

  await check("openings leaderboard with sample badges", async () => {
    await page.getByRole("tab", { name: "Openings for me" }).click();
    const rows = page.getByTestId("opening-row");
    await rows.first().waitFor({ timeout: 60000 });
    assert((await rows.count()) >= 3, "expected seeded openings");
    await page.getByTestId("opening-row").filter({ hasText: "Sample opening" }).first().getByRole("meter").waitFor();
    await rows.filter({ hasText: `Python API Engineer ${stamp}` }).waitFor();
    await shot(page, "lb-04-openings");
  });

  let openingId = "";
  await check("applying needs explicit consent", async () => {
    await page.getByTestId("opening-row").filter({ hasText: `Python API Engineer ${stamp}` }).getByRole("link", { name: /View opening/ }).click();
    await page.waitForURL(/\/openings\/[\w-]+\?resume=/);
    openingId = new URL(page.url()).pathname.split("/").pop();
    assert(openingId === newOpeningId, "row linked to the wrong opening");
    await page.getByRole("heading", { name: /Your match/ }).waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByText("Tick the box to agree before applying").waitFor();
    assert((await page.getByTestId("standing-unavailable").count()) === 0, "applied without consent");
    // the server enforces it too
    const r = await call(a, "POST", `/api/openings/${openingId}/apply`, { data: { version_id: A.versionId, share_consent: false } });
    assert(r.status() === 422 && (await r.json()).detail.code === "consent_required", "server accepted an application without consent");
    await page.getByLabel(/The HR team for this opening will see this resume version and its score/).check();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.getByText("Application sent.").waitFor();
  });

  await check("'Where you stand' with 1 applicant shows the not-enough-applicants state", async () => {
    const s = page.getByTestId("standing-unavailable");
    await s.waitFor();
    await s.getByText("1 applicant so far").waitFor();
    await page.getByText(/Recruiter stage/).waitFor();
    await shot(page, "lb-05-standing-1-applicant");
  });

  // ------------------------------------------------------------ candidates B and C apply to the same opening
  let B, C, b, c;
  await check("two more candidates apply", async () => {
    b = await newUser(browser, `lb-b-${stamp}@example.com`);
    c = await newUser(browser, `lb-c-${stamp}@example.com`);
    B = await uploadConfirmed(b, "p09");
    C = await uploadConfirmed(c, "p06");
    await ok(await call(b, "POST", `/api/openings/${openingId}/apply`, { data: { version_id: B.versionId, share_consent: true } }), "B applies");
    await ok(await call(c, "POST", `/api/openings/${openingId}/apply`, { data: { version_id: C.versionId, share_consent: true } }), "C applies");
  });

  await check("'Where you stand' shows a rank once 3 people applied", async () => {
    await page.reload();
    const s = page.getByTestId("standing-available");
    await s.waitFor({ timeout: 60000 });
    await s.getByText(/of 3$/).waitFor();
    await s.getByText(/top \d+%/).first().waitFor();
    await s.getByRole("img", { name: /Anonymous score distribution/ }).waitFor();
    await page.getByRole("heading", { name: "How to improve for this opening" }).waitFor();
    await page.getByTestId("tips-content").waitFor({ timeout: 60000 });
    await shot(page, "lb-06-standing-ranked");
  });

  await check("openings page lists openings and my applications", async () => {
    await page.goto(`${BASE}/openings`);
    await page.getByTestId("opening-card").first().waitFor();
    await page.getByRole("heading", { name: "My applications" }).waitFor();
    await page.locator("section[aria-labelledby=my-apps]").getByText(/#\d of 3/).first().waitFor();
    await shot(page, "lb-07-openings-page");
  });

  await check("a candidate can't open /recruiter", async () => {
    await page.goto(`${BASE}/recruiter`);
    await page.getByRole("heading", { name: "HR staff only" }).waitFor();
    assert((await page.getByRole("link", { name: "Recruiter" }).count()) === 0, "candidate sees the Recruiter nav link");
    const r = await call(a, "GET", "/api/recruiter/openings");
    assert(r.status() === 403, "recruiter API is not forbidden for candidates");
  });

  await check("recruiter sees ranked candidates and shortlists one", async () => {
    await recPage.reload();
    const rows = recPage.getByTestId("candidate-row");
    await rows.first().waitFor({ timeout: 30000 });
    assert((await rows.count()) === 3, "expected 3 candidate rows");
    await recPage.getByText("A reading order, not a decision").waitFor();
    await recPage.getByText(/not to reject people automatically/).waitFor();
    const scores = await rows.getByRole("meter").evaluateAll((els) => els.map((e) => Number(e.getAttribute("aria-valuenow"))));
    assert(scores.every((s, i) => i === 0 || scores[i - 1] >= s), `candidates not ranked by score: ${scores}`);
    const firstName = (await rows.first().getByRole("link").innerText()).trim();
    await recPage.getByLabel(`Stage for ${firstName}`).selectOption("shortlisted");
    await recPage.waitForResponse((r) => r.url().includes("/api/recruiter/applications/") && r.request().method() === "PATCH");
    await recPage.reload();
    await recPage.getByTestId("candidate-row").first().waitFor();
    const v = await recPage.getByLabel(`Stage for ${firstName}`).inputValue();
    assert(v === "shortlisted", "stage did not persist");
    await shot(recPage, "lb-08-recruiter-candidates");
  });

  await check("recruiter candidate detail: match breakdown + read-only resume", async () => {
    await recPage.getByTestId("candidate-row").first().getByRole("link").click();
    await recPage.waitForURL(/\/recruiter\/applications\//);
    await recPage.getByRole("heading", { name: "Resume as submitted" }).waitFor();
    await recPage.getByRole("heading", { name: "Requirement by requirement" }).waitFor();
    await recPage.getByRole("article", { name: "Resume preview" }).waitFor();
    await shot(recPage, "lb-09-recruiter-candidate-detail");
  });

  await check("recruiter closes and reopens an opening", async () => {
    await recPage.goto(`${BASE}/recruiter/openings/${newOpeningId}`);
    await recPage.getByRole("button", { name: "Close opening" }).click();
    await recPage.getByText(/Opening closed/).waitFor();
    await recPage.getByRole("button", { name: "Reopen" }).click();
    await recPage.getByText("Opening reopened.").waitFor();
  });

  await check("no horizontal overflow at 375px and 1280px", async () => {
    const m = watch(await a.newPage());
    const pages = [
      [`/resumes/${A.resumeId}/leaderboard`, () => m.getByTestId("role-row").first().waitFor({ timeout: 60000 })],
      [`/openings/${openingId}?resume=${A.resumeId}`, () => m.getByTestId("standing-available").waitFor({ timeout: 60000 })],
      [`/openings`, () => m.getByTestId("opening-card").first().waitFor()],
    ];
    for (const w of [375, 1280]) {
      await m.setViewportSize({ width: w, height: 860 });
      for (const [p, ready] of pages) {
        await m.goto(BASE + p);
        await ready();
        await noOverflow(m, p);
      }
    }
    await m.setViewportSize({ width: 375, height: 860 });
    await m.goto(`${BASE}/resumes/${A.resumeId}/leaderboard`);
    await m.getByTestId("role-row").first().waitFor({ timeout: 60000 });
    await m.screenshot({ path: path.join(OUT, "lb-10-mobile-leaderboard.png") });
    await m.goto(`${BASE}/openings/${openingId}?resume=${A.resumeId}`);
    await m.getByTestId("standing-available").waitFor({ timeout: 60000 });
    await m.screenshot({ path: path.join(OUT, "lb-11-mobile-opening.png"), fullPage: true });
    const rm = watch(await rec.newPage());
    for (const w of [375, 1280]) {
      await rm.setViewportSize({ width: w, height: 860 });
      await rm.goto(`${BASE}/recruiter/openings/${newOpeningId}`);
      await rm.getByTestId("candidate-row").first().waitFor();
      await noOverflow(rm, "recruiter opening");
    }
    await rm.screenshot({ path: path.join(OUT, "lb-12-recruiter-1280.png") });
  });

  await check("no uncaught page errors", async () => {
    const real = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
    if (real.length) throw new Error(real.slice(0, 3).join(" | "));
  });
} catch {
  if (page) await shot(page, "FAILED-" + step.replace(/\W+/g, "-")).catch(() => {});
} finally {
  await browser.close();
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
