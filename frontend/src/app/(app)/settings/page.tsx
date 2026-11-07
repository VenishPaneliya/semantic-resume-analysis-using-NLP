"use client";

import { Download, LogOut, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useUser } from "@/components/shell";
import { Alert, Badge, ErrorState, Field, FixtureBadge, fmtDate, LoadingBlock, PageHeader, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Privacy, Role, User } from "@/lib/types";

export default function SettingsPage() {
  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Profile />
        <CareerPrefsCard />
        <PrivacyCard />
        <Notifications />
        <Usage />
        <Sessions />
        <PasswordCard />
        <DataCard />
      </div>
    </>
  );
}

function Saved({ ok, err }: { ok: boolean; err: string | null }) {
  return (
    <span aria-live="polite" className="text-sm">
      {ok && <span className="text-ok">Saved.</span>}
      {err && <span className="text-bad">{err}</span>}
    </span>
  );
}

function useSave() {
  const { setUser } = useUser();
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save(body: object) {
    setBusy(true);
    setOk(false);
    setErr(null);
    try {
      setUser(await api<User>("/api/account/settings", { method: "PATCH", body }));
      setOk(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, ok, err, save };
}

function Profile() {
  const { user } = useUser();
  const s = useSave();
  return (
    <Section title="Profile" id="profile">
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void s.save({ display_name: new FormData(e.currentTarget).get("display_name") });
        }}
      >
        <Field label="Email" id="email-ro">
          <input className="input bg-paper" id="email-ro" value={user.email} readOnly />
        </Field>
        <Field label="Display name" id="display_name">
          <input className="input" id="display_name" name="display_name" defaultValue={user.display_name ?? ""} maxLength={120} />
        </Field>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary btn-sm" disabled={s.busy}>Save</button>
          <Saved ok={s.ok} err={s.err} />
        </div>
      </form>
    </Section>
  );
}

function CareerPrefsCard() {
  const { user } = useUser();
  const roles = useApi<{ roles: Role[] }>("/api/taxonomy/roles");
  const s = useSave();
  const p = user.career_prefs;
  const [targets, setTargets] = useState<string[]>(p.target_roles ?? []);
  const [arr, setArr] = useState<string[]>(p.work_arrangements ?? []);
  return (
    <Section title="Career preferences" id="career">
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const list = (k: string) => String(f.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          void s.save({ career_prefs: { target_roles: targets, domains: list("domains"), locations: list("locations"), work_arrangements: arr } });
        }}
      >
        <fieldset>
          <legend className="label">Target roles</legend>
          <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
            {roles.data?.roles.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={targets.includes(r.id)} onChange={(e) => setTargets(e.target.checked ? [...targets, r.id] : targets.filter((x) => x !== r.id))} />
                {r.title}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Preferred domains (comma separated)" id="domains" hint="e.g. ai, data, web, infrastructure">
          <input className="input" id="domains" name="domains" defaultValue={(p.domains ?? []).join(", ")} />
        </Field>
        <Field label="Preferred locations (comma separated)" id="locations">
          <input className="input" id="locations" name="locations" defaultValue={(p.locations ?? []).join(", ")} />
        </Field>
        <fieldset>
          <legend className="label">Work arrangements</legend>
          <div className="flex gap-4">
            {["remote", "hybrid", "onsite"].map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm capitalize">
                <input type="checkbox" checked={arr.includes(a)} onChange={(e) => setArr(e.target.checked ? [...arr, a] : arr.filter((x) => x !== a))} />
                {a}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted">Preferences adjust ordering only. Personal attributes are never used for ranking.</p>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary btn-sm" disabled={s.busy}>Save preferences</button>
          <Saved ok={s.ok} err={s.err} />
        </div>
      </form>
    </Section>
  );
}

function PrivacyCard() {
  const { setUser } = useUser();
  const p = useApi<Privacy>("/api/account/privacy");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function set(accept: boolean) {
    if (!p.data) return;
    setBusy(true);
    setErr(null);
    try {
      setUser(await api<User>("/api/account/ai-consent", { body: { provider: p.data.ai_provider, accept } }));
      await p.reload();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="AI & privacy" id="privacy" aside={<ShieldCheck className="h-5 w-5 text-teal" aria-hidden />}>
      {p.loading && !p.data ? (
        <LoadingBlock />
      ) : p.error ? (
        <ErrorState message={p.error} onRetry={p.reload} />
      ) : p.data ? (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>AI provider:</span>
            <Badge tone="teal">{p.data.ai_provider}</Badge>
            <span className="num text-xs text-muted">{p.data.ai_model}</span>
            <FixtureBadge show={p.data.ai_provider === "fixture"} />
          </div>
          <p className="text-ink-2">
            <strong>What is sent:</strong> {p.data.what_is_sent}
          </p>
          <p className="text-ink-2">
            <strong>Training:</strong> {p.data.training_use}
          </p>
          <p className="text-ink-2">
            <strong>Retention:</strong> files {p.data.retention_days.files} days, analyses {p.data.retention_days.analyses} days.
          </p>
          {p.data.sends_data_externally ? (
            <div className="rounded-md border border-line bg-paper p-3">
              <p className="font-medium">
                {p.data.consented ? `You consented on ${fmtDate(p.data.consented_at)}.` : "AI features are off until you consent."}
              </p>
              <button className={`btn btn-sm mt-2 ${p.data.consented ? "btn-secondary" : "btn-primary"}`} disabled={busy} onClick={() => set(!p.data!.consented)}>
                {busy ? <Spinner label="" /> : p.data.consented ? "Withdraw consent" : `Allow sending redacted sections to ${p.data.ai_provider}`}
              </button>
            </div>
          ) : (
            <Alert tone="info">No resume data leaves this server with the current provider, so no consent is needed.</Alert>
          )}
          {err && <Alert tone="bad">{err}</Alert>}
        </div>
      ) : null}
    </Section>
  );
}

function Notifications() {
  const { user } = useUser();
  const s = useSave();
  const [prefs, setPrefs] = useState<Record<string, boolean>>(user.notification_prefs ?? {});
  const items = [
    ["processing_complete", "Email me when a document finishes processing"],
    ["weekly_digest", "Weekly summary of application follow-ups"],
    ["product_updates", "Occasional product updates"],
  ];
  return (
    <Section title="Notifications" id="notif">
      <fieldset className="space-y-2">
        <legend className="sr-only">Email notifications</legend>
        {items.map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!prefs[k]} onChange={(e) => setPrefs({ ...prefs, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="mt-3 flex items-center gap-3">
        <button className="btn btn-primary btn-sm" disabled={s.busy} onClick={() => s.save({ notification_prefs: prefs })}>Save</button>
        <Saved ok={s.ok} err={s.err} />
      </div>
    </Section>
  );
}

function Usage() {
  const u = useApi<{ ai_requests_this_month: number; estimated_cost_usd: number; limits: Record<string, number> }>("/api/account/usage");
  return (
    <Section title="Usage" id="usage">
      {u.error ? <ErrorState message={u.error} onRetry={u.reload} /> : !u.data ? <LoadingBlock /> : (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-muted">AI requests this month</dt><dd className="num text-xl">{u.data.ai_requests_this_month}</dd></div>
          <div><dt className="text-muted">Estimated AI cost</dt><dd className="num text-xl">${u.data.estimated_cost_usd.toFixed(4)}</dd></div>
          <div><dt className="text-muted">Daily AI limit</dt><dd className="num">{u.data.limits.ai_requests_per_day}</dd></div>
          <div><dt className="text-muted">Daily upload limit</dt><dd className="num">{u.data.limits.uploads_per_day}</dd></div>
        </dl>
      )}
    </Section>
  );
}

function Sessions() {
  const s = useApi<{ id: string; created_at: string; last_seen_at: string; user_agent: string | null; current: boolean }[]>("/api/account/sessions");
  return (
    <Section title="Active sessions" id="sessions">
      {s.error ? <ErrorState message={s.error} onRetry={s.reload} /> : !s.data ? <LoadingBlock /> : (
        <ul className="space-y-2">
          {s.data.map((x) => (
            <li key={x.id} className="flex items-center gap-2 rounded border border-line p-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">{x.user_agent || "Unknown device"}</p>
                <p className="text-xs text-muted">Last active {fmtDate(x.last_seen_at)}</p>
              </div>
              {x.current ? <Badge tone="teal">This device</Badge> : (
                <button className="btn btn-ghost btn-sm" onClick={async () => { await api(`/api/account/sessions/${x.id}`, { method: "DELETE" }); await s.reload(); }}>
                  <LogOut className="h-4 w-4" aria-hidden /> Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PasswordCard() {
  const { user } = useUser();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get("new_password") !== f.get("confirm")) return setMsg({ ok: false, text: "Passwords do not match." });
    setBusy(true);
    try {
      const r = await api<{ status: string }>("/api/account/password", { body: { current_password: f.get("current_password") || null, new_password: f.get("new_password") } });
      setMsg({ ok: true, text: r.status });
      form.reset();
    } catch (ex) {
      setMsg({ ok: false, text: errMsg(ex) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={user.has_password ? "Change password" : "Set a password"} id="pw">
      <form className="space-y-3" onSubmit={submit}>
        {user.has_password && (
          <Field label="Current password" id="current_password"><input className="input" type="password" id="current_password" name="current_password" autoComplete="current-password" required /></Field>
        )}
        <Field label="New password" id="new_password" hint="At least 10 characters, with letters and a number or symbol."><input className="input" type="password" id="new_password" name="new_password" autoComplete="new-password" minLength={10} required /></Field>
        <Field label="Confirm new password" id="confirm"><input className="input" type="password" id="confirm" name="confirm" autoComplete="new-password" required /></Field>
        {msg && <Alert tone={msg.ok ? "ok" : "bad"}>{msg.text}</Alert>}
        <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? <Spinner label="Saving" /> : "Update password"}</button>
      </form>
    </Section>
  );
}

function DataCard() {
  const { user } = useUser();
  const router = useRouter();
  const [busy, setBusy] = useState<"export" | "delete" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [pw, setPw] = useState("");

  async function exportData() {
    setBusy("export");
    setErr(null);
    try {
      const blob = await api<Blob>("/api/account/export");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-resume-intelligence-data.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  async function del() {
    if (!window.confirm("Permanently delete your account, every resume, version, analysis and stored file? This cannot be undone.")) return;
    setBusy("delete");
    setErr(null);
    try {
      await api("/api/account/delete", { body: { confirm_email: confirmText, password: pw || null } });
      router.push("/?deleted=1");
    } catch (e) {
      setErr(errMsg(e));
      setBusy(null);
    }
  }
  return (
    <section className="card p-5 sm:p-6 lg:col-span-2" aria-labelledby="data-h">
      <h2 id="data-h" className="text-xl">Your data</h2>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <p className="text-sm text-ink-2">Download everything linked to your account: records as JSON plus your original uploads.</p>
          <button className="btn btn-secondary mt-3" onClick={exportData} disabled={busy !== null}>
            {busy === "export" ? <Spinner label="Preparing" /> : (<><Download className="h-4 w-4" aria-hidden /> Export my data</>)}
          </button>
        </div>
        <div className="rounded-lg border border-[#e9b7af] bg-bad-soft p-4">
          <p className="font-semibold text-bad">Delete account</p>
          <p className="mt-1 text-sm text-ink-2">Removes stored files, versions, analyses, AI suggestions, job descriptions and applications. A content-free audit entry is kept.</p>
          <div className="mt-3 space-y-2">
            <Field label={`Type your email (${user.email}) to confirm`} id="del-email">
              <input className="input" id="del-email" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
            </Field>
            {user.has_password && (
              <Field label="Password" id="del-pw"><input className="input" type="password" id="del-pw" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
            )}
            <button className="btn btn-danger" disabled={busy !== null || confirmText.trim().toLowerCase() !== user.email} onClick={del}>
              {busy === "delete" ? <Spinner label="Deleting" /> : (<><Trash2 className="h-4 w-4" aria-hidden /> Delete everything</>)}
            </button>
          </div>
        </div>
      </div>
      {err && <div className="mt-4"><Alert tone="bad">{err}</Alert></div>}
    </section>
  );
}
