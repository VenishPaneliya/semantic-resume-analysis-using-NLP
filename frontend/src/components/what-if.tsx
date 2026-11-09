"use client";

import { ArrowRight, Gauge, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { Opening, ResumeContent, RoleLeaderboard, WhatIf } from "@/lib/types";
import { TierBadge } from "./leaderboard";
import { cx, Spinner } from "./ui";

const DEBOUNCE_MS = 800;

/** Live "what-if" score for unsaved editor content. Same engine as the leaderboards; nothing is saved. */
export function WhatIfPanel({ versionId, draft, dirty }: { versionId: string; draft: ResumeContent; dirty: boolean }) {
  const t = useT();
  const roles = useApi<RoleLeaderboard>(`/api/versions/${versionId}/leaderboard/roles`);
  const openings = useApi<Opening[]>("/api/openings");
  const [target, setTarget] = useState("");
  const [res, setRes] = useState<WhatIf | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastSent = useRef<string>("");

  const topRoles = (roles.data?.rows ?? []).slice(0, 8);
  const effectiveTarget = target || (topRoles[0] ? `role:${topRoles[0].role_id}` : "");

  useEffect(() => {
    if (!effectiveTarget || !dirty) {
      if (!dirty) {
        setRes(null);
        lastSent.current = "";
      }
      return;
    }
    const payload = JSON.stringify(draft);
    const key = `${effectiveTarget}|${payload}`;
    if (key === lastSent.current) return; // only send when content (or target) actually changed
    const ctl = new AbortController();
    const timer = window.setTimeout(async () => {
      const [kind, ...rest] = effectiveTarget.split(":");
      const id = rest.join(":");
      setPending(true);
      setErr(null);
      try {
        const r = await api<WhatIf>(`/api/versions/${versionId}/what-if`, {
          body: { content: draft, ...(kind === "role" ? { role_id: id } : { opening_id: id }) },
          signal: ctl.signal,
        });
        lastSent.current = key;
        setRes(r);
      } catch (e) {
        if (!ctl.signal.aborted) setErr(errMsg(e));
      } finally {
        if (!ctl.signal.aborted) setPending(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      ctl.abort();
      window.clearTimeout(timer);
    };
  }, [draft, dirty, effectiveTarget, versionId]);

  const delta = res?.delta;
  return (
    <section className="card mb-5 p-4" aria-labelledby="whatif-h" data-testid="what-if">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="whatif-h" className="flex items-center gap-1.5 text-base">
          <Gauge className="h-4 w-4 text-teal" aria-hidden /> {t("whatif.title")}
        </h2>
        <label htmlFor="whatif-target" className="sr-only">
          {t("whatif.scoreAgainst")}
        </label>
        <select
          id="whatif-target"
          className="input w-full !py-1 text-sm sm:w-auto sm:max-w-[280px]"
          value={effectiveTarget}
          onChange={(e) => {
            setTarget(e.target.value);
            setRes(null);
          }}
        >
          {!effectiveTarget && <option value="">{t("whatif.loadingTargets")}</option>}
          {topRoles.length > 0 && (
            <optgroup label={t("whatif.topRoles")}>
              {topRoles.map((r) => (
                <option key={r.role_id} value={`role:${r.role_id}`}>
                  {r.title} ({Math.round(r.score)})
                </option>
              ))}
            </optgroup>
          )}
          {openings.data && openings.data.length > 0 && (
            <optgroup label={t("nav.openings")}>
              {openings.data.map((o) => (
                <option key={o.id} value={`opening:${o.id}`}>
                  {o.title} · {o.company}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <span className="text-xs text-muted sm:ml-auto">{t("whatif.previewOnly")}</span>
      </div>

      <div className="mt-3 min-h-10" aria-live="polite">
        {!dirty ? (
          <p className="text-sm text-ink-2">{t("whatif.editPrompt")}</p>
        ) : err ? (
          <p className="text-sm text-bad">{err}</p>
        ) : !res ? (
          <Spinner label={t("whatif.scoring")} />
        ) : (
          <div className="space-y-2" data-testid="what-if-result">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-sm text-ink-2">{t("whatif.saved")}</span>
              <span className="num text-xl font-semibold text-muted">{res.before.score == null ? "—" : Math.round(res.before.score)}</span>
              <ArrowRight className="h-4 w-4 text-muted" aria-hidden />
              <span className="text-sm text-ink-2">{t("whatif.withEdits")}</span>
              <span className="num text-xl font-semibold">{res.after.score == null ? "—" : Math.round(res.after.score)}</span>
              <span
                data-testid="what-if-delta"
                className={cx(
                  "num rounded-full px-2 py-0.5 text-sm font-semibold",
                  delta == null || delta === 0 ? "bg-paper-2 text-ink-2" : delta > 0 ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad",
                )}
              >
                {delta == null ? t("whatif.noChange") : delta > 0 ? `+${delta}` : delta === 0 ? "±0" : `${delta}`}
              </span>
              <TierBadge tier={res.after.tier} />
              {pending && <Spinner label={t("roles.updating")} />}
            </div>
            {(res.keywords_gained.length > 0 || res.keywords_lost.length > 0) && (
              <ul className="flex flex-wrap gap-1.5" aria-label={t("whatif.kwChanges")}>
                {res.keywords_gained.map((k) => (
                  <li key={`g${k}`} className="inline-flex items-center gap-1 rounded-full border border-[#bcd9c4] bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
                    <Plus className="h-3 w-3" aria-hidden />
                    <span className="sr-only">{t("whatif.gained")}</span>
                    {k}
                  </li>
                ))}
                {res.keywords_lost.map((k) => (
                  <li key={`l${k}`} className="inline-flex items-center gap-1 rounded-full border border-[#e9b7af] bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad">
                    <Minus className="h-3 w-3" aria-hidden />
                    <span className="sr-only">{t("whatif.lost")}</span>
                    {k}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">
              {res.note} {t("whatif.compat", { title: res.target.title })}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
