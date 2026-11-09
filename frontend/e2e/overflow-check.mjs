// Layout regression check: no page may scroll horizontally at desktop or phone widths.
// Usage: BASE=http://localhost:3020 MAILPIT=http://localhost:8025 node e2e/overflow-check.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3020";
const MAILPIT = process.env.MAILPIT ?? "http://localhost:8025";
const email = `layout-${Date.now()}@example.com`;
const password = "Layout-check-pass-42";
mkdirSync("e2e/screenshots/layout", { recursive: true });

const browser = await chromium.launch(process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
const page = await ctx.newPage();
const req = page.request;
const csrf = async () => (await ctx.cookies()).find((c) => c.name === "ri_csrf")?.value ?? "";
const api = async (method, url, data) => {
  const r = await req.fetch(BASE + url, { method, data, headers: { "x-csrf-token": await csrf() } });
  if (!r.ok()) throw new Error(`${method} ${url} -> ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
};

await api("POST", "/api/auth/register", { email, password });
let token;
for (let i = 0; i < 20 && !token; i++) {
  const list = await (await req.get(`${MAILPIT}/api/v1/search?query=to:${encodeURIComponent(email)}`)).json();
  if (list.messages?.length) {
    const msg = await (await req.get(`${MAILPIT}/api/v1/message/${list.messages[0].ID}`)).json();
    token = /token=([\w-]+)/.exec(msg.Text)?.[1];
  }
  if (!token) await new Promise((r) => setTimeout(r, 500));
}
await api("POST", "/api/auth/verify-email", { token });
await api("POST", "/api/auth/login", { email, password });

const pdf = readFileSync(process.env.RESUME_PDF ?? "e2e/fixtures/resume.pdf");
const up = await req.post(BASE + "/api/resumes", {
  multipart: { file: { name: "A_Very_Long_Resume_File_Name_For_Layout_Testing_2026.pdf", mimeType: "application/pdf", buffer: pdf } },
  headers: { "x-csrf-token": await csrf() },
});
const rid = (await up.json()).id;
let ex;
for (let i = 0; i < 60; i++) {
  const r = await req.get(`${BASE}/api/resumes/${rid}/extraction`);
  if (r.ok()) { ex = await r.json(); if (ex.content) break; }
  await new Promise((r) => setTimeout(r, 1000));
}

const pages = ["/dashboard", `/resumes/${rid}/review`];
const confirmedPages = ["analysis", "leaderboard", "match", "editor", "career"].map((s) => `/resumes/${rid}/${s}`);
const results = [];
async function measure(label) {
  for (const [w, h] of [[1920, 1000], [1280, 800], [375, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      // elements inside an intentional horizontal scroller (e.g. the tab bar on phones) are fine
      const inScroller = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
        }
        return false;
      };
      // consistency: page content must stay inside the same centred container as the header
      const box = document.querySelector("main#main")?.getBoundingClientRect();
      const pad = box ? parseFloat(getComputedStyle(document.querySelector("main#main")).paddingRight) : 0;
      const edge = box ? Math.min(window.innerWidth, box.right - pad) : window.innerWidth;
      const wide = [...document.querySelectorAll("main#main *")]
        .filter((el) => el.getBoundingClientRect().right > edge + 1 && !inScroller(el) && getComputedStyle(el).position !== "fixed"
          // a horizontal scroller (the tab bar) may intentionally bleed into the page gutter
          && !["auto", "scroll"].includes(getComputedStyle(el).overflowX))
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}[right=${Math.round(el.getBoundingClientRect().right)}]`);
      // guard against false passes: the app shell must have rendered with styles applied
      const main = document.querySelector("main#main");
      const rendered = !!main && main.innerText.trim().length > 40 && getComputedStyle(document.body).fontFamily.includes("Inter");
      return { scroll: de.scrollWidth, client: de.clientWidth, wide, rendered };
    });
    if (!m.rendered) m.wide.unshift("PAGE DID NOT RENDER WITH STYLES");
    const ok = m.rendered && m.scroll <= m.client && m.wide.length === 0;
    results.push({ page: label, width: w, ok, ...m });
    if (w !== 1280) await page.screenshot({ path: `e2e/screenshots/layout/${label.replace(/[/[\]]/g, "_")}-${w}.png`, fullPage: false });
  }
}
for (const p of pages) { await page.goto(BASE + p).catch(() => page.goto(BASE + p)); await page.waitForLoadState("networkidle"); await measure(p.replace(rid, "id")); }
await api("PUT", `/api/resumes/${rid}/review`, { content: ex.content });
for (const p of confirmedPages) { await page.goto(BASE + p).catch(() => page.goto(BASE + p)); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800); await measure(p.replace(rid, "id")); }
for (const p of ["/applications", "/settings"]) { await page.goto(BASE + p).catch(() => page.goto(BASE + p)); await page.waitForLoadState("networkidle"); await measure(p); }

// clean up the throwaway account
await api("POST", "/api/account/delete", { confirm_email: email, password });
await browser.close();
for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${String(r.width).padStart(4)}  ${r.page.padEnd(22)} scroll=${r.scroll} client=${r.client} ${r.wide.join(" | ")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
