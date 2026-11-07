/* Typed same-origin API client. Session lives in an HTTP-only cookie; unsafe requests
   carry the double-submit CSRF token read from the non-HttpOnly `ri_csrf` cookie. */

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
  let message = res.statusText || "Request failed";
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
  if (res.status >= 500 && code.startsWith("http_")) message = "The server had a problem. Please try again.";
  return new ApiError(res.status, code, message, details);
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
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection and try again.");
  }
  if (res.status === 401 && !opts.noRedirect) {
    redirectToLogin();
  }
  if (!res.ok) throw await parseError(res);
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
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Upload failed: could not reach the server."));
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
      reject(new ApiError(xhr.status, d?.code ?? `http_${xhr.status}`, d?.message ?? "Upload failed."));
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
  return "Something went wrong.";
}
