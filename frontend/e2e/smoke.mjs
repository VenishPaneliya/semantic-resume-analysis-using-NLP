// End-to-end smoke test against a running frontend (BASE_URL) + backend.
// Usage: BASE_URL=http://localhost:3000 BACKEND_LOG=e2e/backend.log RESUME_PDF=e2e/fixtures/resume.pdf node e2e/smoke.mjs
// The verification token is read from the backend log (EMAIL_BACKEND=console).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const LOG = process.env.BACKEND_LOG ?? "e2e/backend.log";
const PDF = process.env.RESUME_PDF ?? "e2e/fixtures/resume.pdf";
const OUT = "e2e/screenshots";
fs.mkdirSync(OUT, { recursive: true });

const email = `e2e-${Date.now()}@example.com`;
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

async function shot(page, name, full = true) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
}

function tokenFromLog(addr) {
  const txt = fs.readFileSync(LOG, "utf8");
  const re = new RegExp(`EMAIL to ${addr.replace(/[.+]/g, "\\$&")}[\\s\\S]*?verify-email\\?token=([\\w-]+)`, "g");
  let m, last = null;
  while ((m = re.exec(txt))) last = m[1];
  if (!last) throw new Error("verification token not found in backend log");
  return last;
}

const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  await check("landing renders", async () => {
    await page.goto(BASE + "/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await shot(page, "01-landing");
  });

  await check("register", async () => {
    await page.goto(BASE + "/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/dashboard/);
    await page.getByText("Verify your email to start uploading").waitFor();
    await shot(page, "02-dashboard-unverified");
  });

  await check("verify email via token from backend log", async () => {
    await page.waitForTimeout(500);
    const tok = tokenFromLog(email);
    await page.goto(`${BASE}/verify-email?token=${tok}`);
    await page.getByText("Email verified").waitFor();
  });

  let resumeUrl = "";
  await check("upload PDF and reach needs-review", async () => {
    await page.goto(BASE + "/dashboard");
    await page.locator('input[type="file"]').setInputFiles(PDF);
    await page.getByRole("link", { name: /Review extraction/ }).waitFor({ timeout: 60000 });
    await shot(page, "03-dashboard-uploaded");
    await page.getByRole("link", { name: /Review extraction/ }).click();
    await page.waitForURL(/\/review/);
    resumeUrl = page.url().replace(/\/review.*$/, "");
  });

  await check("review extraction and confirm", async () => {
    await page.getByRole("button", { name: /Confirm extraction/ }).waitFor();
    await shot(page, "04-review");
    await page.getByRole("button", { name: /Confirm extraction/ }).click();
    await page.waitForURL(/\/analysis/);
  });

  await check("analysis dashboard", async () => {
    await page.getByText("Overall indicator", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Prioritised improvements" }).waitFor();
    await page.getByLabel("Target role").selectOption("backend_developer");
    await page.getByText(/Core skills present/).waitFor();
    await shot(page, "05-analysis");
  });

  await check("role leaderboard (old /roles link redirects)", async () => {
    await page.goto(resumeUrl + "/roles");
    await page.waitForURL(//leaderboard$/);
    await page.getByTestId("role-row").first().waitFor();
    await page.getByText("Seniority estimate").waitFor();
    await shot(page, "06-roles");
  });

  await check("job description match", async () => {
    await page.goto(resumeUrl + "/match");
    await page.getByLabel("Job description", { exact: true }).fill(
      "Backend Engineer\nRequirements\n- 2+ years of professional experience building APIs\n- Strong Python and SQL\n- Kubernetes\n- Must be authorized to work in the US\nNice to have\n- Terraform",
    );
    await page.getByRole("button", { name: /Add & compare/ }).click();
    await page.getByRole("heading", { name: "Requirement by requirement" }).waitFor({ timeout: 30000 });
    await shot(page, "07-match");
  });

  await check("editor: AI suggestion, fixture badge, accept creates new version", async () => {
    await page.goto(resumeUrl + "/editor");
    await page.getByRole("group", { name: "AI tools for this bullet" }).first().getByRole("button", { name: "Rewrite" }).click();
    const card = page.locator("article[aria-label^='AI suggestion']").first();
    await card.waitFor({ timeout: 30000 });
    await card.getByText("Development fixture — not live AI").waitFor();
    await card.getByText(/AI suggestion — not applied/).waitFor();
    await shot(page, "08-editor-suggestion", false);
    await card.getByRole("button", { name: /^Accept/ }).click();
    await page.getByText(/v2/).first().waitFor();
    await shot(page, "09-editor-accepted", false);
  });

  await check("history shows AI-accepted version", async () => {
    await page.getByRole("tab", { name: "History" }).click();
    await page.getByText("Accepted AI: rewrite bullet").waitFor();
    await shot(page, "10-history", false);
  });

  await check("export PDF with placeholder warning", async () => {
    await page.getByRole("tab", { name: "Export" }).click();
    await page.getByRole("button", { name: /Generate export/ }).click();
    await page.getByText("Export ready").waitFor({ timeout: 30000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
    const p = path.join(OUT, "export.pdf");
    await download.saveAs(p);
    const head = fs.readFileSync(p).subarray(0, 5).toString();
    if (head !== "%PDF-") throw new Error("download is not a PDF");
    await shot(page, "11-export", false);
  });

  await check("career, applications, settings pages render", async () => {
    await page.goto(resumeUrl + "/career");
    await page.getByRole("heading", { name: "Skill gap dashboard" }).waitFor();
    await page.getByText(/Learning resources unavailable|No gaps/).first().waitFor({ timeout: 15000 }).catch(() => {});
    await shot(page, "12-career");
    await page.goto(BASE + "/applications");
    await page.getByRole("button", { name: /Add application/ }).click();
    await page.getByLabel("Company").fill("Acme");
    await page.getByLabel("Role", { exact: true }).fill("Backend Engineer");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("cell", { name: /Acme/ }).first().waitFor();
    await shot(page, "13-applications");
    await page.goto(BASE + "/settings");
    await page.getByRole("heading", { name: "AI & privacy" }).waitFor();
    await shot(page, "14-settings");
  });

  await check("mobile layout of analysis (390px)", async () => {
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await m.context().addCookies(await ctx.cookies());
    await m.goto(resumeUrl + "/analysis");
    await m.getByText("Overall indicator", { exact: true }).waitFor();
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await m.screenshot({ path: path.join(OUT, "15-mobile-analysis.png"), fullPage: false });
    if (overflow) throw new Error("horizontal page overflow at 390px");
    await m.close();
  });

  await check("no uncaught page errors", async () => {
    const real = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
    if (real.length) throw new Error(real.slice(0, 3).join(" | "));
  });
} catch {
  await shot(page, "FAILED-" + step.replace(/\W+/g, "-")).catch(() => {});
} finally {
  await browser.close();
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
