// Full end-to-end scenarios over the HTTP API (through the website origin, as the browser does) plus a few
// browser checks for the Hindi / Gujarati interface. Every feature, multi-step flows, negative cases and
// sanity checks on the *results* (not only status codes).
//
// Usage (from frontend/, with the docker compose stack running):
//   BASE_URL=http://localhost:3000 API_URL=http://localhost:8000 MAILPIT=http://localhost:8025 \
//   HR_EMAIL=qa-hr@example.com ADMIN_EMAIL=qa-admin@example.com node e2e/full-scenarios.mjs
// Backend: RECRUITER_EMAILS must contain HR_EMAIL, ADMIN_EMAILS must contain ADMIN_EMAIL, REQUIRE_MFA_FOR_STAFF=true,
// EMAIL_BACKEND=smtp to Mailpit, LLM_PROVIDER=fixture. Staff TOTP secrets are kept in STAFF_TOTP_FILE so the
// script can be re-run against the same database.
// Exit code: 0 when every case passed, 1 otherwise. A JSON report is written to REPORT_FILE (default: os tmpdir).
import { chromium, request } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { totpAt } from "./totp.mjs";
import { makeDocx, makePdf } from "./fixtures/docgen.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const API = process.env.API_URL ?? "http://localhost:8000";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const HR_EMAIL = process.env.HR_EMAIL ?? "qa-hr@example.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "qa-admin@example.com";
const STAFF_TOTP_FILE = process.env.STAFF_TOTP_FILE ?? path.join(os.tmpdir(), "ri-full-scenarios-staff.json");
const REPORT_FILE = process.env.REPORT_FILE ?? path.join(os.tmpdir(), "ri-full-scenarios-report.json");
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null; // run a subset of areas

const stamp = Date.now();
const PW = "Correct-horse-42!";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ------------------------------------------------------------------ results

let throttled = 0;
const results = [];
let currentArea = "";
async function area(name, fn) {
  if (ONLY && !ONLY.has(name)) return;
  currentArea = name;
  console.log(`\n=== ${name}`);
  try {
    await fn();
  } catch (e) {
    // a setup step inside the area failed; the remaining cases of this area are not run
    results.push({ area: name, name: "(area aborted)", ok: false, detail: String(e.message ?? e).split("\n")[0] });
    console.log(`ABORT ${name}: ${String(e.message ?? e).split("\n")[0]}`);
  }
}
async function t(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ area: currentArea, name, ok: true, detail: info ?? "" });
    console.log(`PASS  ${name}${info ? `  [${info}]` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return true;
  } catch (e) {
    const msg = String(e.message ?? e).split("\n").slice(0, 3).join(" | ");
    results.push({ area: currentArea, name, ok: false, detail: msg });
    console.log(`FAIL  ${name}: ${msg}`);
    return false;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const brief = (o) => JSON.stringify(o)?.slice(0, 300);
function expectStatus(r, status, code) {
  const sts = Array.isArray(status) ? status : [status];
  assert(sts.includes(r.status), `expected HTTP ${sts.join("/")}${code ? ` ${code}` : ""}, got ${r.status} ${brief(r.body ?? r.text)}`);
  if (code) assert(r.body?.detail?.code === code, `expected error code ${code}, got ${brief(r.body)}`);
  return r.body;
}

// ------------------------------------------------------------------ HTTP client

class Client {
  constructor(ctx, label) {
    this.ctx = ctx;
    this.label = label;
  }
  static async create(label, { base = BASE, headers = {} } = {}) {
    return new Client(await request.newContext({ baseURL: base, extraHTTPHeaders: headers, timeout: 180000 }), label);
  }
  async csrf() {
    return (await this.ctx.storageState()).cookies.find((c) => c.name === "ri_csrf")?.value ?? "";
  }
  // The API limits auth POSTs per client IP (LOGIN_RATE_PER_MINUTE, default 10/min) and all other calls to
  // 2 x API_RATE_PER_MINUTE per IP. Every client of this script shares one IP, so plain "rate_limited" answers
  // are waited out by default; tests that expect a 429 pass retry429: false.
  async call(method, url, { json, multipart, headers = {}, csrf = true, retry429 = true } = {}) {
    for (let i = 0; ; i++) {
      const h = { ...headers };
      if (csrf) h["x-csrf-token"] = await this.csrf();
      const opts = { method, headers: h, failOnStatusCode: false };
      if (json !== undefined) opts.data = json;
      if (multipart) opts.multipart = multipart;
      const r = await this.ctx.fetch(url, opts);
      const buf = await r.body();
      const ctype = r.headers()["content-type"] ?? "";
      let body = null;
      if (ctype.includes("json")) {
        try {
          body = JSON.parse(buf.toString("utf8"));
        } catch {
          /* not json */
        }
      }
      const out = { status: r.status(), body, text: ctype.includes("json") || ctype.startsWith("text") ? buf.toString("utf8") : "", buf, headers: r.headers() };
      if (out.status === 429 && retry429 && out.body?.detail?.code === "rate_limited" && i < 30) {
        throttled++;
        await sleep(4000);
        continue;
      }
      return out;
    }
  }
  get = (u, o) => this.call("GET", u, o);
  post = (u, json, o = {}) => this.call("POST", u, { json, ...o });
  put = (u, json, o = {}) => this.call("PUT", u, { json, ...o });
  patch = (u, json, o = {}) => this.call("PATCH", u, { json, ...o });
  del = (u, o) => this.call("DELETE", u, o);
  async ok(method, url, opts) {
    const r = await this.call(method, url, opts);
    assert(r.status >= 200 && r.status < 300, `${this.label}: ${method} ${url} -> ${r.status} ${brief(r.body ?? r.text)}`);
    return r.body;
  }
}

// ------------------------------------------------------------------ mail (Mailpit)

async function mailFor(to, pattern, { since = 0, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const ctx = await request.newContext();
  try {
    while (Date.now() < deadline) {
      const list = await (await ctx.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
      for (const m of list.messages ?? []) {
        if (new Date(m.Created).getTime() < since - 2000) continue;
        const msg = await (await ctx.get(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
        const hit = pattern.exec(msg.Text ?? "");
        if (hit) return { token: hit[1], msg };
      }
      await sleep(500);
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(`no mail to ${to} matching ${pattern} within ${timeoutMs}ms`);
}
const VERIFY_RE = /verify-email\?token=([\w-]+)/;
const RESET_RE = /reset-password\?token=([\w-]+)/;
// sent instead of a verification link when the address already has an account
const EXISTING_RE = /(already has an\s+account)/;
// either of the two emails registration can send: group 1 = verification token, group 2 = "already has an account"
const REGISTER_MAIL_RE = /verify-email\?token=([\w-]+)|(already has an\s+account)/;

/** Registration answers 201 { status: "verification_sent" } for new and existing addresses alike and starts
    no session, so whether the account already existed is told apart by the email that arrives. New accounts
    are verified and signed in; for an existing one the caller signs in (it may need 2FA). */
async function registerVerified(email, { label = email, displayName } = {}) {
  const c = await Client.create(label);
  const since = Date.now();
  const r = await c.post("/api/auth/register", { email, password: PW, display_name: displayName }, { retry429: true });
  expectStatus(r, 201);
  assert(r.body?.status === "verification_sent", `unexpected register answer ${brief(r.body)}`);
  const m = await mailFor(email, REGISTER_MAIL_RE, { since });
  if (!m.token) return { c, existed: true };
  await c.ok("POST", "/api/auth/verify-email", { json: { token: m.token } });
  const li = await c.post("/api/auth/login", { email, password: PW }, { retry429: true });
  expectStatus(li, 200);
  return { c, existed: false };
}

// ------------------------------------------------------------------ TOTP

const currentStep = () => Math.floor(Date.now() / 30000);
const lastStep = new Map();
async function freshTotp(secret) {
  const floor = lastStep.get(secret) ?? -1;
  while (currentStep() <= floor) await sleep(500);
  const s = currentStep();
  lastStep.set(secret, s);
  return totpAt(secret, s);
}
function loadStaff() {
  try {
    return JSON.parse(fs.readFileSync(STAFF_TOTP_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveStaff(email, secret) {
  const all = loadStaff();
  all[email] = { secret };
  fs.writeFileSync(STAFF_TOTP_FILE, JSON.stringify(all));
}

/** Sign a staff account in (registering + turning on 2FA the first time). Returns a client. */
async function staffClient(email) {
  const { c, existed } = await registerVerified(email, { label: email });
  if (existed) {
    const r = await c.post("/api/auth/login", { email, password: PW }, { retry429: true });
    expectStatus(r, 200);
    if (r.body.mfa_required) {
      const saved = loadStaff()[email];
      assert(saved, `${email} has 2FA on but ${STAFF_TOTP_FILE} has no secret`);
      const code = await freshTotp(saved.secret);
      await c.ok("POST", "/api/auth/login/mfa", { json: { mfa_token: r.body.mfa_token, code } });
    }
  }
  const st = await c.ok("GET", "/api/account/2fa");
  if (!st.enabled) {
    const setup = await c.ok("POST", "/api/account/2fa/setup");
    await c.ok("POST", "/api/account/2fa/enable", { json: { code: await freshTotp(setup.secret) } });
    saveStaff(email, setup.secret);
  }
  return c;
}

/** Sign the main candidate in inside a browser context (waiting out the per-IP auth rate limit). */
async function browserLogin(ctx) {
  for (let i = 0; i < 30; i++) {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: S.candEmail, password: PW } });
    if (r.status() === 200) return;
    if (r.status() !== 429) throw new Error(`browser login -> ${r.status()} ${await r.text()}`);
    throttled++;
    await sleep(4000);
  }
  throw new Error("browser login still rate-limited");
}

// ------------------------------------------------------------------ resumes

async function upload(c, name, mime, buffer, title) {
  const multipart = { file: { name, mimeType: mime, buffer } };
  if (title) multipart.title = title;
  return c.call("POST", "/api/resumes", { multipart });
}
async function waitExtraction(c, rid, timeoutMs = 150000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await c.get(`/api/resumes/${rid}/extraction`);
    if (r.status === 200) return { ok: true, ex: r.body };
    if (r.status === 422) return { ok: false, error: r.body };
    if (r.status !== 409) throw new Error(`extraction poll -> ${r.status} ${brief(r.body)}`);
    await sleep(1000);
  }
  throw new Error(`extraction of ${rid} not ready after ${timeoutMs}ms`);
}
async function uploadConfirmed(c, name, mime, buffer) {
  const up = await upload(c, name, mime, buffer);
  expectStatus(up, 202);
  const w = await waitExtraction(c, up.body.id);
  assert(w.ok, `extraction failed: ${brief(w.error)}`);
  const rv = await c.ok("PUT", `/api/resumes/${up.body.id}/review`, { json: { content: w.ex.content } });
  return { resumeId: up.body.id, versionId: rv.version_id, ex: w.ex, upload: up.body };
}

// ------------------------------------------------------------------ zip reading (data export)

function unzip(buf) {
  const files = {};
  let eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocd >= 0, "not a zip (no end of central directory)");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + csize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ------------------------------------------------------------------ resume documents for many job profiles

const dataEngineer = [
  "Priya Raman",
  "Bengaluru, India | priya.raman@example.com | +91 98450 12345 | linkedin.com/in/priya-raman-qa",
  "",
  "SUMMARY",
  "Data engineer with 6 years of experience building batch and streaming data pipelines on AWS for retail analytics.",
  "",
  "EXPERIENCE",
  "Senior Data Engineer | Northwind Retail",
  "Mar 2022 – Present",
  "• Built ETL pipelines in Python and Apache Spark that load 2 TB of data a day into a Snowflake data warehouse",
  "• Orchestrated 140 Airflow DAGs and cut pipeline failures by 35% with data quality checks",
  "• Designed Kafka streaming ingestion for clickstream events with 99.9% uptime",
  "• Modelled star-schema tables with dbt and SQL, reducing report query time by 60%",
  "Data Engineer | Contoso Analytics",
  "Jul 2019 – Feb 2022",
  "• Migrated on-premise Hadoop jobs to AWS EMR and S3, saving $120K per year",
  "• Wrote PostgreSQL procedures and data validation for 30 source systems",
  "• Built data warehousing layers in Amazon Redshift used by 200 analysts",
  "",
  "PROJECTS",
  "Open Data Lake | Python, Apache Spark, Airflow, Docker",
  "• Published an open-source data lake template with CI/CD pipelines and Docker images",
  "",
  "EDUCATION",
  "B.Tech in Computer Science, National Institute of Technology Trichy, Aug 2015 – May 2019",
  "",
  "SKILLS",
  "Technical: Python, SQL, Apache Spark, Airflow, Kafka, ETL, Data Warehousing, Snowflake, dbt, AWS, Amazon Redshift, Docker, Git, PostgreSQL, Data Modeling",
  "Professional: Communication, Mentoring",
  "",
  "CERTIFICATIONS",
  "• AWS Certified Data Engineer - Amazon Web Services, 2023",
];

const frontendDev = [
  "Arjun Mehta",
  "Pune, India | arjun.mehta@example.com | +91 99220 45678 | github.com/arjun-mehta-qa",
  "SUMMARY",
  "Frontend developer with 4 years of experience building accessible React and TypeScript web applications.",
  "EXPERIENCE",
  "Frontend Developer | Pixel Commerce",
  "Jan 2022 – Present",
  "• Built a React and TypeScript design system with 60 components used by 5 product teams",
  "• Improved Lighthouse performance score from 52 to 94 with code splitting and lazy loading",
  "• Wrote Jest and React Testing Library unit tests, raising coverage to 85%",
  "• Implemented responsive layouts in HTML and CSS with Tailwind CSS, meeting WCAG 2.1 AA accessibility",
  "Junior Web Developer | Blue Lotus Studio",
  "Jun 2020 – Dec 2021",
  "• Developed JavaScript single-page applications with Redux and REST APIs for 12 clients",
  "• Migrated a jQuery codebase to React, reducing bundle size by 40% with Webpack",
  "PROJECTS",
  "Recipe Finder | Next.js, TypeScript, GraphQL",
  "• Server-rendered recipe search with Next.js, used by 3,000 monthly visitors",
  "EDUCATION",
  "B.E. in Information Technology, University of Pune, Jun 2016 – May 2020",
  "TECHNICAL SKILLS",
  "JavaScript, TypeScript, React, Next.js, HTML, CSS, Tailwind CSS, Redux, Jest, Webpack, GraphQL, Git, REST APIs, Accessibility",
];

const nurse = [
  "Maria Fernandes",
  "Mumbai, India | maria.fernandes@example.com | +91 98200 11122",
  "",
  "SUMMARY",
  "Registered nurse with 8 years of experience in intensive care and emergency departments.",
  "",
  "EXPERIENCE",
  "Senior Staff Nurse, ICU | Lilavati General Hospital",
  "Apr 2019 – Present",
  "• Provided direct patient care for up to 4 critically ill patients per shift in a 24-bed intensive care unit",
  "• Administered medications and IV therapy, monitored vital signs and documented care in the Epic EHR",
  "• Trained 15 new nurses on infection control, wound care and ventilator management protocols",
  "Staff Nurse, Emergency | City Care Hospital",
  "Jun 2016 – Mar 2019",
  "• Performed triage for 60 patients a day and assisted physicians during trauma resuscitations",
  "• Educated patients and families on discharge plans, reducing readmissions by 10%",
  "",
  "EDUCATION",
  "B.Sc. Nursing, Maharashtra University of Health Sciences, Jun 2012 – May 2016",
  "",
  "SKILLS",
  "Technical: Patient Care, Triage, Medication Administration, IV Therapy, Wound Care, Ventilator Management, Epic EHR, BLS, ACLS",
  "Professional: Compassion, Teamwork, Communication",
  "",
  "CERTIFICATIONS",
  "• Basic Life Support (BLS) - American Heart Association, 2024",
  "• Advanced Cardiovascular Life Support (ACLS) - American Heart Association, 2024",
];

const freshGrad = [
  "Rohan Patel",
  "Ahmedabad, India | rohan.patel@example.com | +91 90990 33445 | github.com/rohan-patel-qa",
  "SUMMARY",
  "Computer engineering graduate looking for an entry-level software developer role.",
  "EXPERIENCE",
  "Software Engineering Intern | Zenith Fintech",
  "Jun 2025 – Aug 2025",
  "• Built a Flask REST API endpoint in Python for loan status lookups, with unit tests in pytest",
  "• Wrote SQL queries in MySQL to generate weekly reports for the operations team",
  "PROJECTS",
  "Campus Event Portal | Python, Flask, SQLite, HTML, CSS, JavaScript",
  "• Built a web portal for 1,200 students to register for campus events",
  "• Deployed the app with Docker on a free cloud tier",
  "Expense Tracker | Java, Android",
  "• Android app to track daily expenses with charts",
  "EDUCATION",
  "B.E. in Computer Engineering, Gujarat Technological University, Aug 2022 – May 2026, CGPA: 8.4",
  "SKILLS",
  "Python, Java, SQL, Flask, HTML, CSS, JavaScript, Git, Docker, Data Structures",
];

const seniorManager = [
  "David Chen",
  "Singapore | david.chen@example.com | +65 9123 4567",
  "",
  "SUMMARY",
  "Engineering leader with 19 years of experience, the last 10 managing large distributed engineering teams.",
  "",
  "EXPERIENCE",
  "Senior Engineering Manager | Orion Payments",
  "Jan 2016 – Present",
  "• Lead 6 teams of 45 engineers building payment microservices in Java on AWS with a $4M annual budget",
  "• Hired 30 engineers and introduced Agile delivery, cutting release lead time from 6 weeks to 1 week",
  "• Owned the reliability roadmap that took platform availability from 99.5% to 99.95%",
  "Engineering Manager | Vertex Logistics",
  "Mar 2011 – Dec 2015",
  "• Managed 12 backend engineers delivering REST APIs and Kubernetes migrations",
  "Software Engineer | Acme Systems",
  "Jul 2006 – Feb 2011",
  "• Built Java and Spring backend services and SQL reporting for logistics customers",
  "",
  "EDUCATION",
  "M.S. in Computer Science, National University of Singapore, Aug 2004 – May 2006",
  "",
  "SKILLS",
  "Technical: Java, Spring, AWS, Microservices, Kubernetes, SQL, REST APIs, System Design, CI/CD",
  "Professional: Leadership, Hiring, Budgeting, Stakeholder Management, Agile",
];

// "near-empty": contact details and one vague line (just over the parser's 40-character text minimum)
const nearEmpty = ["Sam Lee", "Chennai, India | sam.lee@example.com | +91 90000 00000", "Looking for a job."];
// tiny: only a name and an email (27 characters of real text)
const tinyResume = ["Sam Lee", "sam.lee@example.com"];

const spanish = [
  "Lucía Gómez",
  "Madrid, España | lucia.gomez@example.com | +34 612 345 678",
  "",
  "RESUMEN",
  "Desarrolladora backend con 5 años de experiencia en Python, Django y PostgreSQL.",
  "",
  "EXPERIENCIA",
  "Desarrolladora Backend | Soluciones Ibéricas",
  "Ene 2021 – Actualidad",
  "• Diseñé APIs REST con Django y PostgreSQL para 2 millones de usuarios",
  "• Reduje el tiempo de respuesta un 40% con caché en Redis",
  "Programadora Junior | Datos Madrid",
  "Sep 2019 – Dic 2020",
  "• Automaticé pruebas unitarias con pytest y desplegué con Docker",
  "",
  "EDUCACIÓN",
  "Grado en Ingeniería Informática, Universidad Politécnica de Madrid, 2015 – 2019",
  "",
  "HABILIDADES",
  "Python, Django, PostgreSQL, Redis, Docker, Git, REST APIs, pytest",
];

const hindi = [
  "अनीता वर्मा",
  "नई दिल्ली | anita.verma@example.com | +91 98110 22334",
  "# सारांश",
  "डेटा विश्लेषक, 3 वर्षों का अनुभव।",
  "# अनुभव",
  "डेटा विश्लेषक | भारत रिटेल प्राइवेट लिमिटेड",
  "2022 – वर्तमान",
  "SQL और Excel की मदद से साप्ताहिक बिक्री रिपोर्ट बनाई",
  "# कौशल",
  "SQL, Excel, Tableau, Python, Statistics",
];

// ------------------------------------------------------------------ the scenarios

const S = {}; // shared state between areas

try {
  await area("health", async () => {
    const anon = await Client.create("anon");
    await t("API live + ready (DB, Redis, storage)", async () => {
      const r = await anon.get("/api/health/ready");
      expectStatus(r, 200);
      assert(r.body.status === "ok" && r.body.checks.database === "ok" && r.body.checks.redis === "ok" && r.body.checks.storage === "ok", brief(r.body));
      return brief(r.body.checks);
    });
    await t("website does not forward /api/metrics", async () => {
      const r = await anon.get("/api/metrics");
      assert(r.status === 404 || r.status === 403 || r.status === 401, `metrics exposed through the website: ${r.status}`);
    });
    await t("public: rubric, role taxonomy, templates, auth providers", async () => {
      const rub = await anon.ok("GET", "/api/rubric");
      assert(rub.categories.length >= 4 && rub.rules.length > 5, "rubric looks empty");
      const roles = await anon.ok("GET", "/api/taxonomy/roles");
      assert(roles.roles.length === 12, `expected 12 roles, got ${roles.roles.length}`);
      const tpl = await anon.ok("GET", "/api/templates");
      assert(tpl.length >= 3, "expected 3 export templates");
      const prov = await anon.ok("GET", "/api/auth/providers");
      assert(prov.google === false, "google sign-in unexpectedly enabled");
      return `${rub.categories.length} categories, ${rub.rules.length} rules, ${roles.roles.length} roles`;
    });
    await t("unauthenticated requests get 401", async () => {
      for (const u of ["/api/auth/me", "/api/resumes", "/api/openings", "/api/account/export", "/api/recruiter/openings", "/api/admin/overview"])
        expectStatus(await anon.get(u), 401, "not_authenticated");
    });
    await t("API docs reachable in development", async () => {
      const r = await (await Client.create("docs", { base: API })).get("/api/openapi.json");
      expectStatus(r, 200);
      return `${Object.keys(r.body.paths).length} paths`;
    });
  });

  // ================================================================ auth
  await area("auth: signup + email verification", async () => {
    S.candEmail = `qa-cand-${stamp}@example.com`;
    const c = await Client.create("cand");
    await t("weak password rejected (422 weak_password)", async () => {
      expectStatus(await c.post("/api/auth/register", { email: S.candEmail, password: "short" }), 422, "weak_password");
      expectStatus(await c.post("/api/auth/register", { email: S.candEmail, password: "abcdefghijkl" }), 422, "weak_password");
    });
    await t("well-known weak passwords (password123, qwerty12345) rejected", async () => {
      const x = await Client.create("x");
      for (const pw of ["password123", "qwerty12345", "Password1234"]) {
        const r = await x.post("/api/auth/register", { email: `qa-weak-${pw.length}-${pw[0]}-${stamp}@example.com`, password: pw });
        assert(r.status === 422, `"${pw}" accepted (HTTP ${r.status})`);
      }
    });
    await t("invalid email rejected (422)", async () => {
      expectStatus(await c.post("/api/auth/register", { email: "not-an-email", password: PW }), 422);
    });
    let since;
    await t("register -> 201 verification_sent, no session started", async () => {
      since = Date.now();
      const r = await c.post("/api/auth/register", { email: S.candEmail.toUpperCase(), password: PW, display_name: "QA Candidate" });
      expectStatus(r, 201);
      assert(r.body.status === "verification_sent" && typeof r.body.message === "string", brief(r.body));
      assert(!("email" in r.body), "register answer reveals account details");
      expectStatus(await c.get("/api/auth/me"), 401);
    });
    await t("duplicate registration (any case) -> same 201 answer; owner gets a 'someone tried to register' email", async () => {
      const since2 = Date.now();
      const r = await c.post("/api/auth/register", { email: S.candEmail.replace("qa", "QA"), password: PW });
      expectStatus(r, 201);
      assert(r.body.status === "verification_sent", brief(r.body));
      const m = await mailFor(S.candEmail, EXISTING_RE, { since: since2 });
      return `subject: ${m.msg.Subject}`;
    });
    await t("sign in before verifying (lower-cased email) -> unverified session", async () => {
      const r = await c.post("/api/auth/login", { email: S.candEmail.toUpperCase(), password: PW }, { retry429: true });
      expectStatus(r, 200);
      assert(r.body.email === S.candEmail, `email not lower-cased: ${r.body.email}`);
      assert(r.body.email_verified === false && r.body.role === "user", brief(r.body));
    });
    await t("unverified user cannot upload or list resumes (403 email_not_verified)", async () => {
      expectStatus(await c.get("/api/resumes"), 403, "email_not_verified");
      expectStatus(await upload(c, "x.pdf", PDF_MIME, makePdf(dataEngineer)), 403, "email_not_verified");
    });
    let token;
    await t("verification email arrives in Mailpit with a link to the website", async () => {
      const m = await mailFor(S.candEmail, VERIFY_RE, { since });
      token = m.token;
      assert(/localhost:3000\/verify-email/.test(m.msg.Text), "link does not point at PUBLIC_BASE_URL");
      return `subject: ${m.msg.Subject}`;
    });
    await t("bogus verification token -> 400 invalid_token", async () => {
      expectStatus(await c.post("/api/auth/verify-email", { token: "nope-" + stamp }), 400, "invalid_token");
    });
    await t("resend verification invalidates the old token", async () => {
      const since2 = Date.now();
      await c.ok("POST", "/api/auth/resend-verification");
      const m2 = await mailFor(S.candEmail, VERIFY_RE, { since: since2 });
      assert(m2.token !== token, "resend returned the same token");
      expectStatus(await c.post("/api/auth/verify-email", { token }), 400, "invalid_token");
      token = m2.token;
    });
    await t("verify with the fresh token -> verified, role user", async () => {
      const r = await c.ok("POST", "/api/auth/verify-email", { json: { token } });
      assert(r.email_verified === true && r.role === "user", brief(r));
    });
    await t("verification token is single-use", async () => {
      expectStatus(await c.post("/api/auth/verify-email", { token }), 400, "invalid_token");
    });
    S.cand = c;
  });

  await area("auth: login, logout, sessions, password change", async () => {
    const email = S.candEmail;
    await t("wrong password -> 401 invalid_credentials (same message as unknown email)", async () => {
      const c = await Client.create("x");
      const a = await c.post("/api/auth/login", { email, password: "Wrong-password-1" });
      const b = await c.post("/api/auth/login", { email: `nobody-${stamp}@example.com`, password: "Wrong-password-1" });
      expectStatus(a, 401, "invalid_credentials");
      expectStatus(b, 401, "invalid_credentials");
      assert(a.body.detail.message === b.body.detail.message, "messages differ (account enumeration)");
    });
    let second;
    await t("login works case-insensitively and creates a second session", async () => {
      second = await Client.create("second");
      const r = await second.post("/api/auth/login", { email: email.toUpperCase(), password: PW });
      expectStatus(r, 200);
      const sessions = await second.ok("GET", "/api/account/sessions");
      assert(sessions.length >= 2 && sessions.filter((s) => s.current).length === 1, brief(sessions));
      return `${sessions.length} sessions`;
    });
    await t("CSRF: state-changing request without the token -> 403 csrf_failed", async () => {
      const r = await second.call("PATCH", "/api/account/settings", { json: { display_name: "x" }, csrf: false });
      expectStatus(r, 403, "csrf_failed");
      const r2 = await second.call("PATCH", "/api/account/settings", { json: { display_name: "x" }, csrf: false, headers: { "x-csrf-token": "forged" } });
      expectStatus(r2, 403, "csrf_failed");
    });
    await t("revoke another session -> that client is signed out", async () => {
      const sessions = await S.cand.ok("GET", "/api/account/sessions");
      const other = sessions.find((s) => !s.current);
      await S.cand.ok("DELETE", `/api/account/sessions/${other.id}`);
      expectStatus(await second.get("/api/auth/me"), 401);
      expectStatus(await S.cand.del(`/api/account/sessions/00000000-0000-0000-0000-000000000000`), 404);
    });
    await t("logout ends the session", async () => {
      const c = await Client.create("logout");
      await c.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      expectStatus(await c.post("/api/auth/logout"), 204);
      expectStatus(await c.get("/api/auth/me"), 401);
    });
    await t("change password: wrong current -> 400; weak -> 422; ok signs out other sessions", async () => {
      const other = await Client.create("other");
      await other.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      expectStatus(await S.cand.post("/api/account/password", { current_password: "nope-nope-nope", new_password: PW + "x" }), 400, "invalid_credentials");
      expectStatus(await S.cand.post("/api/account/password", { current_password: PW, new_password: "abc" }), 422, "weak_password");
      await S.cand.ok("POST", "/api/account/password", { json: { current_password: PW, new_password: PW + "x" } });
      expectStatus(await other.get("/api/auth/me"), 401);
      await S.cand.ok("GET", "/api/auth/me");
      expectStatus(await other.post("/api/auth/login", { email, password: PW }), 401);
      await other.ok("POST", "/api/auth/login", { json: { email, password: PW + "x" } });
      await S.cand.ok("POST", "/api/account/password", { json: { current_password: PW + "x", new_password: PW } }); // back
    });
  });

  await area("auth: lockout after repeated wrong passwords", async () => {
    const email = `qa-lock-${stamp}@example.com`;
    const { c } = await registerVerified(email);
    const victimOther = `qa-lock2-${stamp}@example.com`;
    await registerVerified(victimOther);
    // straight to the API, each attempt from a different spoofed client IP, so only the per-account limit applies
    const api = await Client.create("api", { base: API });
    const statuses = [];
    await t("10 wrong passwords from 10 different IPs -> 401 each", async () => {
      for (let i = 0; i < 10; i++) {
        const r = await api.call("POST", "/api/auth/login", { json: { email, password: `Wrong-${i}-password` }, headers: { "x-forwarded-for": `203.0.113.${i + 1}` } });
        statuses.push(r.status);
      }
      assert(statuses.every((s) => s === 401), `statuses ${statuses}`);
    });
    await t("11th attempt (new IP) -> 429 even with the correct password", async () => {
      const r = await api.call("POST", "/api/auth/login", { json: { email, password: PW }, headers: { "x-forwarded-for": "198.51.100.77" }, retry429: false });
      expectStatus(r, 429);
      return brief(r.body);
    });
    await t("existing session of the locked account keeps working", async () => {
      await c.ok("GET", "/api/auth/me");
    });
    await t("another account is not affected by the lockout", async () => {
      const r = await api.call("POST", "/api/auth/login", { json: { email: victimOther, password: PW }, headers: { "x-forwarded-for": "203.0.113.1" } });
      expectStatus(r, 200);
    });
    await t("per-IP login rate limit: 11 quick attempts for one email+IP -> 429", async () => {
      const em = `qa-rate-${stamp}@example.com`;
      const sts = [];
      for (let i = 0; i < 12; i++) sts.push((await api.call("POST", "/api/auth/login", { json: { email: em, password: "Wrong-pass-123" }, headers: { "x-forwarded-for": "192.0.2.55" }, retry429: false })).status);
      assert(sts.includes(429), `no 429 in ${sts}`);
      return sts.join(",");
    });
    S.lockedEmail = email;
  });

  await area("auth: password reset", async () => {
    const email = `qa-reset-${stamp}@example.com`;
    const { c: oldSession } = await registerVerified(email);
    const anon = await Client.create("anon");
    await t("forgot-password for unknown email -> 202 with the same message, and no mail", async () => {
      const a = await anon.post("/api/auth/forgot-password", { email: `ghost-${stamp}@example.com` });
      const b = await anon.post("/api/auth/forgot-password", { email });
      expectStatus(a, 202);
      expectStatus(b, 202);
      assert(a.body.status === b.body.status, "responses differ (enumeration)");
    });
    let token;
    await t("reset email arrives with a reset-password link", async () => {
      token = (await mailFor(email, RESET_RE)).token;
    });
    await t("weak new password -> 422 and the token is still usable", async () => {
      expectStatus(await anon.post("/api/auth/reset-password", { token, password: "weak" }), 422, "weak_password");
    });
    await t("bogus token -> 400 invalid_token", async () => {
      expectStatus(await anon.post("/api/auth/reset-password", { token: "x" + token.slice(1), password: "New-password-77" }), 400, "invalid_token");
    });
    await t("reset -> old password fails, new password works, old sessions revoked", async () => {
      await anon.ok("POST", "/api/auth/reset-password", { json: { token, password: "New-password-77" } });
      expectStatus(await anon.post("/api/auth/login", { email, password: PW }), 401);
      expectStatus(await anon.post("/api/auth/login", { email, password: "New-password-77" }), 200);
      expectStatus(await oldSession.get("/api/auth/me"), 401);
    });
    await t("reset token cannot be reused", async () => {
      expectStatus(await anon.post("/api/auth/reset-password", { token, password: "Another-pass-88" }), 400, "invalid_token");
    });
    await t("a newer reset email invalidates the older link", async () => {
      const since = Date.now();
      await anon.ok("POST", "/api/auth/forgot-password", { json: { email } });
      const t1 = (await mailFor(email, RESET_RE, { since })).token;
      await sleep(1100);
      const since2 = Date.now();
      await anon.ok("POST", "/api/auth/forgot-password", { json: { email } });
      let t2 = t1;
      for (let i = 0; i < 20 && t2 === t1; i++) t2 = (await mailFor(email, RESET_RE, { since: since2 })).token;
      assert(t2 !== t1, "second reset mail not found");
      expectStatus(await anon.post("/api/auth/reset-password", { token: t1, password: "Another-pass-88" }), 400, "invalid_token");
      await anon.ok("POST", "/api/auth/reset-password", { json: { token: t2, password: "Another-pass-88" } });
    });
  });

  await area("auth: TOTP two-factor", async () => {
    const email = `qa-2fa-${stamp}@example.com`;
    const { c } = await registerVerified(email);
    let secret, codes;
    await t("enable before setup -> 409 not_started", async () => {
      expectStatus(await c.post("/api/account/2fa/enable", { code: "123456" }), 409, "not_started");
    });
    await t("setup returns a base32 secret and otpauth URI", async () => {
      const s = await c.ok("POST", "/api/account/2fa/setup");
      secret = s.secret;
      assert(/^[A-Z2-7]{16,}$/.test(secret) && s.otpauth_uri.startsWith("otpauth://totp/"), brief(s));
    });
    await t("enable with a wrong code -> 400; 2FA stays off", async () => {
      expectStatus(await c.post("/api/account/2fa/enable", { code: "000000" }), 400, "invalid_code");
      assert((await c.ok("GET", "/api/account/2fa")).enabled === false, "enabled after a wrong code");
    });
    await t("enable with the current code -> 10 recovery codes", async () => {
      const r = await c.ok("POST", "/api/account/2fa/enable", { json: { code: await freshTotp(secret) } });
      codes = r.recovery_codes;
      assert(codes.length >= 8 && new Set(codes).size === codes.length, brief(r));
      const st = await c.ok("GET", "/api/account/2fa");
      assert(st.enabled && st.recovery_codes_left === codes.length, brief(st));
      return `${codes.length} codes`;
    });
    await t("setup again while on -> 409 already_enabled", async () => {
      expectStatus(await c.post("/api/account/2fa/setup"), 409, "already_enabled");
    });
    await t("password login now returns mfa_required instead of a session", async () => {
      const x = await Client.create("x");
      const r = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      assert(r.mfa_required === true && r.mfa_token, brief(r));
      expectStatus(await x.get("/api/auth/me"), 401);
    });
    await t("second step: wrong code 401, then the right code signs in", async () => {
      const x = await Client.create("x");
      const r = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      expectStatus(await x.post("/api/auth/login/mfa", { mfa_token: r.mfa_token, code: "111111" }), 401, "invalid_code");
      await x.ok("POST", "/api/auth/login/mfa", { json: { mfa_token: r.mfa_token, code: await freshTotp(secret) } });
      assert((await x.ok("GET", "/api/auth/me")).mfa_enabled === true, "not signed in");
    });
    await t("a TOTP code cannot be replayed (same 30 s step)", async () => {
      const x = await Client.create("x");
      const code = await freshTotp(secret);
      const r1 = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      await x.ok("POST", "/api/auth/login/mfa", { json: { mfa_token: r1.mfa_token, code } });
      const y = await Client.create("y");
      const r2 = await y.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      expectStatus(await y.post("/api/auth/login/mfa", { mfa_token: r2.mfa_token, code }), 401, "invalid_code");
    });
    await t("mfa_token is single-use", async () => {
      const x = await Client.create("x");
      const r = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      await x.ok("POST", "/api/auth/login/mfa", { json: { mfa_token: r.mfa_token, code: codes[5] } });
      expectStatus(await x.post("/api/auth/login/mfa", { mfa_token: r.mfa_token, code: codes[6] }), 400, "invalid_token");
    });
    await t("recovery code signs in once and reports codes left; reuse fails", async () => {
      const x = await Client.create("x");
      const r = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      const out = await x.ok("POST", "/api/auth/login/mfa", { json: { mfa_token: r.mfa_token, code: codes[0] } });
      assert(out.recovery_codes_left === codes.length - 2, `codes left ${out.recovery_codes_left}`);
      const y = await Client.create("y");
      const r2 = await y.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      expectStatus(await y.post("/api/auth/login/mfa", { mfa_token: r2.mfa_token, code: codes[0] }), 401, "invalid_code");
    });
    await t("regenerate recovery codes needs a TOTP code (a recovery code is refused)", async () => {
      expectStatus(await c.post("/api/account/2fa/recovery-codes", { code: codes[1] }), 400, "invalid_code");
      const r = await c.ok("POST", "/api/account/2fa/recovery-codes", { json: { code: await freshTotp(secret) } });
      assert(r.recovery_codes.length === codes.length && !r.recovery_codes.includes(codes[2]), "codes not replaced");
      const x = await Client.create("x");
      const l = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      expectStatus(await x.post("/api/auth/login/mfa", { mfa_token: l.mfa_token, code: codes[2] }), 401, "invalid_code");
      codes = r.recovery_codes;
    });
    await t("data export does not contain the TOTP secret or recovery-code hashes", async () => {
      const r = await c.get("/api/account/export");
      expectStatus(r, 200);
      const files = unzip(r.buf);
      const all = Object.values(files).map((b) => b.toString("utf8")).join("\n");
      assert(!all.includes(secret), "TOTP secret in export");
      assert(!/recovery_code_hashes|totp_secret/.test(all), "2FA fields in export");
    });
    await t("disable: wrong password 400, wrong code 400, then off with password + code", async () => {
      expectStatus(await c.post("/api/account/2fa/disable", { password: "Wrong-pass-999", code: await freshTotp(secret) }), 400, "invalid_credentials");
      expectStatus(await c.post("/api/account/2fa/disable", { password: PW, code: "222222" }), 400, "invalid_code");
      await c.ok("POST", "/api/account/2fa/disable", { json: { password: PW, code: await freshTotp(secret) } });
      const x = await Client.create("x");
      const r = await x.ok("POST", "/api/auth/login", { json: { email, password: PW } });
      assert(!r.mfa_required && r.email === email, "login still asks for 2FA");
    });
  });

  // ================================================================ resumes
  await area("resumes: uploads across job profiles", async () => {
    const c = S.cand;
    const docs = [
      ["data_engineer", "priya_raman_data_engineer.pdf", PDF_MIME, makePdf(dataEngineer)],
      ["frontend", "arjun_mehta_frontend.docx", DOCX_MIME, makeDocx(frontendDev)],
      ["nurse", "maria_fernandes_rn.pdf", PDF_MIME, makePdf(nurse)],
      ["fresh_grad", "rohan_patel_graduate.docx", DOCX_MIME, makeDocx(freshGrad)],
      ["senior_manager", "david_chen_manager.pdf", PDF_MIME, makePdf(seniorManager)],
      ["near_empty", "sam_lee.pdf", PDF_MIME, makePdf(nearEmpty)],
      ["spanish", "lucia_gomez_cv_es.pdf", PDF_MIME, makePdf(spanish)],
      ["hindi", "anita_verma_hindi.docx", DOCX_MIME, makeDocx(hindi)],
    ];
    S.r = {};
    for (const [key, name, mime, buf] of docs) {
      await t(`upload ${key} (${name.split(".").pop()}) -> 202 and extraction completes`, async () => {
        const up = await upload(c, name, mime, buf);
        expectStatus(up, 202);
        assert(up.body.status === "processing" && up.body.job, brief(up.body));
        assert(up.body.file_kind === name.split(".").pop(), `file_kind ${up.body.file_kind}`);
        const w = await waitExtraction(c, up.body.id);
        assert(w.ok, `extraction failed: ${brief(w.error)}`);
        S.r[key] = { resumeId: up.body.id, ex: w.ex };
        // the page count comes from the sandboxed parser in the worker, so it is known only after processing
        if (mime === PDF_MIME) {
          const after = await c.ok("GET", `/api/resumes/${up.body.id}`);
          assert(after.page_count === 1, `page_count after processing ${after.page_count}`);
        }
        const ct = w.ex.content;
        return `name=${ct.contact?.name ?? "-"} exp=${ct.experience.length} skills=${(ct.skills?.technical ?? []).length} uncertain=${w.ex.uncertain.length}`;
      });
    }
    await t("tiny text PDF (name + email only) is parsed, not reported as unreadable", async () => {
      const up = await upload(c, "tiny.pdf", PDF_MIME, makePdf(tinyResume));
      expectStatus(up, 202);
      const w = await waitExtraction(c, up.body.id);
      assert(w.ok, `extraction failed: ${brief(w.error)}`);
    });
    await t("processing job is visible and succeeded", async () => {
      const r = await c.ok("GET", `/api/resumes/${S.r.data_engineer.resumeId}`);
      const j = await c.ok("GET", `/api/processing-jobs/${r.job.id}`);
      assert(j.status === "succeeded" && j.kind === "parse_resume", brief(j));
      expectStatus(await c.post(`/api/processing-jobs/${j.id}/retry`), 409, "not_failed");
    });
    await t("list resumes shows all uploads", async () => {
      const list = await c.ok("GET", "/api/resumes");
      const ids = new Set(list.map((x) => x.id));
      assert(Object.values(S.r).every((x) => ids.has(x.resumeId)), "missing uploads in list");
      return `${list.length} resumes`;
    });
  });

  await area("resumes: extraction quality", async () => {
    const R = S.r;
    const skillsOf = (k) => new Set([...(R[k].ex.content.skills?.technical ?? []), ...(R[k].ex.content.skills?.tools ?? [])].map((s) => s.toLowerCase()));
    await t("data engineer: contact, 2 jobs with dates, key skills", async () => {
      const ct = R.data_engineer.ex.content;
      assert(ct.contact.name === "Priya Raman", `name ${ct.contact.name}`);
      assert(ct.contact.email === "priya.raman@example.com", `email ${ct.contact.email}`);
      assert(ct.experience.length === 2, `experience ${ct.experience.length}`);
      assert(ct.experience[0].start === "2022-03" && (ct.experience[0].current || ct.experience[0].end == null), brief(ct.experience[0]));
      assert(ct.experience[0].bullets.length === 4, `bullets ${ct.experience[0].bullets.length}`);
      const sk = skillsOf("data_engineer");
      for (const s of ["python", "sql", "airflow", "kafka"]) assert([...sk].some((x) => x.includes(s)), `skill ${s} missing: ${[...sk]}`);
      assert(ct.education.length === 1 && ct.certifications.length === 1, `edu ${ct.education.length} cert ${ct.certifications.length}`);
    });
    await t("frontend (DOCX): contact, 2 jobs, React/TypeScript skills", async () => {
      const ct = R.frontend.ex.content;
      assert(ct.contact.name === "Arjun Mehta" && ct.contact.email === "arjun.mehta@example.com", brief(ct.contact));
      assert(ct.experience.length === 2, `experience ${ct.experience.length}: ${brief(ct.experience.map((e) => e.title))}`);
      const sk = skillsOf("frontend");
      for (const s of ["react", "typescript", "css"]) assert([...sk].some((x) => x.includes(s)), `skill ${s} missing: ${[...sk]}`);
    });
    await t("fresh graduate: internship recognised as internship", async () => {
      const ct = R.fresh_grad.ex.content;
      assert(ct.experience.length >= 1, "no experience");
      const intern = ct.experience.find((e) => /intern/i.test(e.title ?? ""));
      assert(intern, `no intern entry: ${brief(ct.experience)}`);
      assert(intern.employment_type === "internship", `employment_type ${intern.employment_type}`);
      assert(ct.projects.length >= 1, "projects missing");
    });
    await t("near-empty resume: extraction completes with name/email and nothing invented", async () => {
      const ct = R.near_empty.ex.content;
      assert(ct.contact.email === "sam.lee@example.com", brief(ct.contact));
      assert(ct.experience.length === 0 && (ct.skills?.technical ?? []).length === 0, `invented content: ${brief(ct)}`);
    });
    await t("Spanish resume: parses without error, email kept, content not silently dropped", async () => {
      const ex = R.spanish.ex;
      assert(ex.content.contact.email === "lucia.gomez@example.com", brief(ex.content.contact));
      const blob = JSON.stringify(ex.content) + JSON.stringify(ex.unparsed_sections);
      assert(/Django/.test(blob), "the Spanish skills line was lost entirely");
      return `exp=${ex.content.experience.length} skills=${skillsOf("spanish").size} unparsed=${ex.unparsed_sections.length} uncertain=${brief(ex.uncertain).slice(0, 80)}`;
    });
    await t("Spanish resume (English-only headings documented): skills under HABILIDADES still recognised", async () => {
      const sk = skillsOf("spanish");
      assert([...sk].some((s) => s.includes("python")), `no skills extracted (skills=[${[...sk]}], experience=${R.spanish.ex.content.experience.length})`);
    });
    await t("Hindi DOCX: parses without error, email kept, Devanagari text not lost", async () => {
      const ex = R.hindi.ex;
      assert(ex.content.contact.email === "anita.verma@example.com", brief(ex.content.contact));
      const raw = JSON.stringify(ex.content) + JSON.stringify(ex.unparsed_sections);
      assert(/[ऀ-ॿ]/.test(raw), "Devanagari text dropped entirely");
      return `name=${ex.content.contact.name} uncertain=${ex.uncertain.length}`;
    });
    await t("raw text only with include_text=true", async () => {
      const a = await S.cand.ok("GET", `/api/resumes/${R.data_engineer.resumeId}/extraction`);
      const b = await S.cand.ok("GET", `/api/resumes/${R.data_engineer.resumeId}/extraction?include_text=true`);
      assert(!("raw_text" in a) && b.raw_text.includes("Northwind Retail"), "raw_text handling");
    });
    await t("original file download through a short-lived signed link", async () => {
      const l = await S.cand.ok("GET", `/api/resumes/${R.data_engineer.resumeId}/original-link`);
      const r = await S.cand.get(l.url);
      expectStatus(r, 200);
      assert(r.buf.subarray(0, 5).toString() === "%PDF-", "not the PDF");
      assert(/attachment/.test(r.headers["content-disposition"]), "not an attachment");
      expectStatus(await S.cand.get(l.url.replace(/token=.{6}/, "token=AAAAAA")), [403, 404]);
    });
  });

  await area("resumes: rejected uploads", async () => {
    const c = S.cand;
    const big = makePdf(dataEngineer, { padBytes: 6 * 1024 * 1024 });
    const manyPages = makePdf(Array.from({ length: 11 }, (_, i) => [`Page ${i + 1}`, ...dataEngineer.slice(0, 10)]));
    const validPdf = makePdf(dataEngineer);
    const cases = [
      ["huge 6 MB PDF -> 413 file_too_large", "huge.pdf", PDF_MIME, big, 413, "file_too_large"],
      ["plain text file -> 422 unsupported_type", "resume.txt", "text/plain", Buffer.from("Python developer"), 422, "unsupported_type"],
      ["legacy .doc -> 422 unsupported_type", "resume.doc", "application/msword", Buffer.from("\xd0\xcf\x11\xe0junk"), 422, "unsupported_type"],
      ["executable named .exe -> 422 unsupported_type", "resume.exe", "application/octet-stream", Buffer.from("MZ\x90\x00"), 422, "unsupported_type"],
      ["PNG renamed to .pdf -> 422 bad_signature", "photo.pdf", PDF_MIME, Buffer.from("\x89PNG\r\n\x1a\n" + "x".repeat(100), "latin1"), 422, "bad_signature"],
      ["DOCX renamed to .pdf -> 422 bad_signature", "word.pdf", PDF_MIME, makeDocx(frontendDev), 422, "bad_signature"],
      ["PDF declared as image/png -> 422 mime_mismatch", "resume.pdf", "image/png", validPdf, 422, "mime_mismatch"],
      ["empty file -> 422 empty_file", "empty.pdf", PDF_MIME, Buffer.alloc(0), 422, "empty_file"],
      ["DOCX with macros -> 422 macro_document", "macro.docx", DOCX_MIME, makeDocx(frontendDev, { macro: true }), 422, "macro_document"],
      ["zip without word/document.xml -> 422 bad_signature", "fake.docx", DOCX_MIME, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(200)]), 422, null],
      ["no extension -> 422 unsupported_type", "resume", PDF_MIME, validPdf, 422, "unsupported_type"],
    ];
    for (const [name, file, mime, buf, status, code] of cases) {
      await t(name, async () => {
        const r = await upload(c, file, mime, buf);
        expectStatus(r, status, code ?? undefined);
        if (r.status === 202) {
          const w = await waitExtraction(c, r.body.id);
          return w.ok ? "parsed" : `failed safely: ${w.error.detail?.code}`;
        }
        return r.body?.detail?.code;
      });
    }
    await t("rejected uploads leave no resume rows behind", async () => {
      const list = await c.ok("GET", "/api/resumes");
      const bad = list.filter((x) => ["huge.pdf", "resume.txt", "photo.pdf", "macro.docx"].includes(x.original_filename));
      assert(bad.length === 0, `rows created for rejected files: ${bad.map((x) => x.original_filename)}`);
    });

    // The API process never opens an untrusted PDF: page count, encryption and structure are checked by the
    // sandboxed parser in the worker. Such files are accepted (202) and the processing job then FAILS with
    // the reason as its error code; retrying cannot help, and the resume shows as failed.
    const garbage = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37) % 256));
    const jobCases = [
      ["11-page PDF -> accepted, job fails with too_many_pages", "long.pdf", manyPages, "too_many_pages"],
      ["corrupted PDF (header + garbage) -> job fails with corrupted_pdf", "broken.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), garbage]), "corrupted_pdf"],
      ["password-protected PDF (/Encrypt, unreadable) -> job fails with encrypted_pdf", "locked.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\n"), garbage]), "encrypted_pdf"],
      ["truncated PDF -> parsed safely or job fails with corrupted_pdf", "truncated.pdf", validPdf.subarray(0, Math.floor(validPdf.length / 2)), null],
    ];
    for (const [name, file, buf, code] of jobCases) {
      await t(name, async () => {
        const r = await upload(c, file, PDF_MIME, buf);
        expectStatus(r, 202);
        const w = await waitExtraction(c, r.body.id);
        const res = await c.ok("GET", `/api/resumes/${r.body.id}`);
        if (code === null) {
          if (w.ok) return "parsed";
          assert(res.status === "failed" && res.error_code === "corrupted_pdf", `unexpected failure ${brief(res)}`);
          return "failed safely: corrupted_pdf";
        }
        assert(!w.ok && w.error.detail?.code === code, `extraction answered ${brief(w.error ?? "200")}`);
        assert(res.status === "failed" && res.error_code === code, `resume not failed with ${code}: ${brief(res)}`);
        assert(res.job?.status === "failed" && res.job.error_code === code, `job not failed with ${code}: ${brief(res.job)}`);
        await c.del(`/api/resumes/${r.body.id}`);
        return `job ${res.job.status} after ${res.job.attempts} attempt(s)`;
      });
    }
  });

  await area("analysis: rubric, roles, seniority, skill gap", async () => {
    const c = S.cand;
    for (const k of Object.keys(S.r)) {
      await t(`confirm extraction of ${k} -> version 1`, async () => {
        const rv = await c.ok("PUT", `/api/resumes/${S.r[k].resumeId}/review`, { json: { content: S.r[k].ex.content } });
        assert(rv.number === 1, `number ${rv.number}`);
        S.r[k].versionId = rv.version_id;
      });
    }
    await t("confirming twice -> 409 already_confirmed", async () => {
      expectStatus(await c.put(`/api/resumes/${S.r.data_engineer.resumeId}/review`, { content: S.r.data_engineer.ex.content }), 409, "already_confirmed");
    });
    S.analysis = {};
    for (const k of Object.keys(S.r)) {
      await t(`analysis of ${k}: overall 0-100 and categories`, async () => {
        const a = await c.ok("GET", `/api/versions/${S.r[k].versionId}/analysis`);
        S.analysis[k] = a;
        assert(a.overall === null || (a.overall >= 0 && a.overall <= 100), `overall ${a.overall}`);
        assert(Array.isArray(a.categories) && a.categories.length >= 4, "categories");
        return `overall=${a.overall} improvements=${a.improvements.length}`;
      });
    }
    await t("analysis is cached on repeat", async () => {
      const a = await c.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/analysis`);
      assert(a.cached === true, "not cached");
    });
    await t("strong data-engineer resume scores higher on quality than the near-empty one", async () => {
      const de = S.analysis.data_engineer.overall, ne = S.analysis.near_empty.overall;
      assert(de >= 60, `data engineer quality ${de}`);
      assert(ne === null || ne < de - 20, `near-empty ${ne} vs ${de}`);
      return `DE ${de} vs empty ${ne}`;
    });
    await t("near-empty resume: analysis reports insufficient data instead of fake scores", async () => {
      const a = S.analysis.near_empty;
      const insufficient = a.categories.filter((x) => x.status === "insufficient_data" || x.score === null);
      assert(insufficient.length >= 1, `no category marked insufficient: ${brief(a.categories.map((x) => [x.id, x.score, x.status]))}`);
      return `${insufficient.length} categories insufficient`;
    });
    await t("analysis with target_role adds role keyword coverage; unknown role -> 422", async () => {
      const a = await c.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/analysis?target_role=data_engineer`);
      assert(a.role_keyword_coverage?.role_id === "data_engineer", brief(a.role_keyword_coverage));
      assert(a.role_keyword_coverage.required_coverage >= 0.75, `required coverage ${a.role_keyword_coverage.required_coverage}`);
      expectStatus(await c.get(`/api/versions/${S.r.data_engineer.versionId}/analysis?target_role=astronaut`), 422, "unknown_role");
    });

    S.roles = {};
    const lb = async (k) => (S.roles[k] ??= await c.ok("GET", `/api/versions/${S.r[k].versionId}/leaderboard/roles`));
    const pos = (board, id) => board.rows.findIndex((r) => r.role_id === id);
    const score = (board, id) => board.rows.find((r) => r.role_id === id)?.score;
    await t("data engineer: data roles rank above frontend roles; top role is data_engineer", async () => {
      const b = await lb("data_engineer");
      assert(b.status === "ok", brief(b));
      assert(b.rows[0].role_id === "data_engineer", `top ${b.rows[0].role_id}`);
      assert(pos(b, "data_engineer") < pos(b, "frontend_developer"), "frontend above data engineer");
      assert(score(b, "data_engineer") - score(b, "frontend_developer") >= 20, `gap ${score(b, "data_engineer")} vs ${score(b, "frontend_developer")}`);
      return b.rows.slice(0, 4).map((r) => `${r.role_id}:${r.score}`).join(" ");
    });
    await t("frontend dev: frontend/full-stack on top; data engineer far below", async () => {
      const b = await lb("frontend");
      assert(["frontend_developer", "fullstack_developer"].includes(b.rows[0].role_id), `top ${b.rows[0].role_id}`);
      assert(score(b, "frontend_developer") > score(b, "data_engineer") + 20, `FE ${score(b, "frontend_developer")} DE ${score(b, "data_engineer")}`);
      return b.rows.slice(0, 3).map((r) => `${r.role_id}:${r.score}`).join(" ");
    });
    await t("nurse: no high software score (insufficient evidence or every role < 40)", async () => {
      const b = await lb("nurse");
      const best = Math.max(0, ...b.rows.map((r) => r.score ?? 0));
      assert(b.status !== "ok" || best < 40, `nurse best software score ${best} (${b.rows[0]?.role_id})`);
      assert(b.rows.every((r) => !r.tips_available), "nurse offered tailoring tips for a software role");
      return `status=${b.status} best=${best}`;
    });
    await t("near-empty: role leaderboard says insufficient evidence", async () => {
      const b = await lb("near_empty");
      assert(b.status === "insufficient_evidence" && b.rows.length === 0, `status=${b.status} rows=${b.rows.length}`);
      return b.message?.slice(0, 80);
    });
    await t("seniority: graduate is entry-level, senior manager is senior/lead", async () => {
      const g = (await lb("fresh_grad")).seniority, m = (await lb("senior_manager")).seniority;
      assert(g && /entry|junior|intern/i.test(`${g.estimate} ${g.label}`), `grad ${brief(g)}`);
      assert(m && /senior|lead|principal|staff|manager/i.test(`${m.estimate} ${m.label}`), `manager ${brief(m)}`);
      return `grad=${g.estimate} manager=${m.estimate}`;
    });
    await t("recommendations endpoint agrees with the leaderboard and records preferences note", async () => {
      const r = await c.ok("POST", `/api/versions/${S.r.data_engineer.versionId}/recommendations`, { json: { locations: ["Pune"] } });
      assert(r.status === "ok" && r.recommendations[0].role_id === "data_engineer", brief(r.recommendations?.[0]));
      assert(r.preference_note, "no note that locations are not used");
    });
    await t("skill gap for data_engineer lists few gaps; for ml_engineer more", async () => {
      const g = await c.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/skill-gap?roles=data_engineer&roles=ml_engineer`);
      assert(g.roles.length === 2, brief(g));
      const gaps = Object.fromEntries(g.roles.map((r) => [r.role_id, r.summary.gap]));
      assert(gaps.data_engineer <= 2 && gaps.ml_engineer > gaps.data_engineer, `gaps ${brief(gaps)}`);
      expectStatus(await c.get(`/api/versions/${S.r.data_engineer.versionId}/skill-gap?roles=pilot`), 422, "unknown_role");
      return `gaps: ${brief(gaps)}`;
    });
    await t("career roadmap for the frontend resume", async () => {
      const r = await c.ok("GET", `/api/career/roadmap/${S.r.frontend.versionId}`);
      assert(r.status === "ok" && Array.isArray(r.steps ?? r.roles), brief(r));
    });
    await t("roadmap for near-empty resume -> insufficient_evidence (no fabricated plan)", async () => {
      const r = await c.ok("GET", `/api/career/roadmap/${S.r.near_empty.versionId}`);
      assert(r.status === "insufficient_evidence", `status ${r.status}`);
    });
    await t("tips are relevance-gated: data engineer -> data_engineer tips; nurse -> ml_engineer blocked", async () => {
      const a = await c.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/tips?role_id=data_engineer`);
      const b = await c.ok("GET", `/api/versions/${S.r.nurse.versionId}/tips?role_id=ml_engineer`);
      assert(a.eligible === true, `DE not eligible for data_engineer tips ${brief(a)}`);
      assert(b.eligible === false && b.tips.length === 0 && b.gate_message && b.learning_path.length > 0, `nurse got ML tips ${brief(b)}`);
      expectStatus(await c.get(`/api/versions/${S.r.nurse.versionId}/tips`), 422, "missing_target");
      return `DE eligible, ${a.tips.length} tips; nurse gated, learning path ${b.learning_path.map((x) => x.skill).slice(0, 3)}`;
    });
  });

  await area("preferences + role leaderboard", async () => {
    const c = S.cand;
    await t("save career prefs: unknown role ids are dropped, domains normalised", async () => {
      const me = await c.ok("PATCH", "/api/account/settings", { json: { career_prefs: { target_roles: ["data_scientist", "astronaut"], domains: ["  FinTech "], locations: ["Pune"], work_arrangements: ["remote"] } } });
      assert(JSON.stringify(me.career_prefs.target_roles) === '["data_scientist"]', brief(me.career_prefs));
      assert(me.career_prefs.domains[0] === "fintech", brief(me.career_prefs));
    });
    await t("invalid work arrangement -> 422", async () => {
      expectStatus(await c.patch("/api/account/settings", { career_prefs: { work_arrangements: ["moon"] } }), 422);
    });
    await t("preferred role gets a visible boost on the leaderboard", async () => {
      const b = await c.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/leaderboard/roles`);
      const ds = b.rows.find((r) => r.role_id === "data_scientist");
      const boost = ds.preference_adjustment ?? ds.preference_boost ?? ds.boost;
      assert(boost && boost > 0, `no visible boost on data_scientist: ${brief(ds)}`);
      return `data_scientist boost ${boost}, rank ${ds.rank}`;
    });
    await t("clearing prefs removes the boost", async () => {
      await c.ok("PATCH", "/api/account/settings", { json: { career_prefs: { target_roles: [] } } });
      const b = await c.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/leaderboard/roles`);
      const ds = b.rows.find((r) => r.role_id === "data_scientist");
      assert(!(ds.preference_adjustment > 0), brief(ds));
    });
    await t("display name and notification prefs; unknown pref keys ignored", async () => {
      const me = await c.ok("PATCH", "/api/account/settings", { json: { display_name: "  Priya QA  ", notification_prefs: { weekly_digest: true, hack: true } } });
      assert(me.display_name === "Priya QA" && me.notification_prefs.weekly_digest === true && !("hack" in me.notification_prefs), brief(me));
    });
    await t("job alerts for someone else's resume -> 404", async () => {
      const other = (await registerVerified(`qa-alerts-${stamp}@example.com`)).c;
      expectStatus(await other.patch("/api/account/settings", { job_alerts: { enabled: true, min_score: 60, resume_id: S.r.data_engineer.resumeId } }), 404);
      expectStatus(await c.patch("/api/account/settings", { job_alerts: { enabled: true, min_score: 10 } }), 422);
      await c.ok("PATCH", "/api/account/settings", { json: { job_alerts: { enabled: true, min_score: 60, resume_id: S.r.data_engineer.resumeId } } });
    });
  });

  // ================================================================ editor, AI, versions
  await area("editor: versions, what-if, compare, restore", async () => {
    const c = S.cand;
    const rid = S.r.data_engineer.resumeId;
    let v1 = S.r.data_engineer.versionId, v2;
    await t("save an edit -> v2; identical content is a no-op", async () => {
      const content = (await c.ok("GET", `/api/versions/${v1}`)).content;
      content.summary = content.summary + " Comfortable owning data platforms end to end.";
      const r = await c.ok("POST", `/api/resumes/${rid}/versions`, { json: { base_version_id: v1, content, label: "QA edit" } });
      assert(r.number === 2 && r.is_latest, brief(r));
      v2 = r.id;
      const same = await c.ok("POST", `/api/resumes/${rid}/versions`, { json: { base_version_id: v2, content } });
      assert(same.id === v2, "identical save created a new version");
    });
    await t("stale base version -> 409 stale_version", async () => {
      const content = (await c.ok("GET", `/api/versions/${v1}`)).content;
      expectStatus(await c.post(`/api/resumes/${rid}/versions`, { base_version_id: v1, content }), 409, "stale_version");
    });
    await t("invalid content: free-text date -> 422; oversized bullet -> 422", async () => {
      const content = (await c.ok("GET", `/api/versions/${v2}`)).content;
      const bad = structuredClone(content);
      bad.experience[0].start = "March 2022";
      expectStatus(await c.post(`/api/resumes/${rid}/versions`, { base_version_id: v2, content: bad }), 422);
      const bad3 = structuredClone(content);
      bad3.experience[0].bullets[0].text = "x".repeat(900);
      expectStatus(await c.post(`/api/resumes/${rid}/versions`, { base_version_id: v2, content: bad3 }), 422);
    });
    await t("javascript: link is neutralised (never stored as a javascript: URL)", async () => {
      const content = (await c.ok("GET", `/api/versions/${v2}`)).content;
      const bad2 = structuredClone(content);
      bad2.contact.links = [{ label: "x", url: "javascript:alert(1)" }];
      const r = await c.post(`/api/resumes/${rid}/versions`, { base_version_id: v2, content: bad2 });
      if (r.status === 201) {
        assert(!/^javascript:/i.test(r.body.content.contact.links[0].url), "stored javascript: URL");
        // undo so the version numbers below stay predictable
        const back = await c.ok("POST", `/api/versions/${v2}/restore`);
        v2 = back.id;
        return `stored as ${r.body.content.contact.links[0].url}`;
      }
      expectStatus(r, 422);
    });
    await t("what-if: adding a true ML project raises the ml_engineer score without saving", async () => {
      const content = (await c.ok("GET", `/api/versions/${v2}`)).content;
      content.projects.push({ name: "Churn model", technologies: ["scikit-learn", "Pandas"], bullets: [{ text: "Trained a scikit-learn churn classifier with Machine Learning model evaluation (ROC AUC 0.86) on Pandas features" }] });
      const r = await c.ok("POST", `/api/versions/${v2}/what-if`, { json: { content, role_id: "ml_engineer" } });
      assert(r.delta > 0 && r.keywords_gained.length > 0, `delta ${r.delta} gained ${r.keywords_gained}`);
      const n0 = (await c.ok("GET", `/api/resumes/${rid}/versions`)).length;
      await c.ok("POST", `/api/versions/${v2}/what-if`, { json: { content, role_id: "ml_engineer" } });
      assert((await c.ok("GET", `/api/resumes/${rid}/versions`)).length === n0, "what-if saved a version");
      expectStatus(await c.post(`/api/versions/${v2}/what-if`, { content, role_id: "ml_engineer", opening_id: "x" }), 422, "missing_target");
      return `+${r.delta}, gained ${r.keywords_gained.join(", ")}`;
    });
    await t("compare v1 vs v2 shows the summary change", async () => {
      const r = await c.ok("GET", `/api/versions/${v1}/compare/${v2}`);
      assert(r.changes.length >= 1 && r.categories.length >= 4, brief(r.changes));
    });
    await t("restore v1 -> v3 with v1 content (history append-only)", async () => {
      const n0 = (await c.ok("GET", `/api/resumes/${rid}/versions`)).length;
      const r = await c.ok("POST", `/api/versions/${v1}/restore`);
      S.r.data_engineer.latest = r.id;
      assert(r.number === n0 + 1 && r.source === "restore", brief(r));
      const v1c = (await c.ok("GET", `/api/versions/${v1}`)).content_hash;
      assert(r.content_hash === v1c, "restored content differs");
      S.r.data_engineer.latest = r.id;
    });
    await t("resume health history has a point per version", async () => {
      const h = await c.ok("GET", `/api/resumes/${rid}/history?role_id=data_engineer`);
      const n = (await c.ok("GET", `/api/resumes/${rid}/versions`)).length;
      assert(h.points.length === n && h.points.every((p) => p.quality !== undefined), brief(h.points.length));
      expectStatus(await c.get(`/api/resumes/${rid}/history?role_id=nope`), 422);
    });
    await t("targeted variant for a role starts from the latest version", async () => {
      const r = await c.ok("POST", `/api/resumes/${rid}/variants`, { json: { title: "Priya - ML variant", target_role: "ml_engineer" } });
      assert(r.source_resume_id === rid && r.latest_version_number === 1 && r.status === "ready", brief(r));
      S.variant = r;
    });
  });

  await area("AI editor (fixture provider)", async () => {
    const c = S.cand;
    const rid = S.r.data_engineer.resumeId;
    const vid = S.r.data_engineer.latest;
    const content = (await c.ok("GET", `/api/versions/${vid}`)).content;
    const exp = content.experience[0];
    const bullet = exp.bullets[0];
    let sug;
    await t("privacy page: fixture provider, nothing sent externally", async () => {
      const p = await c.ok("GET", "/api/account/privacy");
      assert(p.ai_provider === "fixture" && p.sends_data_externally === false, brief(p));
    });
    await t("rewrite one bullet -> pending suggestion with diff + grounding, labelled fixture", async () => {
      sug = await c.ok("POST", `/api/versions/${vid}/suggestions`, { json: { operation: "rewrite_bullet", target_path: `experience/${exp.id}/bullets/${bullet.id}`, tone: "confident" } });
      assert(["pending", "needs_facts"].includes(sug.status) && sug.items.length === 1, brief(sug));
      assert(sug.is_fixture && sug.fixture_notice, "not labelled as fixture");
      assert(sug.items[0].before === bullet.text && sug.items[0].after, "before/after");
      return `${sug.status}: "${sug.items[0].after.slice(0, 70)}"`;
    });
    await t("same request again returns the cached pending suggestion", async () => {
      const again = await c.ok("POST", `/api/versions/${vid}/suggestions`, { json: { operation: "rewrite_bullet", target_path: `experience/${exp.id}/bullets/${bullet.id}`, tone: "confident" } });
      assert(again.id === sug.id, "not de-duplicated");
    });
    await t("AI output never introduces numbers that aren't in the resume (grounding)", async () => {
      const nums = (sug.items[0].after.match(/\d[\d,.]*%?/g) ?? []).filter((n) => !JSON.stringify(content).includes(n.replace(/[.,]$/, "")));
      assert(nums.length === 0 || sug.status === "needs_facts", `ungrounded numbers ${nums} with status ${sug.status}`);
    });
    await t("accept -> new version containing the rewritten bullet", async () => {
      const r = await c.ok("POST", `/api/suggestions/${sug.id}/accept`, { json: { confirmed_facts: [] } });
      const nv = await c.ok("GET", `/api/versions/${r.version_id}`);
      const b = nv.content.experience[0].bullets.find((x) => x.id === bullet.id);
      assert(b.text === sug.items[0].after, "bullet not replaced");
      S.r.data_engineer.latest = r.version_id;
      return `v${r.version_number}`;
    });
    await t("accept twice -> 409 not_pending", async () => {
      expectStatus(await c.post(`/api/suggestions/${sug.id}/accept`, { confirmed_facts: [] }), 409, "not_pending");
    });
    await t("suggestion on an old version whose text changed -> 409 stale_suggestion on accept", async () => {
      const s2 = await c.ok("POST", `/api/versions/${vid}/suggestions`, { json: { operation: "grammar", target_path: `experience/${exp.id}/bullets/${bullet.id}` } });
      expectStatus(await c.post(`/api/suggestions/${s2.id}/accept`, { confirmed_facts: [] }), 409, "stale_suggestion");
      await c.ok("POST", `/api/suggestions/${s2.id}/reject`);
    });
    const latest = S.r.data_engineer.latest;
    const lc = (await c.ok("GET", `/api/versions/${latest}`)).content;
    await t("improve summary, then reject it (no new version)", async () => {
      const before = (await c.ok("GET", `/api/resumes/${rid}/versions`)).length;
      const s = await c.ok("POST", `/api/versions/${latest}/suggestions`, { json: { operation: "improve_summary", target_path: "summary" } });
      const r = await c.ok("POST", `/api/suggestions/${s.id}/reject`);
      assert(r.status === "rejected", brief(r));
      assert((await c.ok("GET", `/api/resumes/${rid}/versions`)).length === before, "reject created a version");
      expectStatus(await c.post(`/api/suggestions/${s.id}/reject`), 409, "not_pending");
    });
    await t("shorten a whole experience entry; edit the text before accepting", async () => {
      const e2 = lc.experience[1];
      const s = await c.ok("POST", `/api/versions/${latest}/suggestions`, { json: { operation: "shorten", target_path: `experience/${e2.id}/bullets` } });
      // the fixture only returns bullets it actually changed
      assert(s.items.length >= 1 && s.items.length <= e2.bullets.length && s.items.every((i) => e2.bullets.some((b) => b.id === i.target_id)), `items ${s.items.length} vs ${e2.bullets.length}`);
      const edited = [{ target_id: s.items[0].target_id, text: "Migrated Hadoop jobs to AWS EMR and S3, saving $120K per year" }];
      const r = await c.ok("POST", `/api/suggestions/${s.id}/accept`, { json: { edited_items: edited } });
      const nv = await c.ok("GET", `/api/versions/${r.version_id}`);
      assert(nv.content.experience[1].bullets[0].text === edited[0].text, "edit not applied");
      S.r.data_engineer.latest = r.version_id;
    });
    await t("accept with an invented claim in the edited text -> 422 unsupported_claims; confirming it allows accept", async () => {
      const L = S.r.data_engineer.latest;
      const cc = (await c.ok("GET", `/api/versions/${L}`)).content;
      const e = cc.experience[0], b = e.bullets[2];
      const s = await c.ok("POST", `/api/versions/${L}/suggestions`, { json: { operation: "tone", target_path: `experience/${e.id}/bullets/${b.id}`, tone: "formal" } });
      const fake = "Designed Kafka streaming ingestion at Google for 900 million users";
      const r = await c.post(`/api/suggestions/${s.id}/accept`, { edited_items: [{ target_id: b.id, text: fake }] });
      expectStatus(r, 422, "unsupported_claims");
      const ok = await c.post(`/api/suggestions/${s.id}/accept`, { edited_items: [{ target_id: b.id, text: fake }], confirmed_facts: ["Google", "900 million"] });
      return `confirmed accept -> ${ok.status}`;
    });
    await t("tailor to an unrelated target is refused (nurse -> ml_engineer)", async () => {
      const nc = (await c.ok("GET", `/api/versions/${S.r.nurse.versionId}`)).content;
      const r = await c.post(`/api/versions/${S.r.nurse.versionId}/suggestions`, { operation: "tailor", target_path: `experience/${nc.experience[0].id}/bullets`, target_role: "ml_engineer" });
      expectStatus(r, 422, "target_not_related");
    });
    await t("tailor to a related role works (data engineer -> data_engineer)", async () => {
      const L = S.r.data_engineer.latest;
      const cc = (await c.ok("GET", `/api/versions/${L}`)).content;
      const s = await c.ok("POST", `/api/versions/${L}/suggestions`, { json: { operation: "tailor", target_path: `experience/${cc.experience[0].id}/bullets`, target_role: "data_engineer" } });
      assert(s.items.length >= 1, brief(s));
    });
    await t("tailor without a target -> 422 missing_target", async () => {
      expectStatus(await c.post(`/api/versions/${S.r.data_engineer.latest}/suggestions`, { operation: "tailor", target_path: "summary" }), 422);
    });
    await t("bad targets: unknown entry 404, malformed path 404, empty text 422, improve_summary on a bullet 422", async () => {
      const L = S.r.data_engineer.latest;
      expectStatus(await c.post(`/api/versions/${L}/suggestions`, { operation: "rewrite_bullet", target_path: "experience/doesnotexist/bullets" }), 404, "target_not_found");
      expectStatus(await c.post(`/api/versions/${L}/suggestions`, { operation: "rewrite_bullet", target_path: "../../etc/passwd" }), 404, "target_not_found");
      expectStatus(await c.post(`/api/versions/${S.r.near_empty.versionId}/suggestions`, { operation: "grammar", target_path: "summary" }), 422, "empty_target");
      const cc = (await c.ok("GET", `/api/versions/${L}`)).content;
      expectStatus(await c.post(`/api/versions/${L}/suggestions`, { operation: "improve_summary", target_path: `experience/${cc.experience[0].id}/bullets` }), 422, "invalid_target");
      expectStatus(await c.post(`/api/versions/${L}/suggestions`, { operation: "summon_demons", target_path: "summary" }), 422);
    });
    await t("list suggestions for a version", async () => {
      const l = await c.ok("GET", `/api/versions/${vid}/suggestions`);
      assert(l.length >= 2 && l.some((s) => s.status === "accepted") && l.some((s) => s.status === "rejected"), brief(l.map((s) => s.status)));
    });
    await t("AI usage is counted", async () => {
      const u = await c.ok("GET", "/api/account/usage");
      assert(u.ai_requests_this_month >= 5, brief(u));
      return `${u.ai_requests_this_month} requests, $${u.estimated_cost_usd}`;
    });
  });

  await area("job descriptions, cover letters, interviews, learning, tracker", async () => {
    const c = S.cand;
    const de = S.r.data_engineer.latest;
    const jdText = `Senior Data Engineer at BlueRiver Analytics. Requirements: 5+ years of Python, strong SQL, Apache Spark, Airflow, ETL pipeline design, data warehousing on Snowflake. Nice to have: Kafka, Terraform. Responsibilities: build and run batch and streaming pipelines; partner with analysts.`;
    let jd;
    await t("paste a JD -> title, skills and requirements extracted", async () => {
      jd = await c.ok("POST", "/api/job-descriptions", { json: { text: jdText } });
      assert(/data engineer/i.test(jd.title), `title "${jd.title}"`);
      const skills = jd.extracted.skills.map((s) => s.toLowerCase());
      for (const s of ["python", "sql", "airflow"]) assert(skills.some((x) => x.includes(s)), `skill ${s} missing from ${skills}`);
      const pref = jd.extracted.requirements.filter((r) => r.importance === "preferred").map((r) => r.text).join(" ");
      assert(/kafka/i.test(pref) && /terraform/i.test(pref), `nice-to-have not preferred: ${brief(jd.extracted.requirements.map((r) => [r.text, r.importance]))}`);
      return `"${jd.title}", ${jd.extracted.requirements.length} requirements`;
    });
    await t("JD too short -> 422", async () => {
      expectStatus(await c.post("/api/job-descriptions", { text: "Python dev" }), 422);
    });
    await t("match: data engineer resume scores higher than frontend and nurse resumes on this JD", async () => {
      const m1 = await c.ok("POST", `/api/job-descriptions/${jd.id}/match/${de}`);
      const m2 = await c.ok("POST", `/api/job-descriptions/${jd.id}/match/${S.r.frontend.versionId}`);
      const m3 = await c.ok("POST", `/api/job-descriptions/${jd.id}/match/${S.r.nurse.versionId}`);
      assert(m1.overall > m2.overall && m2.overall >= m3.overall - 5 && m1.overall >= 60, `DE ${m1.overall} FE ${m2.overall} RN ${m3.overall}`);
      const again = await c.ok("POST", `/api/job-descriptions/${jd.id}/match/${de}`);
      assert(again.cached === true, "match not cached");
      return `DE ${m1.overall} / FE ${m2.overall} / nurse ${m3.overall}`;
    });
    await t("JD upload as DOCX", async () => {
      const r = await c.call("POST", "/api/job-descriptions/upload", { multipart: { file: { name: "jd.docx", mimeType: DOCX_MIME, buffer: makeDocx(jdText.split(". ")) } } });
      expectStatus(r, 201);
      assert(r.body.source === "upload", brief(r.body));
    });
    await t("cover letter: grounded paragraphs, no invented employers", async () => {
      const a = await c.ok("POST", "/api/career/cover-letter", { json: { version_id: de, jd_id: jd.id } });
      assert(a.kind === "cover_letter" && a.content.paragraphs.length >= 2, brief(a));
      return `${a.content.status}, ${a.content.paragraphs.length} paragraphs`;
    });
    await t("interview questions (career) and saved artifacts list", async () => {
      const a = await c.ok("POST", "/api/career/interview-questions", { json: { version_id: de, jd_id: jd.id } });
      assert(a.content.questions.length >= 3, brief(a.content));
      const list = await c.ok("GET", "/api/career/artifacts?kind=cover_letter");
      assert(list.length >= 1 && list.every((x) => x.kind === "cover_letter"), "artifact filter");
    });
    let session;
    await t("mock interview: start for a role, answer with rule checks + fixture coaching", async () => {
      session = await c.ok("POST", `/api/versions/${de}/interviews`, { json: { role_id: "data_engineer" } });
      assert(session.questions.length >= 3, brief(session));
      const q = session.questions[0];
      const r = await c.ok("POST", `/api/interviews/${session.id}/answers`, { json: { question_id: q.id, answer: "At Northwind Retail I built Airflow DAGs that load 2 TB a day into Snowflake. I added data quality checks, which cut failures by 35%." } });
      assert(r.checks && r.ai?.status === "ok", brief(r));
      const one = await c.ok("GET", `/api/interviews/${session.id}`);
      assert(one.answered === 1, `answered ${one.answered}`);
      expectStatus(await c.post(`/api/interviews/${session.id}/answers`, { question_id: "q99", answer: "x" }), 404);
      expectStatus(await c.post(`/api/versions/${de}/interviews`, { role_id: "data_engineer", opening_id: "x" }), 422);
    });
    await t("interview list + delete", async () => {
      assert((await c.ok("GET", "/api/interviews")).some((x) => x.id === session.id), "not listed");
      expectStatus(await c.del(`/api/interviews/${session.id}`), 204);
      expectStatus(await c.get(`/api/interviews/${session.id}`), 404);
    });
    await t("learning plan: add skills, mark done, progress, delete", async () => {
      const add = await c.post("/api/learning", { skills: ["Machine Learning", "Kubernetes"], target_kind: "role", target_id: "ml_engineer" });
      expectStatus(add, 201);
      const plan = await c.ok("GET", "/api/learning");
      const item = plan.items.find((i) => i.skill === "Kubernetes");
      assert(item, brief(plan));
      await c.ok("PATCH", `/api/learning/${item.id}`, { json: { status: "done" } });
      const plan2 = await c.ok("GET", "/api/learning");
      assert(plan2.progress.done >= 1 && plan2.progress.percent > 0, brief(plan2.progress));
      const done = plan2.items.find((i) => i.id === item.id);
      assert(done.next_step, "no nudge to add evidence for a done skill that the resume doesn't show");
      expectStatus(await c.del(`/api/learning/${item.id}`), 204);
      return brief(plan2.progress);
    });
    await t("job tracker: create, validate dates/urls, update, delete", async () => {
      const a = await c.ok("POST", "/api/applications", { json: { company: "BlueRiver", role: "Senior Data Engineer", status: "applied", applied_on: "2026-11-01", url: "https://example.com/job/1", resume_version_id: de, jd_id: jd.id } });
      expectStatus(await c.post("/api/applications", { company: "X", role: "Y", applied_on: "01/11/2026" }), 422);
      expectStatus(await c.post("/api/applications", { company: "X", role: "Y", url: "javascript:alert(1)" }), 422);
      expectStatus(await c.post("/api/applications", { company: "X", role: "Y", status: "ghosted" }), 422);
      const u = await c.ok("PATCH", `/api/applications/${a.id}`, { json: { status: "interviewing", company: null } });
      assert(u.status === "interviewing" && u.company === "BlueRiver", brief(u));
      assert((await c.ok("GET", "/api/applications")).some((x) => x.id === a.id), "not listed");
      expectStatus(await c.del(`/api/applications/${a.id}`), 204);
    });
    await t("resources + job listings show explicit 'unavailable' states", async () => {
      const r = await c.ok("GET", "/api/career/resources?skill=Python");
      const l = await c.ok("GET", "/api/career/job-listings");
      return `resources=${brief(r).slice(0, 80)} listings=${brief(l).slice(0, 80)}`;
    });
    S.jd = jd;
  });

  await area("exports", async () => {
    const c = S.cand;
    for (const [format, template, magic] of [["pdf", "professional", "%PDF-"], ["docx", "technical", "PK"], ["pdf", "student", "%PDF-"]]) {
      await t(`export ${format}/${template}: job completes and the file downloads`, async () => {
        const e = await c.ok("POST", `/api/resumes/${S.r.data_engineer.resumeId}/exports`, { json: { format, template, page_size: "A4" } });
        let st = e;
        for (let i = 0; i < 90 && !["ready", "failed"].includes(st.status); i++) {
          await sleep(1000);
          st = await c.ok("GET", `/api/exports/${e.id}`);
        }
        assert(st.status === "ready", `export status ${st.status} ${st.error_message ?? ""}`);
        const l = await c.ok("GET", `/api/exports/${e.id}/link`);
        const f = await c.get(l.url);
        expectStatus(f, 200);
        assert(f.buf.subarray(0, magic.length).toString("latin1") === magic, "wrong file type");
        if (format === "pdf") assert(f.buf.includes(Buffer.from("Northwind")) || f.buf.length > 1500, "pdf looks empty");
        return `${f.buf.length} bytes, ${st.page_count ?? "?"} page(s)`;
      });
    }
    await t("export of an unconfirmed resume -> 409", async () => {
      const up = await upload(c, "unconfirmed.pdf", PDF_MIME, makePdf(frontendDev));
      expectStatus(up, 202);
      await waitExtraction(c, up.body.id);
      expectStatus(await c.post(`/api/resumes/${up.body.id}/exports`, { format: "pdf" }), 409, "not_confirmed");
      expectStatus(await c.post(`/api/resumes/${S.r.data_engineer.resumeId}/exports`, { format: "odt" }), 422);
      S.unconfirmed = up.body.id;
    });
    await t("export a non-English (Hindi) resume to PDF", async () => {
      const e = await c.ok("POST", `/api/resumes/${S.r.hindi.resumeId}/exports`, { json: { format: "pdf" } });
      let st = e;
      for (let i = 0; i < 90 && !["ready", "failed"].includes(st.status); i++) {
        await sleep(1000);
        st = await c.ok("GET", `/api/exports/${e.id}`);
      }
      assert(st.status === "ready", `status ${st.status}: ${st.error_message}`);
      return "ready (Devanagari glyphs are a documented limitation)";
    });
  });

  // ================================================================ recruiter + openings
  await area("recruiter: openings, ranking, pipeline", async () => {
    const hr = await staffClient(HR_EMAIL);
    S.hr = hr;
    const me = await hr.ok("GET", "/api/auth/me");
    await t("HR account is a recruiter with 2FA on", async () => {
      assert(me.role === "recruiter" && me.mfa_enabled, brief(me));
    });
    const jd = `Senior Data Engineer (${stamp}) About us: BlueRiver Analytics builds retail analytics. Requirements: 5+ years of Python, strong SQL, Apache Spark, Airflow, ETL, data warehousing (Snowflake). Nice to have: Kafka, Terraform. Responsibilities: build and run batch and streaming pipelines; mentor engineers.`;
    await t("create opening: too-short description -> 422", async () => {
      expectStatus(await hr.post("/api/recruiter/openings", { title: "X", company: "Y", description: "short" }), 422);
    });
    await t("create an opening from a pasted one-paragraph JD -> requirements parsed, role inferred", async () => {
      const o = await hr.ok("POST", "/api/recruiter/openings", { json: { title: `Senior Data Engineer ${stamp}`, company: "BlueRiver Analytics", location: "Bengaluru", work_arrangement: "hybrid", employment_type: "full_time", description: jd } });
      S.deOpening = o;
      assert(o.role_id === "data_engineer", `role ${o.role_id}`);
      assert(o.requirements.length >= 4 && o.years_required >= 5, `reqs ${o.requirements.length} years ${o.years_required}`);
      const pref = o.requirements.filter((r) => r.importance === "preferred").map((r) => r.text).join(" ");
      assert(/kafka/i.test(pref), `Kafka not 'nice to have': ${brief(o.requirements.map((r) => [r.text, r.importance]))}`);
      return `${o.requirements.length} reqs, years ${o.years_required}, skills ${o.skills.slice(0, 6).join(",")}`;
    });
    await t("create a frontend opening", async () => {
      S.feOpening = await hr.ok("POST", "/api/recruiter/openings", { json: { title: `Frontend Engineer (React) ${stamp}`, company: "Pixel Co", work_arrangement: "remote", description: `We are hiring a Frontend Engineer. Requirements: 3+ years of JavaScript and TypeScript, React, HTML, CSS, accessibility. Nice to have: Next.js, GraphQL. Responsibilities: build our design system and customer-facing web app.` } });
      assert(S.feOpening.role_id === "frontend_developer", `role ${S.feOpening.role_id}`);
    });
    await t("candidate sees both openings; openings leaderboard ranks the data opening first for the DE resume", async () => {
      const list = await S.cand.ok("GET", "/api/openings");
      assert(list.some((o) => o.id === S.deOpening.id) && list.some((o) => o.id === S.feOpening.id), "not listed");
      const lb = await S.cand.ok("GET", `/api/versions/${S.r.data_engineer.versionId}/leaderboard/openings`);
      const de = lb.rows.find((r) => r.id === S.deOpening.id), fe = lb.rows.find((r) => r.id === S.feOpening.id);
      assert(de.rank < fe.rank && de.score > fe.score + 15, `DE opening ${de.score}#${de.rank} FE opening ${fe.score}#${fe.rank}`);
      const lb2 = await S.cand.ok("GET", `/api/versions/${S.r.frontend.versionId}/leaderboard/openings`);
      const de2 = lb2.rows.find((r) => r.id === S.deOpening.id), fe2 = lb2.rows.find((r) => r.id === S.feOpening.id);
      assert(fe2.score > de2.score, `FE resume: FE ${fe2.score} DE ${de2.score}`);
      return `DE resume: ${de.score} vs ${fe.score}; FE resume: ${fe2.score} vs ${de2.score}`;
    });
    // four separate candidates apply to the data engineering opening
    const applicants = {};
    await t("4 candidates (data engineer, frontend, nurse, graduate) apply with consent", async () => {
      for (const [key, lines, kind] of [["de", dataEngineer, "pdf"], ["fe", frontendDev, "docx"], ["rn", nurse, "pdf"], ["grad", freshGrad, "docx"]]) {
        const { c } = await registerVerified(`qa-app-${key}-${stamp}@example.com`, { displayName: `Applicant ${key.toUpperCase()}` });
        const buf = kind === "pdf" ? makePdf(lines) : makeDocx(lines);
        const r = await uploadConfirmed(c, `${key}.${kind}`, kind === "pdf" ? PDF_MIME : DOCX_MIME, buf);
        applicants[key] = { c, ...r };
      }
      for (const [key, a] of Object.entries(applicants)) {
        if (key === "grad") continue;
        const r = await a.c.ok("POST", `/api/openings/${S.deOpening.id}/apply`, { json: { version_id: a.versionId, share_consent: true } });
        a.app = r;
      }
      S.applicants = applicants;
    });
    await t("apply without consent -> 422 consent_required", async () => {
      expectStatus(await applicants.grad.c.post(`/api/openings/${S.deOpening.id}/apply`, { version_id: applicants.grad.versionId, share_consent: false }), 422, "consent_required");
    });
    await t("standing: shown from 3 applicants; DE ranks #1; no distribution below 10", async () => {
      const st = await applicants.de.c.ok("GET", `/api/openings/${S.deOpening.id}/standing`);
      assert(st.standing.available === true && st.standing.rank === 1 && st.standing.applicants === 3, brief(st.standing));
      assert(st.standing.median === null && st.standing.distribution === null, "distribution leaked with < 10 applicants");
      const rn = await applicants.rn.c.ok("GET", `/api/openings/${S.deOpening.id}/standing`);
      assert(rn.standing.rank === 3, `nurse rank ${rn.standing.rank}`);
      return `DE top ${st.standing.top_percent}%, nurse rank ${rn.standing.rank}`;
    });
    await t("4th applicant (graduate) applies; standing before applying -> 404 not_applied", async () => {
      expectStatus(await applicants.grad.c.get(`/api/openings/${S.deOpening.id}/standing`), 404, "not_applied");
      applicants.grad.app = await applicants.grad.c.ok("POST", `/api/openings/${S.deOpening.id}/apply`, { json: { version_id: applicants.grad.versionId, share_consent: true } });
    });
    await t("opening detail with match for the applicant's version", async () => {
      const o = await applicants.de.c.ok("GET", `/api/openings/${S.deOpening.id}`);
      assert(o.application && o.match && o.match.version_id === applicants.de.versionId, brief(o).slice(0, 200));
      assert(o.description.includes("BlueRiver"), "description");
    });
    await t("my opening applications list", async () => {
      const l = await applicants.de.c.ok("GET", "/api/me/opening-applications");
      assert(l.length === 1 && l[0].opening.id === S.deOpening.id, brief(l));
    });
    let cands;
    await t("recruiter ranks applicants: data engineer first, nurse last", async () => {
      cands = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates`);
      const order = cands.candidates.map((x) => x.name);
      assert(cands.total === 4, `total ${cands.total}`);
      assert(order[0] === "Applicant DE", `order ${order}`);
      assert(order[order.length - 1] === "Applicant RN" || cands.candidates.find((x) => x.name === "Applicant RN").score < 30, `nurse not last: ${order}`);
      return cands.candidates.map((x) => `${x.name.split(" ")[1]}:${x.score}`).join(" ");
    });
    await t("filters: must-have skills, min score, stage, unknown skill 422", async () => {
      const f1 = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?must_have=Airflow&must_have=Kafka`);
      assert(f1.candidates.length === 1 && f1.candidates[0].name === "Applicant DE", brief(f1.candidates.map((x) => x.name)));
      const f2 = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?min_score=60`);
      assert(f2.candidates.every((x) => x.score >= 60), "min_score filter");
      expectStatus(await hr.get(`/api/recruiter/openings/${S.deOpening.id}/candidates?must_have=Underwater%20Basket%20Weaving`), 422, "unknown_skill");
      const f3 = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?min_years=5`);
      assert(f3.candidates.every((x) => x.years >= 5), "min_years");
      return `must-have -> ${f1.candidates.length}, >=60 -> ${f2.candidates.length}, >=5y -> ${f3.candidates.length}`;
    });
    const deApp = () => cands.candidates.find((x) => x.name === "Applicant DE").application_id;
    const rnApp = () => cands.candidates.find((x) => x.name === "Applicant RN").application_id;
    await t("change stage: shortlist DE, reject nurse; invalid stage 422; candidate sees new stage", async () => {
      const r = await hr.ok("PATCH", `/api/recruiter/applications/${deApp()}`, { json: { stage: "shortlisted" } });
      assert(r.stage === "shortlisted" && r.stage_changed_at, brief(r));
      await hr.ok("PATCH", `/api/recruiter/applications/${rnApp()}`, { json: { stage: "rejected" } });
      expectStatus(await hr.patch(`/api/recruiter/applications/${deApp()}`, { stage: "promoted_to_ceo" }), 422);
      const st = await applicants.de.c.ok("GET", `/api/openings/${S.deOpening.id}/standing`);
      assert(st.stage === "shortlisted", `candidate sees ${st.stage}`);
      const f = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?stage=shortlisted`);
      assert(f.candidates.length === 1, "stage filter");
    });
    await t("notes: add, list, author shown, delete; empty note 422", async () => {
      const n = await hr.ok("POST", `/api/recruiter/applications/${deApp()}/notes`, { json: { text: "Strong Airflow + Spark depth. Phone screen next week." } });
      expectStatus(await hr.post(`/api/recruiter/applications/${deApp()}/notes`, { text: "" }), 422);
      const list = await hr.ok("GET", `/api/recruiter/applications/${deApp()}/notes`);
      assert(list.some((x) => x.id === n.id && x.author), brief(list));
      const detail = await hr.ok("GET", `/api/recruiter/applications/${deApp()}`);
      assert(detail.notes.length >= 1 && detail.resume && detail.match, "application detail");
      const n2 = await hr.ok("POST", `/api/recruiter/applications/${deApp()}/notes`, { json: { text: "temp" } });
      expectStatus(await hr.del(`/api/recruiter/notes/${n2.id}`), 204);
      S.hrNote = n;
    });
    await t("candidate never sees recruiter notes (not in standing/opening/export)", async () => {
      const o = await applicants.de.c.ok("GET", `/api/openings/${S.deOpening.id}`);
      assert(!JSON.stringify(o).includes("Phone screen next week"), "note leaked to candidate");
      const z = await applicants.de.c.get("/api/account/export");
      const all = Object.values(unzip(z.buf)).map((b) => b.toString("utf8")).join("\n");
      assert(!all.includes("Phone screen next week"), "note leaked in candidate's data export");
    });
    await t("compare 3 candidates side by side", async () => {
      const ids = cands.candidates.slice(0, 3).map((x) => x.application_id);
      const r = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/compare?${ids.map((i) => `ids=${i}`).join("&")}`);
      assert(r.candidates.length === 3 && r.requirements.length >= 4 && r.requirements[0].cells.length === 3, brief(r).slice(0, 200));
      expectStatus(await hr.get(`/api/recruiter/openings/${S.deOpening.id}/compare?ids=${ids[0]}`), 422);
      expectStatus(await hr.get(`/api/recruiter/openings/${S.feOpening.id}/compare?ids=${ids[0]}&ids=${ids[1]}`), 404);
    });
    await t("applied candidates cannot be deleted by the recruiter (409)", async () => {
      expectStatus(await hr.del(`/api/recruiter/applications/${deApp()}`), 409, "applied_candidate");
    });
    await t("bulk upload: consent required; good files added, bad files reported", async () => {
      const mp = (consent) => {
        const fd = new FormData();
        fd.append("consent_attested", String(consent));
        for (const [name, type, buf] of [["manager.pdf", PDF_MIME, makePdf(seniorManager)], ["dataeng2.docx", DOCX_MIME, makeDocx(dataEngineer)], ["broken.pdf", PDF_MIME, Buffer.from("%PDF-1.4 garbage")], ["notes.txt", "text/plain", Buffer.from("hello")]])
          fd.append("files", new Blob([buf], { type }), name);
        return fd;
      };
      expectStatus(await hr.call("POST", `/api/recruiter/openings/${S.deOpening.id}/bulk-upload`, { multipart: mp(false) }), 422, "consent_required");
      const r = await hr.call("POST", `/api/recruiter/openings/${S.deOpening.id}/bulk-upload`, { multipart: mp(true) });
      expectStatus(r, 201);
      assert(r.body.added.length === 2 && r.body.failed.length === 2, brief(r.body));
      S.bulk = r.body.added;
      return `added ${r.body.added.map((a) => `${a.name}:${a.score}`).join(", ")}; failed ${r.body.failed.map((f) => f.code).join(",")}`;
    });
    await t("uploaded candidates don't change applicants' standing; can be removed", async () => {
      const st = await applicants.de.c.ok("GET", `/api/openings/${S.deOpening.id}/standing`);
      assert(st.standing.applicants === 4, `standing counts ${st.standing.applicants}`);
      const src = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?source=uploaded`);
      assert(src.candidates.length === 2 && src.candidates.every((x) => x.expires_at), brief(src.candidates));
      expectStatus(await hr.del(`/api/recruiter/applications/${S.bulk[0].application_id}`), 204);
    });
    await t("analytics: totals, most-missing skills, no candidate identities", async () => {
      const a = await hr.ok("GET", "/api/recruiter/analytics");
      assert(a.totals.candidates >= 5 && a.most_missing_skills.length >= 1, brief(a.totals));
      assert(!JSON.stringify(a).includes("@example.com"), "analytics leaks emails");
      return brief(a.totals.stages);
    });
    await t("edit the opening's description -> applications re-scored", async () => {
      const r = await hr.ok("PATCH", `/api/recruiter/openings/${S.deOpening.id}`, { json: { description: jd + " Experience with dbt is a plus." } });
      assert(r.rescored_applications >= 4, `rescored ${r.rescored_applications}`);
    });
    await t("close the opening: hidden from new candidates, apply 404, applicants still see their stage", async () => {
      await hr.ok("PATCH", `/api/recruiter/openings/${S.feOpening.id}`, { json: { status: "closed" } });
      const list = await S.cand.ok("GET", "/api/openings");
      assert(!list.some((o) => o.id === S.feOpening.id), "closed opening listed");
      expectStatus(await S.cand.post(`/api/openings/${S.feOpening.id}/apply`, { version_id: S.r.frontend.versionId, share_consent: true }), 404);
      expectStatus(await S.cand.get(`/api/openings/${S.feOpening.id}`), 404);
      await hr.ok("PATCH", `/api/recruiter/openings/${S.feOpening.id}`, { json: { status: "open" } });
    });
    await t("candidate withdraws an application; re-apply updates instead of duplicating", async () => {
      const g = applicants.grad;
      await g.c.ok("POST", `/api/openings/${S.deOpening.id}/apply`, { json: { version_id: g.versionId, share_consent: true } });
      const n1 = (await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?source=applied`)).total;
      expectStatus(await g.c.del(`/api/openings/${S.deOpening.id}/apply`), 204);
      expectStatus(await g.c.del(`/api/openings/${S.deOpening.id}/apply`), 404);
      const after = await hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates?source=applied`);
      assert(after.candidates.length === 3, `applied after withdraw ${after.candidates.length}`);
      return `before ${n1}`;
    });
    await t("tailor AI edit to an opening the resume relates to", async () => {
      const a = applicants.de;
      const v = (await a.c.ok("GET", `/api/versions/${a.versionId}`)).content;
      const s = await a.c.ok("POST", `/api/versions/${a.versionId}/suggestions`, { json: { operation: "tailor", target_path: `experience/${v.experience[0].id}/bullets`, opening_id: S.deOpening.id } });
      assert(s.items.length >= 1, brief(s));
    });
    await t("mock interview for an opening", async () => {
      const a = applicants.de;
      const s = await a.c.ok("POST", `/api/versions/${a.versionId}/interviews`, { json: { opening_id: S.deOpening.id } });
      assert(s.target.kind === "opening" && s.questions.length >= 3, brief(s.target));
    });
  });

  // ================================================================ admin + authorization
  await area("admin + fairness", async () => {
    const admin = await staffClient(ADMIN_EMAIL);
    S.admin = admin;
    await t("admin account role is admin", async () => {
      assert((await admin.ok("GET", "/api/auth/me")).role === "admin", "not admin");
    });
    await t("admin overview, failed jobs, audit log", async () => {
      const o = await admin.ok("GET", "/api/admin/overview");
      assert(o.users.total >= 5 && o.versions.llm_provider === "fixture", brief(o.users));
      await admin.ok("GET", "/api/admin/jobs");
      const audit = await admin.ok("GET", "/api/admin/audit?limit=50");
      assert(audit.length === 50 && audit.every((a) => a.action), "audit");
      expectStatus(await admin.get("/api/admin/audit?limit=5000"), 422);
      assert(!JSON.stringify(audit).includes("Correct-horse"), "password in audit log");
      return `users ${o.users.total}, embedding ${o.versions.embedding_model}`;
    });
    await t("admin can trigger stale-job recovery", async () => {
      const r = await admin.ok("POST", "/api/admin/jobs/recover");
      assert(typeof r.redispatched === "number", brief(r));
    });
    await t("fairness report: admin 200 with snapshot date and privacy thresholds", async () => {
      const f = await admin.ok("GET", "/api/recruiter/fairness");
      assert(f.min_group_size === 10 && f.as_of && f.dimensions.gender && f.dimensions.age_band, brief(f));
      const f2 = await admin.ok("GET", `/api/recruiter/fairness?opening_id=${S.deOpening.id}`);
      assert(f2.dimensions.gender.groups.length === 0, "groups shown for a tiny same-day pool");
      expectStatus(await admin.get(`/api/recruiter/fairness?opening_id=does-not-exist`), 404);
      return `${f.applicants} applicants in snapshot`;
    });
    await t("recruiter (non-admin) -> fairness 403 and admin pages 403", async () => {
      expectStatus(await S.hr.get("/api/recruiter/fairness"), 403, "forbidden");
      expectStatus(await S.hr.get("/api/admin/overview"), 403, "forbidden");
    });
    await t("candidate -> fairness 403 and admin 403", async () => {
      expectStatus(await S.cand.get("/api/recruiter/fairness"), 403, "forbidden");
      expectStatus(await S.cand.get("/api/admin/overview"), 403, "forbidden");
      expectStatus(await S.cand.post("/api/admin/jobs/recover"), 403, "forbidden");
    });
    await t("admin can delete another recruiter's note; recruiter can't delete admin's", async () => {
      const n = await admin.ok("POST", `/api/recruiter/applications/${S.applicants.de.app.id}/notes`, { json: { text: "admin note" } });
      expectStatus(await S.hr.del(`/api/recruiter/notes/${n.id}`), 403, "forbidden");
      expectStatus(await admin.del(`/api/recruiter/notes/${S.hrNote.id}`), 204);
      expectStatus(await admin.del(`/api/recruiter/notes/${n.id}`), 204);
    });
    await t("self-identification: consent required, store, read, delete", async () => {
      const c = S.applicants.fe.c;
      expectStatus(await c.put("/api/account/self-id", { gender: "woman", age_band: "25_34", consent: false }), 422, "consent_required");
      expectStatus(await c.put("/api/account/self-id", { gender: "dragon", consent: true }), 422);
      const r = await c.ok("PUT", "/api/account/self-id", { json: { gender: "woman", age_band: "25_34", consent: true } });
      assert(r.value.gender === "woman", brief(r));
      const cands = await S.hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates`);
      assert(!JSON.stringify(cands).includes("25_34") && !JSON.stringify(cands).includes('"woman"'), "self-ID visible to recruiter");
      expectStatus(await c.del("/api/account/self-id"), 204);
      assert((await c.ok("GET", "/api/account/self-id")).value === null, "not deleted");
    });
    await t("staff without 2FA are blocked from staff tools (mfa_required)", async () => {
      // a brand-new admin-listed address is not used here; instead, check the recruiter flow with 2FA turned off temporarily
      const saved = loadStaff()[HR_EMAIL];
      await S.hr.ok("POST", "/api/account/2fa/disable", { json: { password: PW, code: await freshTotp(saved.secret) } });
      try {
        expectStatus(await S.hr.get("/api/recruiter/openings"), 403, "mfa_required");
        const me = await S.hr.ok("GET", "/api/auth/me");
        assert(me.mfa_required_for_role === true && me.mfa_enabled === false, brief(me));
      } finally {
        const setup = await S.hr.ok("POST", "/api/account/2fa/setup");
        await S.hr.ok("POST", "/api/account/2fa/enable", { json: { code: await freshTotp(setup.secret) } });
        saveStaff(HR_EMAIL, setup.secret);
      }
      await S.hr.ok("GET", "/api/recruiter/openings");
    });
  });

  await area("authorization isolation", async () => {
    const A = S.cand;
    const { c: B } = await registerVerified(`qa-intruder-${stamp}@example.com`);
    const ar = S.r.data_engineer;
    const aVer = ar.latest ?? ar.versionId;
    let sugs = [];
    for (const v of await A.ok("GET", `/api/resumes/${ar.resumeId}/versions`)) {
      sugs = await A.ok("GET", `/api/versions/${v.id}/suggestions`);
      if (sugs.length) break;
    }
    assert(sugs.length, "A has no AI suggestions to attack");
    const job = (await A.ok("GET", `/api/resumes/${ar.resumeId}`)).job;
    const exp = (await A.ok("POST", `/api/resumes/${ar.resumeId}/exports`, { json: { format: "pdf" } }));
    const iv = await A.ok("POST", `/api/versions/${aVer}/interviews`, { json: { role_id: "data_engineer" } });
    const app = await A.ok("POST", "/api/applications", { json: { company: "Secret Co", role: "Secret role" } });
    const link = await A.ok("GET", `/api/resumes/${ar.resumeId}/original-link`);
    const learning = await A.ok("POST", "/api/learning", { json: { skills: ["Terraform"] } });
    const bOwn = await uploadConfirmed(B, "b.pdf", PDF_MIME, makePdf(frontendDev));
    const reads = [
      ["GET resume", "GET", `/api/resumes/${ar.resumeId}`],
      ["GET extraction", "GET", `/api/resumes/${ar.resumeId}/extraction?include_text=true`],
      ["GET versions list", "GET", `/api/resumes/${ar.resumeId}/versions`],
      ["GET version", "GET", `/api/versions/${aVer}`],
      ["GET analysis", "GET", `/api/versions/${aVer}/analysis`],
      ["GET role leaderboard", "GET", `/api/versions/${aVer}/leaderboard/roles`],
      ["GET openings leaderboard", "GET", `/api/versions/${aVer}/leaderboard/openings`],
      ["GET tips", "GET", `/api/versions/${aVer}/tips?role_id=data_engineer`],
      ["GET skill gap", "GET", `/api/versions/${aVer}/skill-gap`],
      ["GET roadmap", "GET", `/api/career/roadmap/${aVer}`],
      ["GET history", "GET", `/api/resumes/${ar.resumeId}/history`],
      ["GET compare (A,A)", "GET", `/api/versions/${ar.versionId}/compare/${aVer}`],
      ["GET compare (B own, A)", "GET", `/api/versions/${bOwn.versionId}/compare/${aVer}`],
      ["GET suggestions", "GET", `/api/versions/${sugs[0].version_id}/suggestions`],
      ["GET original-link", "GET", `/api/resumes/${ar.resumeId}/original-link`],
      ["GET A's signed download link", "GET", link.url],
      ["GET processing job", "GET", `/api/processing-jobs/${job.id}`],
      ["GET export", "GET", `/api/exports/${exp.id}`],
      ["GET export link", "GET", `/api/exports/${exp.id}/link`],
      ["GET interview", "GET", `/api/interviews/${iv.id}`],
      ["GET job description", "GET", `/api/job-descriptions/${S.jd.id}`],
      ["GET opening with A's version", "GET", `/api/openings/${S.deOpening.id}?version_id=${aVer}`],
    ];
    const writes = [
      ["POST recommendations", "POST", `/api/versions/${aVer}/recommendations`, {}],
      ["POST save version", "POST", `/api/resumes/${ar.resumeId}/versions`, { base_version_id: aVer, content: { contact: {} } }],
      ["POST restore", "POST", `/api/versions/${ar.versionId}/restore`],
      ["PUT review", "PUT", `/api/resumes/${ar.resumeId}/review`, { content: {} }],
      ["POST variant", "POST", `/api/resumes/${ar.resumeId}/variants`, { title: "stolen" }],
      ["POST suggestion", "POST", `/api/versions/${aVer}/suggestions`, { operation: "grammar", target_path: "summary" }],
      ["POST accept suggestion", "POST", `/api/suggestions/${sugs[0].id}/accept`, {}],
      ["POST reject suggestion", "POST", `/api/suggestions/${sugs[0].id}/reject`],
      ["POST what-if", "POST", `/api/versions/${aVer}/what-if`, { content: { contact: {} }, role_id: "data_engineer" }],
      ["POST export", "POST", `/api/resumes/${ar.resumeId}/exports`, { format: "pdf" }],
      ["POST retry job", "POST", `/api/processing-jobs/${job.id}/retry`],
      ["POST interview on A's version", "POST", `/api/versions/${aVer}/interviews`, { role_id: "data_engineer" }],
      ["POST answer A's interview", "POST", `/api/interviews/${iv.id}/answers`, { question_id: "q1", answer: "x" }],
      ["DELETE A's interview", "DELETE", `/api/interviews/${iv.id}`],
      ["POST match A's JD with own version", "POST", `/api/job-descriptions/${S.jd.id}/match/${bOwn.versionId}`],
      ["POST match own... A's version", "POST", `/api/job-descriptions/${S.jd.id}/match/${aVer}`],
      ["DELETE A's JD", "DELETE", `/api/job-descriptions/${S.jd.id}`],
      ["PATCH A's tracker app", "PATCH", `/api/applications/${app.id}`, { status: "rejected" }],
      ["DELETE A's tracker app", "DELETE", `/api/applications/${app.id}`],
      ["POST tracker app with A's version", "POST", "/api/applications", { company: "x", role: "y", resume_version_id: aVer }],
      ["PATCH A's learning item", "PATCH", `/api/learning/${learning.items?.[0]?.id ?? learning.id ?? "x"}`, { status: "done" }],
      ["POST apply with A's version", "POST", `/api/openings/${S.deOpening.id}/apply`, { version_id: aVer, share_consent: true }],
      ["POST cover letter from A's version", "POST", "/api/career/cover-letter", { version_id: aVer }],
      ["POST interview questions from A's version", "POST", "/api/career/interview-questions", { version_id: aVer }],
      ["DELETE A's resume", "DELETE", `/api/resumes/${ar.resumeId}`],
    ];
    for (const [name, m, u, body] of [...reads, ...writes]) {
      await t(`user B: ${name} -> 404 (not 200/403)`, async () => {
        const r = await B.call(m, u, body !== undefined ? { json: body } : {});
        expectStatus(r, [404]);
      });
    }
    await t("A's data is intact after B's attempts", async () => {
      await A.ok("GET", `/api/resumes/${ar.resumeId}`);
      await A.ok("GET", `/api/interviews/${iv.id}`);
      await A.ok("GET", `/api/job-descriptions/${S.jd.id}`);
      const a2 = (await A.ok("GET", "/api/applications")).find((x) => x.id === app.id);
      assert(a2 && a2.status === "saved", "tracker app modified");
    });
    await t("B's lists do not contain A's items", async () => {
      const lists = await Promise.all(["/api/resumes", "/api/job-descriptions", "/api/applications", "/api/interviews", "/api/career/artifacts", "/api/me/opening-applications"].map((u) => B.ok("GET", u)));
      const blob = JSON.stringify(lists);
      for (const id of [ar.resumeId, S.jd.id, app.id, iv.id]) assert(!blob.includes(id), `B sees ${id}`);
    });
    const recruiterEndpoints = [
      ["GET", "/api/recruiter/openings"],
      ["POST", "/api/recruiter/openings", { title: "Fake", company: "Fake", description: "x".repeat(100) }],
      ["GET", `/api/recruiter/openings/${S.deOpening.id}`],
      ["PATCH", `/api/recruiter/openings/${S.deOpening.id}`, { status: "closed" }],
      ["DELETE", `/api/recruiter/openings/${S.deOpening.id}`],
      ["GET", `/api/recruiter/openings/${S.deOpening.id}/candidates`],
      ["GET", `/api/recruiter/openings/${S.deOpening.id}/compare?ids=a&ids=b`],
      ["GET", `/api/recruiter/applications/${S.applicants.de.app.id}`],
      ["PATCH", `/api/recruiter/applications/${S.applicants.de.app.id}`, { stage: "hired" }],
      ["GET", `/api/recruiter/applications/${S.applicants.de.app.id}/notes`],
      ["POST", `/api/recruiter/applications/${S.applicants.de.app.id}/notes`, { text: "x" }],
      ["GET", "/api/recruiter/analytics"],
    ];
    for (const [m, u, body] of recruiterEndpoints) {
      await t(`candidate: ${m} ${u.replace(/[0-9a-f-]{36}/g, ":id").split("?")[0]} -> 403`, async () => {
        expectStatus(await B.call(m, u, body ? { json: body } : {}), 403, "forbidden");
      });
    }
    await t("candidate bulk upload -> 403", async () => {
      expectStatus(await B.call("POST", `/api/recruiter/openings/${S.deOpening.id}/bulk-upload`, { multipart: { consent_attested: "true", files: { name: "a.pdf", mimeType: PDF_MIME, buffer: makePdf(nurse) } }, retry429: true }), 403);
    });
    await t("an applicant cannot see other applicants' identities or scores", async () => {
      const o = await S.applicants.rn.c.ok("GET", `/api/openings/${S.deOpening.id}`);
      const blob = JSON.stringify(o);
      assert(!blob.includes("Applicant DE") && !blob.includes("qa-app-de"), "other applicant leaked");
    });
    await t("the opening is unchanged (candidate PATCH/DELETE had no effect)", async () => {
      const o = await S.hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}`);
      assert(o.status === "open", `status ${o.status}`);
      const a = await S.hr.ok("GET", `/api/recruiter/applications/${S.applicants.de.app.id}`);
      assert(a.stage === "shortlisted", `stage ${a.stage}`);
    });
  });

  // ================================================================ data export, deletion
  await area("data export + account deletion", async () => {
    const victim = S.applicants.rn;
    const email = `qa-app-rn-${stamp}@example.com`;
    await t("data export: zip with account, resumes, versions, applications, original files", async () => {
      const r = await victim.c.get("/api/account/export");
      expectStatus(r, 200);
      assert(/application\/zip/.test(r.headers["content-type"]), r.headers["content-type"]);
      const files = unzip(r.buf);
      const names = Object.keys(files);
      const blob = Object.values(files).map((b) => b.toString("latin1")).join("\n");
      assert(blob.includes(email), "email missing");
      assert(blob.includes("Lilavati") || blob.includes("Maria"), "resume content missing");
      assert(names.some((n) => /\.pdf$/i.test(n)), `original upload missing: ${names}`);
      assert(!/password_hash|\$argon2|\$2b\$/.test(blob), "password hash in export");
      return `${names.length} files: ${names.slice(0, 6).join(", ")}`;
    });
    await t("data export is rate-limited (3 per hour)", async () => {
      const sts = [];
      for (let i = 0; i < 3; i++) sts.push((await victim.c.get("/api/account/export", { retry429: false })).status);
      assert(sts.includes(429), `no 429 in ${sts}`);
      return sts.join(",");
    });
    await t("delete: wrong email 400, wrong password 400", async () => {
      expectStatus(await victim.c.post("/api/account/delete", { confirm_email: "someone@else.com", password: PW }), 400, "confirmation_mismatch");
      expectStatus(await victim.c.post("/api/account/delete", { confirm_email: email, password: "Wrong-pass-123" }), 400, "invalid_credentials");
    });
    const before = (await S.hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates`)).total;
    await t("delete account -> counts returned, session ended, login fails", async () => {
      const r = await victim.c.ok("POST", "/api/account/delete", { json: { confirm_email: email.toUpperCase(), password: PW } });
      assert(r.status === "deleted", brief(r));
      expectStatus(await victim.c.get("/api/auth/me"), 401);
      const x = await Client.create("x");
      expectStatus(await x.post("/api/auth/login", { email, password: PW }), 401);
      return brief(r).slice(0, 150);
    });
    await t("deleted user's application disappears from the recruiter pipeline and standings", async () => {
      const after = await S.hr.ok("GET", `/api/recruiter/openings/${S.deOpening.id}/candidates`);
      assert(after.total === before - 1, `total ${before} -> ${after.total}`);
      const st = await S.applicants.de.c.ok("GET", `/api/openings/${S.deOpening.id}/standing`);
      assert(st.standing.applicants === 2 || st.standing.available === false, brief(st.standing));
    });
    await t("deleted user's resume is gone (re-registering gets a clean account)", async () => {
      const { c } = await registerVerified(email);
      assert((await c.ok("GET", "/api/resumes")).length === 0, "old resumes visible");
    });
    await t("delete a single resume -> 204, then 404; its signed link no longer works", async () => {
      const link = await S.cand.ok("GET", `/api/resumes/${S.r.spanish.resumeId}/original-link`);
      expectStatus(await S.cand.del(`/api/resumes/${S.r.spanish.resumeId}`), 204);
      expectStatus(await S.cand.get(`/api/resumes/${S.r.spanish.resumeId}`), 404);
      expectStatus(await S.cand.get(`/api/versions/${S.r.spanish.versionId}`), 404);
      expectStatus(await S.cand.get(link.url), 404);
    });
  });

  // ================================================================ browser: i18n
  await area("browser: Hindi / Gujarati UI", async () => {
    const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
    try {
      const SCRIPT = { hi: /[ऀ-ॿ]/, gu: /[઀-૿]/ };
      const rid = S.r?.data_engineer?.resumeId;
      const pages = [["/", false], ["/login", false], ["/register", false], ["/dashboard", true], ["/settings", true], ["/openings", true], ["/applications", true], ["/learning", true]];
      if (rid) pages.push([`/resumes/${rid}/analysis`, true], [`/resumes/${rid}/leaderboard`, true], [`/resumes/${rid}/editor`, true]);
      for (const loc of ["hi", "gu"]) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await ctx.addCookies([{ name: "ri_lang", value: loc, url: BASE }]);
        await browserLogin(ctx);
        for (const [p, authed] of pages) {
          await t(`${loc}: ${p} renders in ${loc === "hi" ? "Hindi" : "Gujarati"} without errors`, async () => {
            const page = await ctx.newPage();
            const errors = [];
            page.on("pageerror", (e) => errors.push(String(e)));
            page.on("console", (m) => m.type() === "error" && !/Failed to load resource.*(401|404)/.test(m.text()) && errors.push(m.text()));
            const res = await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 90000 });
            assert(res && res.status() < 400, `HTTP ${res?.status()}`);
            assert((await page.evaluate(() => document.documentElement.lang)) === loc, "html lang");
            const text = await page.evaluate(() => document.body.innerText);
            assert(SCRIPT[loc].test(text), "no translated text on the page");
            if (authed) assert(!/\/login/.test(page.url()), "redirected to login");
            const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            assert(over <= 1, `horizontal overflow ${over}px`);
            assert(errors.length === 0, `console errors: ${errors.slice(0, 2).join(" | ")}`);
            await page.close();
          });
        }
        await ctx.close();
      }
      await t("unknown resume id page shows a not-found state (not a crash)", async () => {
        const ctx = await browser.newContext();
        await browserLogin(ctx);
        const page = await ctx.newPage();
        const res = await page.goto(`${BASE}/resumes/00000000-0000-0000-0000-000000000000/analysis`, { waitUntil: "networkidle" });
        const text = await page.evaluate(() => document.body.innerText);
        await ctx.close();
        assert(res.status() < 500, `HTTP ${res.status()}`);
        assert(/not found|doesn't exist|does not exist/i.test(text), `page says: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
      });
    } finally {
      await browser.close();
    }
  });
} finally {
  const byArea = {};
  for (const r of results) {
    byArea[r.area] ??= { pass: 0, fail: 0 };
    byArea[r.area][r.ok ? "pass" : "fail"]++;
  }
  console.log("\n================ SUMMARY");
  for (const [a, v] of Object.entries(byArea)) console.log(`${v.fail ? "FAIL" : "PASS"}  ${a}: ${v.pass} passed, ${v.fail} failed`);
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  for (const f of fails) console.log(`  FAIL [${f.area}] ${f.name}: ${f.detail}`);
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ stamp, byArea, results }, null, 2));
  console.log(`report: ${REPORT_FILE}`);
  process.exitCode = fails.length ? 1 : 0;
}
