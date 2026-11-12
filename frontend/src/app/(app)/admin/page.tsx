"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useUser } from "@/components/shell";
import { Alert, Badge, Empty, ErrorState, fmtDate, LoadingBlock, PageHeader, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useT } from "@/lib/i18n";

interface Overview {
  users: { total: number; verified: number; new_7d: number };
  resumes: { total: number; by_status: Record<string, number> };
  jobs: { by_status: Record<string, number>; failures_7d: { kind: string; code: string; count: number }[]; avg_seconds_7d: Record<string, number> };
  llm_7d: { provider: string; calls: number; cost_usd: number; avg_latency_ms: number; failures: number }[];
  versions: Record<string, string>;
  config: Record<string, string | boolean>;
}

export default function AdminPage() {
  const { user } = useUser();
  const t = useT();
  const ov = useApi<Overview>(user.role === "admin" ? "/api/admin/overview" : null);
  const jobs = useApi<{ id: string; kind: string; status: string; attempts: number; error_code: string | null; updated_at: string }[]>(
    user.role === "admin" ? "/api/admin/jobs?status=failed" : null,
  );
  const [rec, setRec] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user.role !== "admin") return <Empty level={2} title={t("admin.only")}>{t("admin.noAccess")}</Empty>;

  async function recover() {
    setBusy(true);
    try {
      const r = await api<{ redispatched: number }>("/api/admin/jobs/recover", { method: "POST" });
      setRec(t("admin.redispatched", { count: r.redispatched }));
      await Promise.all([ov.reload(), jobs.reload()]);
    } catch (e) {
      setRec(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow={t("admin.eyebrow")} title={t("admin.title")} actions={<button className="btn btn-secondary" onClick={recover} disabled={busy}>{busy ? <Spinner label={t("admin.recovering")} /> : (<><RotateCcw className="h-4 w-4" aria-hidden /> {t("admin.recover")}</>)}</button>}>
        {t("admin.intro")}
      </PageHeader>
      {rec && <div className="mb-4"><Alert tone="info">{rec}</Alert></div>}
      {ov.error ? <ErrorState message={ov.error} onRetry={ov.reload} /> : !ov.data ? <LoadingBlock /> : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile k={t("admin.users")} v={ov.data.users.total} sub={t("admin.usersSub", { verified: ov.data.users.verified, new: ov.data.users.new_7d })} />
            <Tile k={t("admin.resumes")} v={ov.data.resumes.total} sub={Object.entries(ov.data.resumes.by_status).map(([s, n]) => `${s} ${n}`).join(" · ") || "—"} />
            <Tile k={t("admin.queued")} v={(ov.data.jobs.by_status.queued ?? 0) + (ov.data.jobs.by_status.running ?? 0)} sub={t("admin.failedTotal", { count: ov.data.jobs.by_status.failed ?? 0 })} />
            <Tile k={t("admin.llmCost")} v={`$${ov.data.llm_7d.reduce((a, x) => a + x.cost_usd, 0).toFixed(4)}`} sub={t("admin.calls", { count: ov.data.llm_7d.reduce((a, x) => a + x.calls, 0) })} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={t("admin.failures")} id="fail">
              {ov.data.jobs.failures_7d.length === 0 ? <p className="text-sm text-muted">{t("admin.noFailures")}</p> : (
                <ul className="space-y-1 text-sm">{ov.data.jobs.failures_7d.map((f) => <li key={f.kind + f.code} className="flex justify-between"><span>{f.kind} · <code>{f.code}</code></span><span className="num">{f.count}</span></li>)}</ul>
              )}
              <p className="label mt-4">{t("admin.avgDuration")}</p>
              <ul className="text-sm">{Object.entries(ov.data.jobs.avg_seconds_7d).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="num">{v}s</span></li>)}</ul>
            </Section>
            <Section title={t("admin.llmProviders")} id="llm">
              {ov.data.llm_7d.length === 0 ? <p className="text-sm text-muted">{t("admin.noCalls")}</p> : (
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-left">{t("admin.col.provider")}</th><th className="text-right">{t("admin.col.calls")}</th><th className="text-right">{t("admin.col.failures")}</th><th className="text-right">{t("admin.col.avgMs")}</th><th className="text-right">{t("admin.col.cost")}</th></tr></thead>
                  <tbody>{ov.data.llm_7d.map((l) => <tr key={l.provider} className="border-t border-line"><td>{l.provider}</td><td className="num text-right">{l.calls}</td><td className="num text-right">{l.failures}</td><td className="num text-right">{l.avg_latency_ms}</td><td className="num text-right">${l.cost_usd.toFixed(4)}</td></tr>)}</tbody></table></div>
              )}
            </Section>
            <Section title={t("admin.versions")} id="ver">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{Object.entries(ov.data.versions).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="num break-all">{v}</dd></div>)}</dl>
            </Section>
            <Section title={t("admin.config")} id="cfg">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{Object.entries(ov.data.config).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="num">{String(v)}</dd></div>)}</dl>
            </Section>
          </div>
          <Section title={t("admin.failedJobs")} id="fj">
            {jobs.error ? <ErrorState message={jobs.error} onRetry={jobs.reload} /> : !jobs.data ? <LoadingBlock /> : jobs.data.length === 0 ? <p className="text-sm text-muted">{t("admin.none")}</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead className="text-xs text-muted"><tr><th className="text-left">{t("admin.col.job")}</th><th className="text-left">{t("admin.col.kind")}</th><th>{t("admin.col.attempts")}</th><th className="text-left">{t("admin.col.error")}</th><th className="text-left">{t("admin.col.updated")}</th></tr></thead>
                <tbody>{jobs.data.map((j) => <tr key={j.id} className="border-t border-line"><td className="num py-1 text-xs">{j.id.slice(0, 8)}</td><td>{j.kind}</td><td className="num text-center">{j.attempts}</td><td><Badge tone="bad">{j.error_code ?? "—"}</Badge></td><td className="text-xs">{fmtDate(j.updated_at)}</td></tr>)}</tbody></table></div>
            )}
          </Section>
        </div>
      )}
    </>
  );
}

function Tile({ k, v, sub }: { k: string; v: number | string; sub: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{k}</p>
      <p className="num mt-1 text-3xl">{v}</p>
      <p className="mt-1 text-xs text-muted">{sub}</p>
    </div>
  );
}
