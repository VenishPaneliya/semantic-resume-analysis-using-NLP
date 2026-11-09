"use client";

import { useState, type FormEvent } from "react";
import { useT, type MessageKey } from "@/lib/i18n";
import type { OpeningEmployment, OpeningFull, WorkArrangement } from "@/lib/types";
import { Alert, Field, Spinner } from "./ui";

const ARRANGEMENT_KEY: Record<string, MessageKey> = { onsite: "ofrm.arr.onsite", hybrid: "ofrm.arr.hybrid", remote: "ofrm.arr.remote" };
const EMPLOYMENT_KEY: Record<string, MessageKey> = {
  full_time: "ofrm.emp.full_time",
  part_time: "ofrm.emp.part_time",
  contract: "ofrm.emp.contract",
  internship: "ofrm.emp.internship",
};

export interface OpeningInput {
  title: string;
  company: string;
  location: string | null;
  work_arrangement: WorkArrangement | null;
  employment_type: OpeningEmployment | null;
  description: string;
}

const MIN_DESC = 80;

export function OpeningForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: Partial<OpeningFull>;
  submitLabel: string;
  onSubmit: (v: OpeningInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = initial?.id ? `op-${initial.id.slice(0, 6)}` : "op-new";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const description = String(f.get("description") ?? "").trim();
    if (description.length < MIN_DESC) {
      setError(t("ofrm.descMin", { min: MIN_DESC }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        title: String(f.get("title") ?? "").trim(),
        company: String(f.get("company") ?? "").trim(),
        location: String(f.get("location") ?? "").trim() || null,
        work_arrangement: (f.get("work_arrangement") as WorkArrangement) || null,
        employment_type: (f.get("employment_type") as OpeningEmployment) || null,
        description,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate={false}>
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("ofrm.title")} id={`${p}-title`}>
          <input className="input" id={`${p}-title`} name="title" required minLength={2} maxLength={200} defaultValue={initial?.title} />
        </Field>
        <Field label={t("ofrm.company")} id={`${p}-company`}>
          <input className="input" id={`${p}-company`} name="company" required maxLength={200} defaultValue={initial?.company} />
        </Field>
        <Field label={t("ofrm.location")} id={`${p}-location`}>
          <input className="input" id={`${p}-location`} name="location" maxLength={200} defaultValue={initial?.location ?? ""} />
        </Field>
        <div className="grid gap-3 min-[400px]:grid-cols-2">
          <Field label={t("ofrm.arrangement")} id={`${p}-arr`}>
            <select className="input" id={`${p}-arr`} name="work_arrangement" defaultValue={initial?.work_arrangement ?? ""}>
              <option value="">{t("ofrm.notSpecified")}</option>
              {Object.entries(ARRANGEMENT_KEY).map(([k, v]) => (
                <option key={k} value={k}>
                  {t(v)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("ofrm.employment")} id={`${p}-emp`}>
            <select className="input" id={`${p}-emp`} name="employment_type" defaultValue={initial?.employment_type ?? ""}>
              <option value="">{t("ofrm.notSpecified")}</option>
              {Object.entries(EMPLOYMENT_KEY).map(([k, v]) => (
                <option key={k} value={k}>
                  {t(v)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Field
        label={t("ofrm.description")}
        id={`${p}-desc`}
        hint={t("ofrm.descHint", { n: desc.trim().length, min: MIN_DESC })}
      >
        <textarea
          className="input min-h-56"
          id={`${p}-desc`}
          name="description"
          required
          minLength={MIN_DESC}
          maxLength={30000}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={pending}>
          {pending ? <Spinner label={t("common.saving")} /> : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
      </div>
    </form>
  );
}
