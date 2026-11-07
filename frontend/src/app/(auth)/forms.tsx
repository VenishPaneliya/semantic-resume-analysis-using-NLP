"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Field, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";

function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { pending, error, setError, setPending };
}

function safeNext(n: string | null) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard";
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const s = useSubmit();
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    api<{ google: boolean }>("/api/auth/providers", { noRedirect: true }).then((p) => setGoogle(p.google)).catch(() => {});
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    s.setPending(true);
    s.setError(null);
    try {
      await api("/api/auth/login", { body: { email: f.get("email"), password: f.get("password") }, noRedirect: true });
      router.push(safeNext(params.get("next")));
    } catch (err) {
      s.setError(errMsg(err));
      s.setPending(false);
    }
  }
  return (
    <>
      <h1 className="text-2xl">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">Welcome back.</p>
      <form className="mt-6 space-y-4" onSubmit={submit} noValidate={false}>
        {s.error && <Alert tone="bad">{s.error}</Alert>}
        <Field label="Email" id="email">
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" id="password">
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
          {s.pending ? <Spinner label="Signing in" /> : "Sign in"}
        </button>
      </form>
      {google && (
        <a href="/api/auth/google/login" className="btn btn-secondary mt-3 w-full justify-center">
          Continue with Google
        </a>
      )}
      <div className="mt-6 flex justify-between text-sm">
        <Link href="/forgot-password" className="text-teal underline-offset-2 hover:underline">
          Forgot password?
        </Link>
        <Link href="/register" className="text-teal underline-offset-2 hover:underline">
          Create an account
        </Link>
      </div>
    </>
  );
}

export function RegisterForm() {
  const router = useRouter();
  const s = useSubmit();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) {
      s.setError("Passwords do not match.");
      return;
    }
    s.setPending(true);
    s.setError(null);
    try {
      await api("/api/auth/register", {
        body: { email: f.get("email"), password: f.get("password"), display_name: f.get("name") || null },
        noRedirect: true,
      });
      router.push("/dashboard?welcome=1");
    } catch (err) {
      s.setError(errMsg(err));
      s.setPending(false);
    }
  }
  return (
    <>
      <h1 className="text-2xl">Create your account</h1>
      <p className="mt-1 text-sm text-ink-2">We will email you a link to verify your address.</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        {s.error && <Alert tone="bad">{s.error}</Alert>}
        <Field label="Name (optional)" id="name">
          <input className="input" id="name" name="name" autoComplete="name" maxLength={120} />
        </Field>
        <Field label="Email" id="email">
          <input className="input" id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" id="password" hint="At least 10 characters, with letters and a number or symbol.">
          <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Field label="Confirm password" id="confirm">
          <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        <p className="text-xs text-muted">
          Your resume is stored encrypted and is not used to train models. You can export or delete everything from Settings.
        </p>
        <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
          {s.pending ? <Spinner label="Creating account" /> : "Create account"}
        </button>
      </form>
      <p className="mt-6 text-sm">
        Already registered?{" "}
        <Link href="/login" className="text-teal hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}

export function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"working" | "ok" | "error">(token ? "working" : "error");
  const [msg, setMsg] = useState(token ? "" : "This link is missing its token.");
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
      <h1 className="text-2xl">Email verification</h1>
      <div className="mt-6" aria-live="polite">
        {state === "working" && <Spinner label="Verifying your email…" />}
        {state === "ok" && (
          <Alert tone="ok" title="Email verified">
            You can now upload and analyse resumes. <Link href="/dashboard">Go to your dashboard</Link>.
          </Alert>
        )}
        {state === "error" && (
          <Alert tone="bad" title="Could not verify">
            {msg} Sign in and use “Resend link” to get a new one.
          </Alert>
        )}
      </div>
    </>
  );
}

export function ForgotForm() {
  const s = useSubmit();
  const [sent, setSent] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    s.setPending(true);
    s.setError(null);
    try {
      const r = await api<{ status: string }>("/api/auth/forgot-password", { body: { email: f.get("email") }, noRedirect: true });
      setSent(r.status);
    } catch (err) {
      s.setError(errMsg(err));
    } finally {
      s.setPending(false);
    }
  }
  return (
    <>
      <h1 className="text-2xl">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-2">Enter your email and we will send a reset link.</p>
      {sent ? (
        <div className="mt-6">
          <Alert tone="ok">{sent}</Alert>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit}>
          {s.error && <Alert tone="bad">{s.error}</Alert>}
          <Field label="Email" id="email">
            <input className="input" id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
            {s.pending ? <Spinner label="Sending" /> : "Send reset link"}
          </button>
        </form>
      )}
      <p className="mt-6 text-sm">
        <Link href="/login" className="text-teal hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}

export function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const s = useSubmit();
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) {
      s.setError("Passwords do not match.");
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
  if (!token) return <Alert tone="bad" title="Invalid link">This reset link is missing its token.</Alert>;
  return (
    <>
      <h1 className="text-2xl">Choose a new password</h1>
      {done ? (
        <div className="mt-6">
          <Alert tone="ok" title="Password updated">
            All other sessions were signed out. <Link href="/login">Sign in</Link>.
          </Alert>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit}>
          {s.error && <Alert tone="bad">{s.error}</Alert>}
          <Field label="New password" id="password" hint="At least 10 characters, with letters and a number or symbol.">
            <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <Field label="Confirm password" id="confirm">
            <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          </Field>
          <button className="btn btn-primary w-full justify-center" disabled={s.pending}>
            {s.pending ? <Spinner label="Saving" /> : "Update password"}
          </button>
        </form>
      )}
    </>
  );
}
