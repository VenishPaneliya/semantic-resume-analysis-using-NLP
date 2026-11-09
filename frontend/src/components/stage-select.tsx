"use client";

import { useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useT, type MessageKey, type TFunction } from "@/lib/i18n";
import { STAGES, type ApplicationStage } from "@/lib/types";

/** Translation keys for application stages (the codes come from the API). */
export const STAGE_KEY: Record<ApplicationStage, MessageKey> = {
  submitted: "stage.submitted",
  shortlisted: "stage.shortlisted",
  interview: "stage.interview",
  offer: "stage.offer",
  hired: "stage.hired",
  rejected: "stage.rejected",
};

export function stageLabel(t: TFunction, s: string) {
  return s in STAGE_KEY ? t(STAGE_KEY[s as ApplicationStage]) : s.replace(/_/g, " ");
}

/** Recruiter control for an application's stage. Saves immediately. */
export function StageSelect({ applicationId, stage, name, onChange }: { applicationId: string; stage: ApplicationStage; name: string; onChange: (s: ApplicationStage) => void }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sid = `stage-${applicationId}`;
  return (
    <div>
      <label htmlFor={sid} className="sr-only">
        {t("stage.label", { name })}
      </label>
      <select
        id={sid}
        className="input py-1 text-sm"
        value={stage}
        disabled={pending}
        onChange={async (e) => {
          const next = e.target.value as ApplicationStage;
          setPending(true);
          setError(null);
          try {
            await api(`/api/recruiter/applications/${applicationId}`, { method: "PATCH", body: { stage: next } });
            onChange(next);
          } catch (err) {
            setError(errMsg(err));
          } finally {
            setPending(false);
          }
        }}
      >
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {t(STAGE_KEY[s])}
          </option>
        ))}
      </select>
      {error && (
        <p className="mt-1 text-xs text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
