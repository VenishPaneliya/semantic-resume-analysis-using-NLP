// E2E for the Hindi / Gujarati interface: language switching and persistence, <html lang>, every main page in
// en / hi / gu at 375px and 1280px (no horizontal overflow, no console errors, UI chrome actually translated),
// and screenshots e2e/screenshots/i18n-*.png.
// Usage (from frontend/):
//   BASE_URL=http://localhost:3012 BACKEND_LOG=<backend log> node e2e/i18n.mjs
// Backend: RECRUITER_EMAILS=hr@example.com REQUIRE_MFA_FOR_STAFF=false EMAIL_BACKEND=console LLM_PROVIDER=fixture,
// demo openings seeded (scripts/seed_demo_openings.py). Verification tokens are read from the backend log.
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3012";
const LOG = process.env.BACKEND_LOG ?? "e2e/backend-i18n.log";
const FIX = "e2e/fixtures/personas";
const OUT = "e2e/screenshots";
const HR_EMAIL = process.env.HR_EMAIL ?? "hr@example.com";
const LOCALES = ["en", "hi", "gu"];
const WIDTHS = [375, 1280];
// Screenshots go outside the project during the run (new files under frontend/ make `next dev` recompile)
// and are copied into e2e/screenshots at the end.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), "ri-e2e-i18n-"));
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const password = "Correct-horse-42";
const results = [];
const warnings = [];
let step = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---- API helpers acting as a browser context (same cookies + CSRF as the real UI)
async function csrf(ctx) {
  return (await ctx.cookies()).find((c) => c.name === "ri_csrf")?.value ?? "";
}
async function call(ctx, method, p, opts = {}) {
  for (let i = 0; ; i++) {
    const r = await ctx.request.fetch(BASE + p, { method, timeout: 240000, headers: { "x-csrf-token": await csrf(ctx) }, ...opts });
    if (r.status() !== 429 || i >= 30) return r;
    await sleep(5000);
  }
}
async function ok(r, what) {
  if (!r.ok()) throw new Error(`${what}: HTTP ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
}
async function newUser(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ok(await call(ctx, "POST", "/api/auth/register", { data: { email, password } }), "register " + email);
  for (let i = 0; ; i++) {
    try {
      await ok(await call(ctx, "POST", "/api/auth/verify-email", { data: { token: tokenFromLog(email) } }), "verify " + email);
      break;
    } catch (e) {
      if (i > 20) throw e;
      await sleep(250);
    }
  }
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
    await sleep(1000);
  }
  if (!ex) throw new Error("extraction never became available");
  const rv = await ok(await call(ctx, "PUT", `/api/resumes/${up.id}/review`, { data: { content: ex.content } }), "confirm review");
  return { resumeId: up.id, versionId: rv.version_id };
}
async function applyTo(ctx, openingId, versionId) {
  for (let i = 0; ; i++) {
    const r = await call(ctx, "POST", `/api/openings/${openingId}/apply`, { data: { version_id: versionId, share_consent: true } });
    if (r.status() < 500 || i >= 3) return ok(r, "apply");
    await sleep(3000);
  }
}

// ---- page helpers
const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const consoleErrors = [];
function watch(page) {
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${page.url()} :: ${m.text()}`));
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: ${e}`));
  page.on("response", (r) => r.status() === 429 && (page.rateLimited = true));
  page.setDefaultNavigationTimeout(120000); // first hit of a route compiles it under `next dev`
  page.setDefaultTimeout(45000);
  return page;
}
const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);
const stored = (page) =>
  page.evaluate(() => ({ ls: localStorage.getItem("ri_lang"), cookie: (document.cookie.match(/(?:^|; )ri_lang=(\w+)/) ?? [])[1] ?? null }));
/** Make `loc` the remembered language for this context (as the switcher does), without touching the UI. */
async function rememberLocale(page, loc) {
  await page.evaluate((l) => {
    localStorage.setItem("ri_lang", l);
    document.cookie = `ri_lang=${l}; path=/; max-age=31536000; samesite=lax`;
  }, loc);
}
async function settle(page) {
  try {
    await page.locator("main").first().waitFor();
  } catch (e) {
    if (page.rateLimited) return; // the shell shows an error instead of <main>; visit() retries
    throw e;
  }
  // wait until nothing in the page is still spinning (data loads, AI fixture calls)
  for (let i = 0; i < 240; i++) {
    const spinning = await page.locator("main .animate-spin").count();
    if (!spinning) break;
    await sleep(500);
  }
  await page.evaluate(() => document.fonts.ready);
  await sleep(250);
}
/** Load a page and let it settle. The backend rate-limits API calls per IP (API_RATE_PER_MINUTE) and this sweep
    loads many pages quickly, so if any request was throttled, wait for the window to pass and load it again. */
async function visit(page, url) {
  for (let i = 0; ; i++) {
    page.rateLimited = false;
    await page.goto(url);
    await settle(page);
    if (!page.rateLimited) return;
    if (i >= 6) throw new Error(`still rate-limited loading ${url}`);
    rateLimitWaits++;
    await sleep(20000);
  }
}
let rateLimitWaits = 0;

async function noOverflow(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) {
    const culprit = await page.evaluate(() => {
      const w = window.innerWidth;
      const els = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > w + 1);
      const e = els.at(-1);
      return e ? `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} "${(e.textContent ?? "").trim().slice(0, 40)}"` : "?";
    });
    throw new Error(`horizontal overflow of ${over}px on ${label} at ${page.viewportSize().width}px (${culprit})`);
  }
}
const INDIC = /[ऀ-ॿ઀-૿]/;
const SCRIPT = { hi: /[ऀ-ॿ]/, gu: /[઀-૿]/ };
async function headings(page) {
  return (await page.locator("main h1, main h2").allInnerTexts()).map((s) => s.trim()).filter(Boolean).join(" | ");
}
/** UI chrome elements (buttons, labels, tabs, table headers, nav) whose text is English words with no Indic
    script. In hi/gu these are reported; text that legitimately stays English (brand, skills, API data shown in
    buttons) is allowed below. */
const ALLOW = [/^Resume Intelligence$/, /^English$/, /^[A-Z]{2,5}$/, /^[\d\s.%#·/:–+-]+$/, /^v\d+/, /^Word \(DOCX\)$/, /^US Letter$/, /^A4$/, /^AI \(\d+\)$/, /^Google$/];
async function englishChrome(page) {
  const texts = await page
    .locator("header nav a, header nav button, main button, main label, main th, main [role=tab], main legend, main .eyebrow, main h1, main h2, main h3")
    .evaluateAll((els) =>
      els
        // text marked lang="en" is API data (role titles, rubric categories, opening titles) and stays English
        .filter((e) => e.offsetParent !== null && !e.closest("[lang=en], article"))
        .map((e) => {
          const c = e.cloneNode(true);
          c.querySelectorAll("[lang=en]").forEach((x) => x.remove());
          return (c.textContent ?? "").trim().replace(/\s+/g, " ");
        })
        .filter(Boolean),
    );
  return [...new Set(texts)].filter((s) => /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s) && !INDIC.test(s) && !ALLOW.some((r) => r.test(s)));
}
async function shot(page, name, full = true) {
  await page.screenshot({ path: path.join(SHOTS, `i18n-${name}.png`), fullPage: full });
}

let failPage;
try {
  // ------------------------------------------------------------------------------------------- setup
  let a, b, A, B, openingId, appA, appB, rec;
  await check("setup: candidates with confirmed resumes apply to a seeded opening; recruiter signs up", async () => {
    a = await newUser(browser, `i18n-a-${stamp}@example.com`);
    b = await newUser(browser, `i18n-b-${stamp}@example.com`);
    A = await uploadConfirmed(a, "p02");
    B = await uploadConfirmed(b, "p09");
    const openings = await ok(await call(a, "GET", "/api/openings"), "openings");
    const list = Array.isArray(openings) ? openings : (openings.items ?? openings.openings ?? []);
    openingId = list[0].id;
    appA = (await applyTo(a, openingId, A.versionId)).id;
    appB = (await applyTo(b, openingId, B.versionId)).id;
    rec = await newUser(browser, HR_EMAIL).catch(async (e) => {
      if (!/HTTP 409|already/i.test(e.message)) throw e;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ok(await call(ctx, "POST", "/api/auth/login", { data: { email: HR_EMAIL, password } }), "recruiter login");
      return ctx;
    });
  });

  // ------------------------------------------------------------------------------------------- switching
  await check("default is English; header switcher → हिन्दी updates <html lang>, nav, storage and survives reload", async () => {
    const p = (failPage = watch(await a.newPage()));
    await p.goto(BASE + "/dashboard");
    await settle(p);
    assert((await htmlLang(p)) === "en", "default <html lang> is not en");
    const nav = p.getByTestId("main-nav");
    await nav.getByRole("link", { name: "Resumes" }).waitFor();
    await nav.getByTestId("lang-switcher").selectOption("hi");
    await nav.getByRole("link", { name: "रिज़्यूमे" }).waitFor();
    assert((await htmlLang(p)) === "hi", "<html lang> did not switch to hi");
    const s = await stored(p);
    assert(s.ls === "hi" && s.cookie === "hi", `choice not stored: ${JSON.stringify(s)}`);
    const res = await p.reload();
    assert(/<html[^>]*lang="hi"/.test(await res.text()), "server did not render <html lang=hi> after reload");
    await settle(p);
    assert((await htmlLang(p)) === "hi", "hi did not persist across reload");
    await nav.getByRole("link", { name: "रिज़्यूमे" }).waitFor();
    await p.close();
  });

  await check("mobile menu switcher → ગુજરાતી persists; Settings selector → English persists", async () => {
    const p = (failPage = watch(await a.newPage()));
    await p.setViewportSize({ width: 375, height: 800 });
    await p.goto(BASE + "/dashboard");
    await settle(p);
    await p.getByRole("button", { name: "मेनू" }).click();
    const menu = p.getByTestId("mobile-nav");
    await menu.getByTestId("lang-switcher").selectOption("gu");
    await menu.getByRole("link", { name: "રિઝ્યુમે" }).waitFor();
    assert((await htmlLang(p)) === "gu", "<html lang> did not switch to gu");
    await shot(p, "gu-mobile-menu", false);
    await p.reload();
    await settle(p);
    assert((await htmlLang(p)) === "gu", "gu did not persist across reload");
    await p.goto(BASE + "/settings");
    await settle(p);
    await p.getByTestId("lang-select").selectOption("en");
    await p.getByRole("button", { name: "Menu" }).waitFor();
    assert((await htmlLang(p)) === "en", "<html lang> did not switch back to en");
    await p.reload();
    await settle(p);
    assert((await htmlLang(p)) === "en", "en did not persist across reload");
    const s = await stored(p);
    assert(s.ls === "en" && s.cookie === "en", `choice not stored: ${JSON.stringify(s)}`);
    await p.close();
  });

  await check("signed-out pages: switcher on landing and login; localStorage restores a lost cookie", async () => {
    const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = (failPage = watch(await anon.newPage()));
    await p.goto(BASE + "/");
    await settle(p);
    const enH1 = await p.locator("h1").innerText();
    await p.getByTestId("lang-switcher").selectOption("gu");
    await p.waitForFunction((t) => document.querySelector("h1")?.textContent !== t, enH1);
    assert((await htmlLang(p)) === "gu", "landing: <html lang> not gu");
    await p.goto(BASE + "/login");
    await settle(p);
    assert((await htmlLang(p)) === "gu", "login: gu not kept across navigation");
    await p.getByRole("heading", { name: "સાઇન ઇન કરો" }).waitFor();
    await p.getByTestId("lang-switcher").selectOption("hi");
    await p.getByRole("heading", { name: "साइन इन करें" }).waitFor();
    // cookie lost (e.g. cleared) but localStorage remembers: the provider restores the choice
    await anon.clearCookies();
    await p.reload();
    await p.getByRole("heading", { name: "साइन इन करें" }).waitFor();
    assert((await htmlLang(p)) === "hi", "localStorage did not restore hi");
    assert((await stored(p)).cookie === "hi", "cookie not re-written from localStorage");
    await p.getByTestId("lang-switcher").selectOption("en");
    await p.getByRole("heading", { name: "Sign in" }).waitFor();
    await anon.close();
  });

  // ------------------------------------------------------------------------------------------- sweep
  const R = `/resumes/${A.resumeId}`;
  const candidatePages = [
    ["landing", "/", "anon"],
    ["login", "/login", "anon"],
    ["register", "/register", "anon"],
    ["forgot", "/forgot-password", "anon"],
    ["dashboard", "/dashboard"],
    ...["review", "analysis", "leaderboard", "match", "editor", "career", "progress", "interview"].map((t) => [`resume-${t}`, `${R}/${t}`]),
    ["openings", "/openings"],
    ["opening-detail", `/openings/${openingId}?resume=${A.resumeId}`],
    ["applications", "/applications"],
    ["learning", "/learning"],
    ["settings", "/settings"],
  ];
  const recruiterPages = [
    ["recruiter", "/recruiter"],
    ["recruiter-opening", `/recruiter/openings/${openingId}`],
    ["recruiter-compare", `/recruiter/openings/${openingId}/compare?ids=${appA},${appB}`],
    ["recruiter-application", `/recruiter/applications/${appA}`],
    ["recruiter-analytics", "/recruiter/analytics"],
    ["recruiter-fairness", "/recruiter/fairness"],
  ];
  const SHOT_PAGES = new Set(["landing", "login", "dashboard", "resume-analysis", "resume-leaderboard", "resume-editor", "openings", "opening-detail", "settings", "recruiter-opening", "recruiter-application"]);

  const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxFor = { anon: anonCtx, cand: a, rec };
  const english = {}; // page name -> { headings, nav }

  for (const loc of LOCALES) {
    await check(`every page in ${loc}: no overflow at 375/1280, chrome translated`, async () => {
      const pages = {};
      for (const [who, ctx] of Object.entries(ctxFor)) {
        pages[who] = watch(await ctx.newPage());
        await pages[who].goto(BASE + (who === "anon" ? "/login" : "/settings"));
        await rememberLocale(pages[who], loc);
      }
      const all = [...candidatePages.map((x) => [...x.slice(0, 2), x[2] ?? "cand"]), ...recruiterPages.map((x) => [...x, "rec"])];
      for (const [name, url, who] of all) {
        const p = (failPage = pages[who]);
        for (const w of WIDTHS) {
          await p.setViewportSize({ width: w, height: 900 });
          await visit(p, BASE + url);
          assert((await htmlLang(p)) === loc, `${name}: <html lang> is ${await htmlLang(p)}, expected ${loc}`);
          await noOverflow(p, `${name} (${loc})`);
          if (loc !== "en" && SHOT_PAGES.has(name)) await shot(p, `${loc}-${name}-${w}`);
          if (w !== 1280) continue;
          const h = await headings(p);
          const nav = who === "anon" ? "" : await p.getByTestId("main-nav").innerText();
          if (loc === "en") {
            english[name] = { h, nav };
            continue;
          }
          const en = english[name];
          assert(h && h !== en.h, `${name} (${loc}): main headings are the same as English: "${h.slice(0, 80)}"`);
          assert(SCRIPT[loc].test(h), `${name} (${loc}): main headings contain no ${loc} script: "${h.slice(0, 80)}"`);
          if (who !== "anon") {
            assert(nav !== en.nav, `${name} (${loc}): nav is the same as English`);
            const links = await p.getByTestId("main-nav").getByRole("link").allInnerTexts();
            const bad = links.filter((l) => !SCRIPT[loc].test(l) && l.trim() !== "Resume Intelligence");
            assert(!bad.length, `${name} (${loc}): untranslated nav items: ${bad.join(", ")}`);
          }
          const tabs = name.startsWith("resume-") ? await p.getByTestId("resume-tabs").innerText() : "";
          if (tabs) assert(SCRIPT[loc].test(tabs) && !/Analysis|Leaderboard|Interview/.test(tabs), `${name} (${loc}): resume tabs not translated`);
          const leftovers = await englishChrome(p);
          if (leftovers.length) warnings.push(`${loc} ${name}: ${leftovers.slice(0, 12).map((s) => JSON.stringify(s.slice(0, 60))).join(", ")}`);
        }
      }
      for (const p of Object.values(pages)) await p.close();
    });
  }

  await check("no console errors on any page", async () => {
    const real = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
    if (real.length) throw new Error(`${real.length} errors: ${real.slice(0, 3).join(" || ")}`);
  });

  if (process.env.STRICT_CHROME !== "0")
    await check("no untranslated English in UI chrome (hi, gu)", async () => {
      if (warnings.length) throw new Error(`${warnings.length} pages with English chrome:\n  ${warnings.join("\n  ")}`);
    });
} catch {
  if (failPage) await failPage.screenshot({ path: path.join(SHOTS, "i18n-FAILED-" + step.replace(/\W+/g, "-").slice(0, 60) + ".png") }).catch(() => {});
} finally {
  await browser.close();
  for (const f of fs.readdirSync(SHOTS)) fs.copyFileSync(path.join(SHOTS, f), path.join(OUT, f));
  fs.rmSync(SHOTS, { recursive: true, force: true });
  if (warnings.length) console.log(`\nEnglish left in UI chrome:\n  ${warnings.join("\n  ")}`);
  const failed = results.filter((r) => r[0] === "FAIL").length;
  if (rateLimitWaits) console.log(`(waited out the API rate limit ${rateLimitWaits} times)`);
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
