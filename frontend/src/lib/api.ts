/* Typed same-origin API client. Session lives in an HTTP-only cookie; unsafe requests
   carry the double-submit CSRF token read from the non-HttpOnly `ri_csrf` cookie.
   Messages from the API stay in English; only the frontend's own fallback messages are translated. */

import { translateNow } from "./i18n";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
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
  return new ApiError(res.status, code, message, details);
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
      const d = (body as { detail?: { code?: string; message?: string } } | null)?.detail;
      if (xhr.status === 403 && d?.code === "mfa_required") announceMfaRequired(d.message ?? "");
      reject(new ApiError(xhr.status, d?.code ?? `http_${xhr.status}`, d?.message ?? translateNow("common.uploadFailed")));
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
