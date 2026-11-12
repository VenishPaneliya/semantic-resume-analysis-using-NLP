"use client";

import { BellRing, Check, Copy, Download, KeyRound, RefreshCw, ShieldCheck, ShieldOff, Trash2, UserRound } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { useUser } from "./shell";
import { Alert, Badge, ErrorState, Field, fmtDate, LoadingBlock, Section, Spinner } from "./ui";
import { ageBandLabel, genderLabel, resumeTitle } from "@/lib/labels";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { MfaSetup, MfaStatus, Resume, SelfId, User } from "@/lib/types";

// ---------------------------------------------------------------- two-factor authentication

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  function download() {
    const blob = new Blob([`${t("account.recoveryFileHeader")}\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "resume-intelligence-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <Alert tone="warn" title={t("account.saveCodesTitle")}>
        {t("account.saveCodesBody")}
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-md border border-line bg-paper p-3 font-mono text-sm" aria-label={t("account.recoveryCodes")}>
        {codes.map((c) => (
          <li key={c} className="break-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check className="h-4 w-4 text-ok" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copied ? t("common.copied") : t("common.copy")}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>
          <Download className="h-4 w-4" aria-hidden /> {t("account.downloadTxt")}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onDone}>
          {t("account.savedThem")}
        </button>
      </div>
    </div>
  );
}

function CodeInput({ id, label, value, onChange, allowRecovery = false }: { id: string; label?: string; value: string; onChange: (v: string) => void; allowRecovery?: boolean }) {
  const t = useT();
  return (
    <Field label={label ?? t("account.sixDigit")} id={id}>
      <input
        id={id}
        className="input max-w-48 font-mono tracking-widest"
        inputMode={allowRecovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        maxLength={allowRecovery ? 32 : 6}
        value={value}
        onChange={(e) => onChange(allowRecovery ? e.target.value.trim() : e.target.value.replace(/\D/g, ""))}
        required
      />
    </Field>
  );
}

export function TwoFactorCard() {
  const t = useT();
  const { user, refreshUser } = useUser();
  const status = useApi<MfaStatus>("/api/account/2fa");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"idle" | "disable" | "regen">("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // turning 2FA on/off or replacing recovery codes signs out every other session of the account
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    if (!setup) return setQr(null);
    QRCode.toDataURL(setup.otpauth_uri, { margin: 1, width: 184, errorCorrectionLevel: "M" })
      .then(setQr)
      .catch(() => setQr(null));
  }, [setup]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setSignedOut(false);
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => {
    setSetup(await api<MfaSetup>("/api/account/2fa/setup", { method: "POST" }));
    setCode("");
  });
  const enable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ recovery_codes: string[]; other_sessions_signed_out?: boolean }>("/api/account/2fa/enable", { body: { code } });
      setCodes(r.recovery_codes);
      setSignedOut(!!r.other_sessions_signed_out);
      setSetup(null);
      setCode("");
      await status.reload();
      await refreshUser();
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ other_sessions_signed_out?: boolean }>("/api/account/2fa/disable", { body: { password: user.has_password ? pw : null, code } });
      setSignedOut(!!r?.other_sessions_signed_out);
      setMode("idle");
      setCode("");
      setPw("");
      setMsg(t("account.twoFactorOff"));
      await status.reload();
      await refreshUser();
    });
  };
  const regen = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ recovery_codes: string[]; other_sessions_signed_out?: boolean }>("/api/account/2fa/recovery-codes", { body: { code } });
      setCodes(r.recovery_codes);
      setSignedOut(!!r.other_sessions_signed_out);
      setMode("idle");
      setCode("");
      await status.reload();
    });
  };

  const s = status.data;
  return (
    <Section title={t("account.twoFactor")} id="security" aside={<KeyRound className="h-5 w-5 text-teal" aria-hidden />}>
      {status.loading && !s ? (
        <LoadingBlock />
      ) : status.error || !s ? (
        <ErrorState message={status.error ?? t("account.couldNotLoad")} onRetry={status.reload} />
      ) : codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : s.enabled ? (
        <div className="space-y-3 text-sm" data-testid="mfa-on">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {t("account.on")}
            </Badge>
            <span className="text-ink-2">
              {t("account.since", { date: fmtDate(s.enabled_at) })} · {t("account.codesLeft", { count: s.recovery_codes_left })}
            </span>
          </p>
          <p className="text-ink-2">{t("account.onHelp")}</p>
          {msg && <Alert tone="ok">{msg}</Alert>}
          {mode === "idle" && (
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-secondary btn-sm" onClick={() => setMode("regen")}>
                <RefreshCw className="h-4 w-4" aria-hidden /> {t("account.newCodes")}
              </button>
              <button className="btn btn-ghost btn-sm text-bad" onClick={() => setMode("disable")}>
                <ShieldOff className="h-4 w-4" aria-hidden /> {t("account.turnOff")}
              </button>
            </div>
          )}
          {mode === "regen" && (
            <form className="space-y-3 rounded-md border border-line p-3" onSubmit={regen}>
              <p className="text-ink-2">{t("account.regenHelp")}</p>
              <CodeInput id="regen-code" value={code} onChange={setCode} />
              <div className="flex gap-2">
                <button className="btn btn-primary btn-sm" disabled={busy || code.length < 6}>
                  {busy ? <Spinner label={t("account.working")} /> : t("account.makeCodes")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("idle")}>
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          )}
          {mode === "disable" && (
            <form className="space-y-3 rounded-md border border-[#e9b7af] bg-bad-soft p-3" onSubmit={disable}>
              {user.mfa_required_for_role && (
                <Alert tone="warn">{t("account.staffWarn")}</Alert>
              )}
              {user.has_password && (
                <Field label={t("account.password")} id="mfa-off-pw">
                  <input id="mfa-off-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
                </Field>
              )}
              <CodeInput id="mfa-off-code" label={t("account.authOrRecovery")} value={code} onChange={setCode} allowRecovery />
              <div className="flex gap-2">
                <button className="btn btn-danger btn-sm" disabled={busy || code.length < 6}>
                  {busy ? <Spinner label={t("account.working")} /> : t("account.turnOffTwoFactor")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("idle")}>
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : setup ? (
        <form className="space-y-4 text-sm" onSubmit={enable} data-testid="mfa-setup">
          <p className="text-ink-2">{setup.instructions}</p>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex h-[196px] w-[196px] shrink-0 items-center justify-center rounded-md border border-line bg-white p-1.5">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} width={184} height={184} alt={t("account.qrAlt")} />
              ) : (
                <Spinner label={t("account.drawingQr")} />
              )}
            </div>
            <div className="min-w-0">
              <p className="label">{t("account.cantScan")}</p>
              <code className="block break-all rounded border border-line bg-paper px-2 py-1.5 font-mono text-sm tracking-wider" data-testid="mfa-secret">
                {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
              <p className="mt-1 text-xs text-muted">{t("account.totpInfo")}</p>
            </div>
          </div>
          <CodeInput id="mfa-code" label={t("account.codeFromApp")} value={code} onChange={setCode} />
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" disabled={busy || code.length !== 6}>
              {busy ? <Spinner label={t("account.checking")} /> : t("account.turnOn")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSetup(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2">
            <Badge tone="neutral" className="shrink-0">{t("account.off")}</Badge>
            <span className="text-ink-2">{t("account.offHelp")}</span>
          </p>
          {user.mfa_required_for_role && (
            <Alert tone="warn" title={t("account.requiredStaff")}>
              {t("account.requiredStaffBody")}
            </Alert>
          )}
          {msg && <Alert tone="ok">{msg}</Alert>}
          <button className="btn btn-primary btn-sm" onClick={start} disabled={busy}>
            {busy ? <Spinner label={t("account.starting")} /> : (<><KeyRound className="h-4 w-4" aria-hidden /> {t("account.setUp")}</>)}
          </button>
        </div>
      )}
      {signedOut && (
        <div className="mt-3" data-testid="other-sessions-signed-out">
          <Alert tone="info">{t("account.otherSessionsOut")}</Alert>
        </div>
      )}
      {err && (
        <div className="mt-3">
          <Alert tone="bad">{err}</Alert>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- voluntary self-identification

export function SelfIdCard() {
  const t = useT();
  const q = useApi<SelfId>("/api/account/self-id");
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setGender(q.data.value?.gender ?? "");
    setAge(q.data.value?.age_band ?? "");
    setConsent(false);
  }, [q.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    if (!consent) return setErr(t("account.selfIdConsentError"));
    setBusy("save");
    try {
      q.setData(await api<SelfId>("/api/account/self-id", { method: "PUT", body: { gender: gender || null, age_band: age || null, consent } }));
      setMsg(t("account.selfIdSaved"));
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(null);
    }
  }
  async function del() {
    setBusy("delete");
    setErr(null);
    setMsg(null);
    try {
      await api("/api/account/self-id", { method: "DELETE" });
      await q.reload();
      setMsg(t("account.selfIdDeleted"));
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-5 sm:p-6 lg:col-span-2" aria-labelledby="selfid-h" data-testid="self-id">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="selfid-h" className="flex items-center gap-2 text-xl">
          <UserRound className="h-5 w-5 shrink-0 text-teal" aria-hidden /> {t("account.selfIdTitle")}
        </h2>
        <span className="flex flex-wrap gap-1.5">
          <Badge tone="neutral">{t("account.optional")}</Badge>
          <Badge tone="teal">{t("account.neverAffects")}</Badge>
        </span>
      </div>
      {q.loading && !q.data ? (
        <LoadingBlock />
      ) : q.error || !q.data ? (
        <ErrorState message={q.error ?? t("account.couldNotLoad")} onRetry={q.reload} />
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3">
            <Alert tone="info" title={t("account.whyAsk")}>
              {q.data.notice}
            </Alert>
            <p className="text-sm text-ink-2">
              {t("account.skipHelp")}
            </p>
            {q.data.value && (
              <p className="text-sm text-ink-2">
                {t.rich("account.sharedOn", { b: (c) => <strong>{c}</strong> }, { date: fmtDate(q.data.value.consented_at) })}
              </p>
            )}
          </div>
          <form className="space-y-3" onSubmit={save}>
            <Field label={t("account.genderField")} id="sid-gender">
              <select id="sid-gender" className="input" value={gender} onChange={(e) => setGender(e.target.value)}>
                <option value="">{t("account.skipQuestion")}</option>
                {q.data.options.gender.map((g) => (
                  <option key={g} value={g}>
                    {genderLabel(t, g)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("account.ageField")} id="sid-age">
              <select id="sid-age" className="input" value={age} onChange={(e) => setAge(e.target.value)}>
                <option value="">{t("account.skipQuestion")}</option>
                {q.data.options.age_band.map((g) => (
                  <option key={g} value={g}>
                    {ageBandLabel(t, g)}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-start gap-2 rounded-md border border-line bg-paper p-3 text-sm">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{t("account.selfIdConsent")}</span>
            </label>
            {err && <Alert tone="bad">{err}</Alert>}
            {msg && <Alert tone="ok">{msg}</Alert>}
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary btn-sm" disabled={busy !== null}>
                {busy === "save" ? <Spinner label={t("account.saving")} /> : q.data.value ? t("account.updateAnswers") : t("account.saveAnswers")}
              </button>
              {q.data.value && (
                <button type="button" className="btn btn-secondary btn-sm text-bad" onClick={del} disabled={busy !== null}>
                  {busy === "delete" ? <Spinner label={t("account.deleting")} /> : (<><Trash2 className="h-4 w-4" aria-hidden /> {t("account.deleteAnswers")}</>)}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- job alerts

export function JobAlertsCard() {
  const t = useT();
  const { user, setUser } = useUser();
  const p = user.notification_prefs ?? {};
  const resumes = useApi<Resume[]>(user.email_verified ? "/api/resumes" : null);
  const [enabled, setEnabled] = useState(!!p.job_alerts);
  const [minScore, setMinScore] = useState<number>(typeof p.job_alert_min_score === "number" ? p.job_alert_min_score : 60);
  const [resumeId, setResumeId] = useState<string>(typeof p.job_alert_resume_id === "string" ? p.job_alert_resume_id : "");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setOk(false);
    setErr(null);
    try {
      setUser(await api<User>("/api/account/settings", { method: "PATCH", body: { job_alerts: { enabled, min_score: minScore, resume_id: resumeId || null } } }));
      setOk(true);
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={t("account.jobAlerts")} id="alerts" aside={<BellRing className="h-5 w-5 text-teal" aria-hidden />}>
      <form className="space-y-4" onSubmit={save} data-testid="job-alerts">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            {t("account.alertsOptIn")}
            <span className="block text-xs text-muted">{t("account.alertsHelp")}</span>
          </span>
        </label>
        <fieldset disabled={!enabled} className="space-y-4 disabled:opacity-60">
          <div>
            <label htmlFor="ja-min" className="label flex items-center justify-between gap-2">
              <span>{t("account.minScore")}</span>
              <span className="num text-sm font-semibold text-ink">{minScore}</span>
            </label>
            <input id="ja-min" type="range" min={40} max={95} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-full accent-[#0f766e]" />
            <div className="flex justify-between text-[11px] text-muted">
              <span>{t("account.goodMatch")}</span>
              <span>{t("account.strong")}</span>
              <span>95</span>
            </div>
          </div>
          <Field label={t("account.alertResume")} id="ja-resume">
            <select id="ja-resume" className="input" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              <option value="">{t("account.recentResume")}</option>
              {resumes.data
                ?.filter((r) => r.latest_version_id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {resumeTitle(t, r)}
                  </option>
                ))}
            </select>
          </Field>
        </fieldset>
        <p className="text-xs text-muted">{t("account.alertsNote")}</p>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? <Spinner label={t("account.saving")} /> : t("account.saveAlerts")}
          </button>
          <span aria-live="polite" className="text-sm">
            {ok && <span className="text-ok">{t("account.saved")}</span>}
            {err && <span className="text-bad">{err}</span>}
          </span>
        </div>
      </form>
    </Section>
  );
}
