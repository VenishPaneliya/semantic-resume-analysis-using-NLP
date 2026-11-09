"use client";

import { Flag, Info, Search } from "lucide-react";
import { useState } from "react";
import { Alert, Empty, EnglishNote, ErrorState, Field, fmtDate, LoadingBlock, PageHeader, pct, Section } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import { dimensionLabel, groupLabel } from "@/lib/labels";
import type { Fairness, FairnessGroup, RecruiterOpening } from "@/lib/types";

export default function FairnessPage() {
  const t = useT();
  const [opening, setOpening] = useState("");
  const openings = useApi<RecruiterOpening[]>("/api/recruiter/openings");
  const { data, error, loading, reload } = useApi<Fairness>(`/api/recruiter/fairness${opening ? `?opening_id=${encodeURIComponent(opening)}` : ""}`);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={t("rec.eyebrow")} title={t("fairness.title")}>
        {t("fairness.intro")}
      </PageHeader>

      <Alert tone="warn" title={t("fairness.warnTitle")}>
        {t("fairness.warnBody")}
      </Alert>

      <div className="max-w-md">
        <Field label={t("fairness.scope")} id="fair-scope">
          <select id="fair-scope" className="input" value={opening} onChange={(e) => setOpening(e.target.value)}>
            <option value="">{t("rec.allOpenings")}</option>
            {openings.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} · {o.company}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {loading && !data ? (
        <LoadingBlock label={t("fairness.loading")} />
      ) : error || !data ? (
        <ErrorState message={error ?? t("fairness.loadError")} onRetry={reload} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))]" data-testid="fairness-totals">
            <Stat k={t("fairness.applicants")} v={data.applicants} />
            <Stat k={t("fairness.asOf")} v={fmtDate(data.as_of)} sub={t("fairness.asOfSub")} />
            <Stat k={t("fairness.minGroup")} v={data.min_group_size} sub={t("fairness.minGroupSub")} />
            <Stat
              k={t("fairness.flags")}
              v={(["gender", "age_band"] as const).reduce((n, d) => n + data.dimensions[d].groups.reduce((m, g) => m + g.flags.length, 0), 0)}
              sub={t("fairness.flagsSub")}
            />
          </dl>

          {(["gender", "age_band"] as const).map((dim) => (
            <DimensionTable key={dim} dim={dim} groups={data.dimensions[dim].groups} min={data.min_group_size} />
          ))}

          <section className="rounded-lg border border-line bg-card p-4" aria-labelledby="fair-notes">
            <h2 id="fair-notes" className="flex items-center gap-1.5 text-base">
              <Info className="h-4 w-4 text-teal" aria-hidden /> {t("fairness.about")}
            </h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2" data-testid="fairness-notes">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <dl className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-2">
              <div>
                <dt className="inline font-semibold text-ink-2">{t("fairness.strongRate")}</dt> <dd className="inline">{t("fairness.strongRateDef")}</dd>
              </div>
              <div>
                <dt className="inline font-semibold text-ink-2">{t("fairness.selectionRate")}</dt> <dd className="inline">{t("fairness.selectionRateDef")}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="inline font-semibold text-ink-2">{t("fairness.impactRatio")}</dt> <dd className="inline">{t("fairness.impactRatioDef")}</dd>
              </div>
            </dl>
            <EnglishNote kind="generic" className="mt-3" />
          </section>
        </>
      )}
    </div>
  );
}

function DimensionTable({ dim, groups, min }: { dim: "gender" | "age_band"; groups: FairnessGroup[]; min: number }) {
  const t = useT();
  const label = dimensionLabel(t, dim);
  return (
    <Section
      title={t("fairness.by", { dim: label.toLowerCase() })}
      id={`dim-${dim}`}
    >
      {groups.length === 0 ? (
        <Empty icon={<Search className="h-7 w-7" aria-hidden />} title={t("fairness.notEnough")}>
          {t("fairness.notEnoughBody", { dim: label.toLowerCase(), min })}
        </Empty>
      ) : (
        <div className="-mx-5 overflow-x-auto sm:-mx-6">
          <table className="w-full min-w-[720px] text-sm" data-testid={`fairness-${dim}`}>
            <caption className="sr-only">{t("fairness.caption", { dim: label })}</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                <th scope="col" className="px-5 py-2 font-semibold sm:px-6">{t("fairness.col.group")}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">n</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t("fairness.col.mean")}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t("fairness.col.strong")}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t("fairness.col.impact")}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t("fairness.col.selection")}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t("fairness.col.impact")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group} className="border-b border-line align-top last:border-0">
                  <td className="px-5 py-2.5 sm:px-6">
                    <span className="font-medium">{groupLabel(t, dim, g.group)}</span>
                    {g.flags.map((f) => (
                      <p key={f} className="mt-1 flex items-start gap-1 text-xs text-warn">
                        <Flag className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {f}
                      </p>
                    ))}
                  </td>
                  <td className="num px-3 py-2.5 text-right">{g.n}</td>
                  <td className="num px-3 py-2.5 text-right">{g.mean_score}</td>
                  <td className="num px-3 py-2.5 text-right">{pct(g.strong_rate)}</td>
                  <Ratio v={g.strong_rate_impact_ratio} />
                  <td className="num px-3 py-2.5 text-right">{pct(g.selection_rate)}</td>
                  <Ratio v={g.selection_rate_impact_ratio} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Ratio({ v }: { v: number | null }) {
  return <td className={`num px-3 py-2.5 text-right ${v != null && v < 0.8 ? "font-semibold text-warn" : ""}`}>{v == null ? "—" : v.toFixed(2)}</td>;
}

function Stat({ k, v, sub }: { k: string; v: number | string; sub?: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="num mt-1 text-2xl font-semibold">{v}</dd>
      {sub && <dd className="text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}
