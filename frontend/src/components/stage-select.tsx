"use client";

import { useState } from "react";
import { api, errMsg } from "@/lib/api";
import type { ApplicationStage } from "@/lib/types";
import { STAGE } from "./leaderboard";

/** Recruiter control for an application's stage. Saves immediately. */
export function StageSelect({ applicationId, stage, name, onChange }: { applicationId: string; stage: ApplicationStage; name: string; onChange: (s: ApplicationStage) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sid = `stage-${applicationId}`;
  return (
    <div>
      <label htmlFor={sid} className="sr-only">
        Stage for {name}
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
        {(Object.keys(STAGE) as ApplicationStage[]).map((s) => (
          <option key={s} value={s}>
            {STAGE[s].label}
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
