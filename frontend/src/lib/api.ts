/* Typed same-origin API client. Session lives in an HTTP-only cookie; unsafe requests
   carry the double-submit CSRF token read from the non-HttpOnly `ri_csrf` cookie.
   Messages from the API stay in English; only the frontend's own fallback messages are translated. */

import { translateNow, type MessageKey } from "./i18n";

export interface FieldError {
  /** dotted path of the field, without the leading "body" ("email", "career_prefs.locations.0") */
  field: string;
  /** the API's (English) explanation, e.g. "String should have at least 10 characters" */
  message: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  /** per-field problems from a 422 validation error (empty for other errors) */
  fields: FieldError[];
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.fields = fieldErrors(details);
  }
}

/* The API answers invalid input with 422 { code: "validation_error", message: "Some fields are invalid.",
   errors: [{ loc: ["body", "email"], msg: "value is not a valid email address: ..." }] }. Turn that into
   "Please check: Email — value is not a valid email address" so people know what to fix. Field names are
   translated where the interface has a label for them; the API's explanation stays English. */
function fieldErrors(details: unknown): FieldError[] {
  if (!Array.isArray(details)) return [];
  const out: FieldError[] = [];
  for (const e of details) {
    if (!e || typeof e !== "object") continue;
    const loc = Array.isArray((e as { loc?: unknown }).loc) ? ((e as { loc: unknown[] }).loc as unknown[]) : [];
    const path = loc.filter((x, i) => !(i === 0 && (x === "body" || x === "query" || x === "path"))).map(String);
    let message = String((e as { msg?: unknown }).msg ?? "");
    message = message.replace(/^Value error, /, "").replace(/^Assertion failed, /, "");
    out.push({ field: path.join("."), message });
  }
  return out;
}

const FIELD_LABEL: Record<string, MessageKey> = {
  email: "field.email",
  password: "field.password",
  new_password: "field.newPassword",
  current_password: "field.currentPassword",
  display_name: "field.displayName",
  title: "field.title",
  company: "field.company",
  role: "field.role",
  location: "field.location",
  url: "field.url",
  notes: "field.notes",
  description: "field.description",
  text: "field.text",
  code: "field.code",
  name: "field.name",
  summary: "field.summary",
  experience: "field.experience",
  education: "field.education",
  projects: "field.projects",
  degree: "field.degree",
  field_of_study: "field.fieldOfStudy",
  institution: "field.institution",
  organization: "field.organization",
};

function humanize(name: string): string {
  const key = FIELD_LABEL[name];
  if (key) return translateNow(key);
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Human label for a field path: "email" -> "Email", "content.education.0.degree" -> "Education 1 › Degree". */
export function fieldLabel(path: string): string {
  const parts = path.split(".").filter((p) => p && p !== "content");
  if (!parts.length) return translateNow("field.request");
  const out: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length) out[out.length - 1] += ` ${Number(p) + 1}`;
    else if (!/^\d+$/.test(p)) out.push(humanize(p));
  }
  return out.slice(-2).join(" › ");
}

/** "Email — value is not a valid email address; Password — String should have at least 10 characters" */
export function describeFieldErrors(fields: FieldError[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const f of fields) {
    const s = `${fieldLabel(f.field)} — ${f.message}`;
    if (seen.has(s)) continue;
    seen.add(s);
    parts.push(s);
  }
  return parts.join("; ");
}

export function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_PAGES = ["/login", "/register", "/verify-email", "/forgot-password", "/reset-password"];

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  if (path === "/" || AUTH_PAGES.some((p) => path.startsWith(p))) return;
  window.location.href = `/login?next=${encodeURIComponent(path + window.location.search)}`;
}

export async function parseError(res: Response): Promise<ApiError> {
  let code = "http_" + res.status;
  let message = res.statusText || translateNow("common.requestFailed");
  let details: unknown;
  try {
    const body = await res.json();
    const d = body?.detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      code = d.code ?? code;
      message = d.message ?? message;
      details = d.errors;
    } else if (typeof d === "string") {
      message = d;
    }
  } catch {
    /* non-JSON error */
  }
  if (res.status >= 500 && code.startsWith("http_")) message = translateNow("common.serverError");
  // two requests changed the same thing at once (unique-constraint race): ask for a reload, not a retry loop
  if (res.status === 409 && code === "conflict") message = translateNow("common.conflict");
  const err = new ApiError(res.status, code, message, details);
  if (err.fields.length) err.message = translateNow("common.checkFields", { fields: describeFieldErrors(err.fields) });
  return err;
}

/** Staff endpoints answer 403 `mfa_required` until two-factor login is on. The app shell listens for
    this event and swaps the page for a friendly "turn on 2FA" prompt instead of an error. */
export const MFA_REQUIRED_EVENT = "ri:mfa-required";
export function announceMfaRequired(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MFA_REQUIRED_EVENT, { detail: message }));
}

type Opts = { method?: string; body?: unknown; form?: FormData; noRedirect?: boolean; signal?: AbortSignal };

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (UNSAFE.has(method)) {
    const tok = getCookie("ri_csrf");
    if (tok) headers["x-csrf-token"] = tok;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "include",
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(0, "network_error", translateNow("common.networkError"));
  }
  if (res.status === 401 && !opts.noRedirect) {
    redirectToLogin();
  }
  if (!res.ok) {
    const e = await parseError(res);
    if (e.status === 403 && e.code === "mfa_required") announceMfaRequired(e.message);
    throw e;
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.blob()) as Promise<T>;
}

/** Multipart upload with progress events (fetch has no upload progress). */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    const tok = getCookie("ri_csrf");
    if (tok) xhr.setRequestHeader("x-csrf-token", tok);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", translateNow("common.uploadNetworkError")));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
      if (xhr.status === 401) redirectToLogin();
      const d = (body as { detail?: { code?: string; message?: string; errors?: unknown } } | null)?.detail;
      if (xhr.status === 403 && d?.code === "mfa_required") announceMfaRequired(d.message ?? "");
      const err = new ApiError(xhr.status, d?.code ?? `http_${xhr.status}`, d?.message ?? translateNow("common.uploadFailed"), d?.errors);
      if (err.fields.length) err.message = translateNow("common.checkFields", { fields: describeFieldErrors(err.fields) });
      reject(err);
    };
    xhr.send(form);
  });
}

/** Download via a short-lived signed link. */
export async function downloadSigned(linkEndpoint: string) {
  const { url } = await api<{ url: string }>(linkEndpoint);
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return translateNow("common.genericError");
}
