"use client";

import { Plus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SampleBadge } from "@/components/leaderboard";
import { OpeningForm } from "@/components/opening-form";
import { Badge, Empty, ErrorState, fmtDate, LoadingBlock, PageHeader, Section } from "@/components/ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";
import type { RecruiterOpening, RecruiterOpeningFull } from "@/lib/types";

export default function RecruiterHome() {
  const router = useRouter();
  const t = useT();
  const list = useApi<RecruiterOpening[]>("/api/recruiter/openings");
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t("rec.eyebrow")}
        title={t("rec.home.title")}
        actions={
          !creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t("rec.home.newOpening")}
            </button>
          )
        }
      >
        {t("rec.home.intro")}
      </PageHeader>

      {creating && (
        <Section title={t("rec.home.newOpening")} id="new-opening">
          <OpeningForm
            submitLabel={t("rec.home.publish")}
            onCancel={() => setCreating(false)}
            onSubmit={async (v) => {
              const o = await api<RecruiterOpeningFull>("/api/recruiter/openings", { body: v });
              router.push(`/recruiter/openings/${o.id}?created=1`);
            }}
          />
        </Section>
      )}

      {list.loading && !list.data ? (
        <LoadingBlock />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data?.length ? (
        <Empty level={2} icon={<Users className="h-8 w-8" aria-hidden />} title={t("rec.home.empty")}>
          {t("rec.home.emptyBody")}
        </Empty>
      ) : (
        <div className="card relative overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{t("rec.home.caption")}</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                <th scope="col" className="px-4 py-3 font-semibold">{t("rec.col.opening")}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t("rec.col.status")}</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">{t("rec.col.applicants")}</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">{t("rec.col.topScore")}</th>
                <th scope="col" className="px-4 py-3 font-semibold">{t("rec.col.posted")}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((o) => (
                <tr key={o.id} className="border-b border-line last:border-0 hover:bg-paper-2/40">
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/recruiter/openings/${o.id}`} className="font-medium text-ink hover:underline">
                        {o.title}
                      </Link>
                      {o.is_demo && <SampleBadge />}
                    </div>
                    <p className="text-xs text-muted">
                      {o.company}
                      {o.location ? ` · ${o.location}` : ""}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={o.status === "open" ? "ok" : "neutral"}>{o.status === "open" ? t("rec.statusOpen") : t("rec.statusClosed")}</Badge>
                  </td>
                  <td className="num px-4 py-3 text-right">{o.applicants}</td>
                  <td className="num px-4 py-3 text-right">{o.top_score == null ? "—" : Math.round(o.top_score)}</td>
                  <td className="px-4 py-3 text-xs text-muted">{fmtDate(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
