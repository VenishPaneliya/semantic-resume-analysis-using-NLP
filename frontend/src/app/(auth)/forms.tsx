"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Field, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useT } from "@/lib/i18n";

function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { pending, error, setError, setPending };
}

// After Google sign-in the server keeps the second-step token in a short-lived HttpOnly cookie
// (never in the URL) and sends the browser to /login?mfa=google.
const MFA_TOKEN_IN_COOKIE = "cookie";

function safeNext(n: string | null) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard";
}

export function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const s = useSubmit();
  const [google, setGoogle] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(params.get("mfa") === "google" ? MFA_TOKEN_IN_COOKIE : null);
  useEffect(() => {
    api<{ google: boolean }>("/api/auth/providers", { noRedirect: true }).then((p) => setGoogle(p.google)).catch(() => {});
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    s.setPending(true);
    s.setError(null);
    try {
      const r = await api<{ mfa_required?: boolean; mfa_token?: string }>("/api/auth/login", { body: { email: f.get("email"), password: f.get("password") }, noRedirect: true });
      if (r?.mfa_required && r.mfa_token) {
        setMfaToken(r.mfa_token);
        s.setPending(false);
        return;
      }
      router.push(safeNext(params.get("next")));
    } catch (err) {
      s.setError(errMsg(err));
      s.setPending(false);
    }
  }

  if (mfaToken)
    return (
      <MfaStep
        token={mfaToken}
        onSuccess={() => router.push(safeNext(params.get("next")))}
        onRestart={() => {
          setMfaToken(null);
          if (params.get("mfa")) router.replace("/login");
        }}
      />
    );
  return (
    <>
      <h1 className="text-2xl">{t("common.signIn")}</h1>
      <p className="mt-1 text-sm text-ink-2">{t("auth.login.welcome")}</p>
      <form className="mt-6 space-y-4" onSubmit={submit} noValidate={false}>
        {s.error && <Alert tone="bad">{s.error}</Alert>}
        <Field label={t("auth.email")} id="email">
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label={t("auth.password")} id="password">
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
          {s.pending ? <Spinner label={t("auth.login.signingIn")} /> : t("common.signIn")}
        </button>
      </form>
      {google && (
        <a href="/api/auth/google/login" className="btn btn-secondary mt-3 w-full justify-center">
          {t("auth.login.google")}
        </a>
      )}
      <div className="mt-6 flex flex-wrap justify-between gap-2 text-sm">
        <Link href="/forgot-password" className="text-teal underline-offset-2 hover:underline">
          {t("auth.login.forgot")}
        </Link>
        <Link href="/register" className="text-teal underline-offset-2 hover:underline">
          {t("auth.login.create")}
        </Link>
      </div>
    </>
  );
}

function MfaStep({ token, onSuccess, onRestart }: { token: string; onSuccess: () => void; onRestart: () => void }) {
  const t = useT();
  const s = useSubmit();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [expired, setExpired] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    s.setPending(true);
    s.setError(null);
    try {
      const r = await api<{ recovery_codes_left?: number }>("/api/auth/login/mfa", { body: token === MFA_TOKEN_IN_COOKIE ? { code } : { mfa_token: token, code }, noRedirect: true });
      if (typeof r?.recovery_codes_left === "number") {
        setLeft(r.recovery_codes_left);
        s.setPending(false);
        return;
      }
      onSuccess();
    } catch (err) {
      s.setError(errMsg(err));
      setExpired((err as { code?: string }).code === "invalid_token");
      s.setPending(false);
    }
  }

  if (left !== null)
    return (
      <>
        <h1 className="text-2xl">{t("auth.mfa.recoveryUsedTitle")}</h1>
        <div className="mt-6 space-y-4">
          <Alert tone={left <= 3 ? "warn" : "info"} title={t("auth.mfa.codesLeft", { count: left })}>
            {t("auth.mfa.recoveryUsedBody")}
          </Alert>
          <button className="btn btn-primary w-full justify-center" onClick={onSuccess}>
            {t("common.continue")}
          </button>
        </div>
      </>
    );

  return (
    <>
      <h1 className="text-2xl">{t("auth.mfa.title")}</h1>
      <p className="mt-1 text-sm text-ink-2">
        {recovery ? t("auth.mfa.recoveryIntro") : t("auth.mfa.totpIntro")}
      </p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        {s.error && (
          <Alert tone="bad" action={expired ? <button type="button" className="btn btn-secondary btn-sm" onClick={onRestart}>{t("auth.mfa.startAgain")}</button> : undefined}>
            {s.error}
          </Alert>
        )}
        <Field label={recovery ? t("auth.mfa.recoveryCode") : t("auth.mfa.authCode")} id="mfa-code">
          <input
            key={recovery ? "rc" : "totp"}
            className="input font-mono tracking-widest"
            id="mfa-code"
            name="code"
            autoComplete="one-time-code"
            inputMode={recovery ? "text" : "numeric"}
            maxLength={recovery ? 32 : 6}
            value={code}
            onChange={(e) => setCode(recovery ? e.target.value.trim() : e.target.value.replace(/\D/g, ""))}
            autoFocus
            required
          />
        </Field>
        <button className="btn btn-primary w-full justify-center" disabled={s.pending || (recovery ? code.length < 6 : code.length !== 6)}>
          {s.pending ? <Spinner label={t("auth.mfa.checking")} /> : t("auth.mfa.verify")}
        </button>
      </form>
      <div className="mt-6 flex flex-wrap justify-between gap-2 text-sm">
        <button
          type="button"
          className="text-teal underline-offset-2 hover:underline"
          onClick={() => {
            setRecovery((r) => !r);
            setCode("");
            s.setError(null);
          }}
        >
          {recovery ? t("auth.mfa.useApp") : t("auth.mfa.useRecovery")}
        </button>
        <button type="button" className="text-ink-2 underline-offset-2 hover:underline" onClick={onRestart}>
          {t("auth.backToSignIn")}
        </button>
      </div>
    </>
  );
}

export function RegisterForm() {
  const t = useT();
  const s = useSubmit();
  // the address the link went to; the API answers the same for new and already-registered addresses
  const [sent, setSent] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) {
      s.setError(t("auth.passwordsMismatch"));
      return;
    }
    s.setPending(true);
    s.setError(null);
    try {
      // same answer for new and already-registered addresses; no session until the user signs in
      await api<{ status?: string; message?: string }>("/api/auth/register", {
        body: { email: f.get("email"), password: f.get("password"), display_name: f.get("name") || null },
        noRedirect: true,
      });
      // shown in our own translated words rather than the API's English message
      setSent(String(f.get("email") ?? ""));
      s.setPending(false);
    } catch (err) {
      s.setError(errMsg(err));
      s.setPending(false);
    }
  }
  if (sent !== null)
    return (
      <div data-testid="register-sent">
        <h1 className="text-2xl">{t("auth.register.sentTitle")}</h1>
        <div className="mt-6 space-y-4" aria-live="polite">
          <Alert tone="info" title={t("auth.register.sentLead", { email: sent })}>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              <li>{t("auth.register.sentStep1")}</li>
              <li>{t("auth.register.sentStep2")}</li>
            </ol>
          </Alert>
          <p className="text-sm text-ink-2">{t("auth.register.sentExisting")}</p>
          <Link href="/login" className="btn btn-primary w-full justify-center">
            {t("common.signIn")}
          </Link>
          <p className="text-xs text-muted">
            {t.rich("auth.register.sentHelp", {
              forgot: (c) => (
                <Link href="/forgot-password" className="text-teal underline">
                  {c}
                </Link>
              ),
            })}
          </p>
        </div>
      </div>
    );
  return (
    <>
      <h1 className="text-2xl">{t("auth.register.title")}</h1>
      <p className="mt-1 text-sm text-ink-2">{t("auth.register.intro")}</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        {s.error && <Alert tone="bad">{s.error}</Alert>}
        <Field label={t("auth.register.name")} id="name">
          <input className="input" id="name" name="name" autoComplete="name" maxLength={120} />
        </Field>
        <Field label={t("auth.email")} id="email">
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label={t("auth.password")} id="password" hint={t("auth.passwordHint")}>
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Field label={t("auth.confirmPassword")} id="confirm">
          <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        <p className="text-xs text-muted">{t("auth.register.privacy")}</p>
        <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
          {s.pending ? <Spinner label={t("auth.register.creating")} /> : t("common.createAccount")}
        </button>
      </form>
      <p className="mt-6 text-sm">
        {t("auth.register.already")}{" "}
        <Link href="/login" className="text-teal hover:underline">
          {t("common.signIn")}
        </Link>
      </p>
    </>
  );
}

export function VerifyEmail() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"working" | "ok" | "error">(token ? "working" : "error");
  const [msg, setMsg] = useState(token ? "" : t("auth.verify.missingToken"));
  const done = useRef(false);
  useEffect(() => {
    if (!token || done.current) return;
    done.current = true;
    api("/api/auth/verify-email", { body: { token }, noRedirect: true })
      .then(() => setState("ok"))
      .catch((e) => {
        setState("error");
        setMsg(errMsg(e));
      });
  }, [token]);
  return (
    <>
      <h1 className="text-2xl">{t("auth.verify.title")}</h1>
      <div className="mt-6" aria-live="polite">
        {state === "working" && <Spinner label={t("auth.verify.working")} />}
        {state === "ok" && (
          <Alert tone="ok" title={t("auth.verify.okTitle")}>
            {t.rich("auth.verify.okBody", { link: (c) => <Link href="/login?next=/dashboard">{c}</Link> })}
          </Alert>
        )}
        {state === "error" && (
          <Alert tone="bad" title={t("auth.verify.errorTitle")}>
            {msg} {t("auth.verify.errorHint")}
          </Alert>
        )}
      </div>
    </>
  );
}

export function ForgotForm() {
  const t = useT();
  const s = useSubmit();
  const [sent, setSent] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    s.setPending(true);
    s.setError(null);
    try {
      await api<{ status: string }>("/api/auth/forgot-password", { body: { email: f.get("email") }, noRedirect: true });
      setSent(t("auth.forgot.sent"));
    } catch (err) {
      s.setError(errMsg(err));
    } finally {
      s.setPending(false);
    }
  }
  return (
    <>
      <h1 className="text-2xl">{t("auth.forgot.title")}</h1>
      <p className="mt-1 text-sm text-ink-2">{t("auth.forgot.intro")}</p>
      {sent ? (
        <div className="mt-6">
          <Alert tone="ok">{sent}</Alert>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit}>
          {s.error && <Alert tone="bad">{s.error}</Alert>}
          <Field label={t("auth.email")} id="email">
            <input className="input" id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
            {s.pending ? <Spinner label={t("auth.forgot.sending")} /> : t("auth.forgot.send")}
          </button>
        </form>
      )}
      <p className="mt-6 text-sm">
        <Link href="/login" className="text-teal hover:underline">
          {t("auth.backToSignIn")}
        </Link>
      </p>
    </>
  );
}

export function ResetForm() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const s = useSubmit();
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) {
      s.setError(t("auth.passwordsMismatch"));
      return;
    }
    s.setPending(true);
    s.setError(null);
    try {
      await api("/api/auth/reset-password", { body: { token, password: f.get("password") }, noRedirect: true });
      setDone(true);
    } catch (err) {
      s.setError(errMsg(err));
    } finally {
      s.setPending(false);
    }
  }
  if (!token) return <Alert tone="bad" title={t("auth.reset.invalidTitle")}>{t("auth.reset.invalidBody")}</Alert>;
  return (
    <>
      <h1 className="text-2xl">{t("auth.reset.title")}</h1>
      {done ? (
        <div className="mt-6">
          <Alert tone="ok" title={t("auth.reset.doneTitle")}>
            {t.rich("auth.reset.doneBody", { link: (c) => <Link href="/login">{c}</Link> })}
          </Alert>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit}>
          {s.error && <Alert tone="bad">{s.error}</Alert>}
          <Field label={t("auth.newPassword")} id="password" hint={t("auth.passwordHint")}>
            <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label={t("auth.confirmPassword")} id="confirm">
            <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          </Field>
          <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
            {s.pending ? <Spinner label={t("common.saving")} /> : t("auth.reset.submit")}
          </button>
        </form>
      )}
    </>
  );
}
