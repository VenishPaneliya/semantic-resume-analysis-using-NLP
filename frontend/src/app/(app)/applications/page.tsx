"use client";

import { Briefcase, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, Badge, Empty, ErrorState, Field, fmtDate, LoadingBlock, PageHeader, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { Application, Resume, Version } from "@/lib/types";

const STATUSES: Application["status"][] = ["saved", "applied", "interviewing", "offer", "rejected", "withdrawn"];
const TONE = { saved: "neutral", applied: "info", interviewing: "teal", offer: "ok", rejected: "bad", withdrawn: "neutral" } as const;
const STATUS_LABEL: Record<string, MessageKey> = {
  all: "apps.status.all",
  saved: "apps.status.saved",
  applied: "apps.status.applied",
  interviewing: "apps.status.interviewing",
  offer: "apps.status.offer",
  rejected: "apps.status.rejected",
  withdrawn: "apps.status.withdrawn",
};

type VersionOpt = { id: string; label: string };

export default function ApplicationsPage() {
  const t = useT();
  const apps = useApi<Application[]>("/api/applications");
  const resumes = useApi<Resume[]>("/api/resumes");
  const [versions, setVersions] = useState<VersionOpt[]>([]);
  const [editing, setEditing] = useState<Application | "new" | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    (async () => {
      const ready = (resumes.data ?? []).filter((r) => r.latest_version_id);
      const all = await Promise.all(
        ready.map(async (r) => {
          try {
            const vs = await api<Version[]>(`/api/resumes/${r.id}/versions`);
            return vs.map((v) => ({ id: v.id, label: `${r.title} · v${v.number}${v.label ? ` (${v.label})` : ""}` }));
          } catch {
            return [];
          }
        }),
      );
      setVersions(all.flat());
    })();
  }, [resumes.data]);

  const versionLabel = (id: string | null) => (id ? versions.find((v) => v.id === id)?.label ?? t("apps.versionUnavailable") : null);
  const list = (apps.data ?? []).filter((a) => filter === "all" || a.status === filter);

  async function remove(a: Application) {
    if (!window.confirm(t("apps.confirmDelete", { company: a.company }))) return;
    await api(`/api/applications/${a.id}`, { method: "DELETE" });
    apps.setData((apps.data ?? []).filter((x) => x.id !== a.id));
  }

  return (
    <>
      <PageHeader
        eyebrow={t("apps.eyebrow")}
        title={t("apps.title")}
        actions={
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden /> {t("apps.add")}
          </button>
        }
      >
        {t("apps.intro")}
      </PageHeader>

      {editing && (
        <AppForm
          initial={editing === "new" ? null : editing}
          versions={versions}
          onCancel={() => setEditing(null)}
          onSaved={(a) => {
            apps.setData(editing === "new" ? [a, ...(apps.data ?? [])] : (apps.data ?? []).map((x) => (x.id === a.id ? a : x)));
            setEditing(null);
          }}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={t("apps.filterAria")}>
        {["all", ...STATUSES].map((s) => (
          <button
            key={s}
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
            className="rounded-full border border-line-strong px-3 py-1 text-xs font-medium capitalize aria-pressed:border-teal aria-pressed:bg-teal-soft aria-pressed:text-teal"
          >
            {t(STATUS_LABEL[s])}
            {s !== "all" && apps.data && <span className="num ml-1 text-muted">{apps.data.filter((a) => a.status === s).length}</span>}
          </button>
        ))}
      </div>

      {apps.loading && !apps.data ? (
        <LoadingBlock />
      ) : apps.error ? (
        <ErrorState message={apps.error} onRetry={apps.reload} />
      ) : !list.length ? (
        <Empty icon={<Briefcase className="h-8 w-8" />} title={filter === "all" ? t("apps.empty") : t("apps.emptyFiltered", { status: t(STATUS_LABEL[filter]) })}>
          {t("apps.emptyBody")}
        </Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">{t("apps.title")}</caption>
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-3">{t("apps.col.company")}</th>
                <th scope="col" className="px-4 py-3">{t("apps.col.status")}</th>
                <th scope="col" className="px-4 py-3">{t("apps.col.applied")}</th>
                <th scope="col" className="px-4 py-3">{t("apps.col.next")}</th>
                <th scope="col" className="px-4 py-3">{t("apps.col.resume")}</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">{t("apps.col.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{a.company}</p>
                    <p className="text-ink-2">{a.role}</p>
                    {a.location && <p className="text-xs text-muted">{a.location}</p>}
                    {a.url && (
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-teal underline">
                        {t("apps.posting")} <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                    {a.notes && <p className="mt-1 max-w-xs whitespace-pre-line text-xs text-muted">{a.notes}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={TONE[a.status]} className="whitespace-nowrap">{STATUS_LABEL[a.status] ? t(STATUS_LABEL[a.status]) : a.status}</Badge>
                  </td>
                  <td className="num px-4 py-3 text-xs">{a.applied_on ?? "—"}</td>
                  <td className="num px-4 py-3 text-xs">{a.next_step_on ?? "—"}</td>
                  <td className="px-4 py-3 text-xs">{versionLabel(a.resume_version_id) ?? <span className="text-muted">—</span>}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button className="btn btn-ghost btn-sm" aria-label={t("apps.editAria", { company: a.company })} onClick={() => setEditing(a)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </button>
                      <button className="btn btn-ghost btn-sm" aria-label={t("apps.deleteAria", { company: a.company })} onClick={() => remove(a)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                    <p className="mt-1 text-[10px] text-muted">{t("apps.updated", { date: fmtDate(a.updated_at) })}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AppForm({ initial, versions, onCancel, onSaved }: { initial: Application | null; versions: VersionOpt[]; onCancel: () => void; onSaved: (a: Application) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => (String(f.get(k) ?? "").trim() || null);
    const body = {
      company: v("company"), role: v("role"), status: v("status"), applied_on: v("applied_on"), next_step_on: v("next_step_on"),
      location: v("location"), url: v("url"), notes: v("notes"), resume_version_id: v("resume_version_id"),
    };
    setBusy(true);
    setErr(null);
    try {
      const a = initial
        ? await api<Application>(`/api/applications/${initial.id}`, { method: "PATCH", body })
        : await api<Application>("/api/applications", { body });
      onSaved(a);
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(false);
    }
  }
  const i = initial;
  return (
    <form onSubmit={submit} className="card rise mb-6 grid gap-4 p-5 sm:grid-cols-2" aria-label={i ? t("apps.edit") : t("apps.new")}>
      <h2 className="text-xl sm:col-span-2">{i ? t("apps.editTitle", { company: i.company }) : t("apps.new")}</h2>
      {err && <div className="sm:col-span-2"><Alert tone="bad">{err}</Alert></div>}
      <Field label={t("apps.f.company")} id="company"><input className="input" id="company" name="company" defaultValue={i?.company} required maxLength={200} /></Field>
      <Field label={t("apps.f.role")} id="role"><input className="input" id="role" name="role" defaultValue={i?.role} required maxLength={200} /></Field>
      <Field label={t("apps.f.status")} id="status">
        <select className="input" id="status" name="status" defaultValue={i?.status ?? "saved"}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_LABEL[s])}</option>)}
        </select>
      </Field>
      <Field label={t("apps.f.location")} id="location"><input className="input" id="location" name="location" defaultValue={i?.location ?? ""} /></Field>
      <Field label={t("apps.f.appliedOn")} id="applied_on"><input className="input" type="date" id="applied_on" name="applied_on" defaultValue={i?.applied_on ?? ""} /></Field>
      <Field label={t("apps.f.nextOn")} id="next_step_on"><input className="input" type="date" id="next_step_on" name="next_step_on" defaultValue={i?.next_step_on ?? ""} /></Field>
      <Field label={t("apps.f.url")} id="url"><input className="input" type="url" id="url" name="url" defaultValue={i?.url ?? ""} placeholder="https://" /></Field>
      <Field label={t("apps.f.version")} id="resume_version_id">
        <select className="input" id="resume_version_id" name="resume_version_id" defaultValue={i?.resume_version_id ?? ""}>
          <option value="">{t("apps.f.notRecorded")}</option>
          {versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field label={t("apps.f.notes")} id="notes"><textarea className="input" id="notes" name="notes" rows={3} defaultValue={i?.notes ?? ""} maxLength={5000} /></Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner label={t("common.saving")} /> : t("common.save")}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </form>
  );
}
