"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { useUser } from "@/components/shell";
import { Alert, Badge, Empty, ErrorState, fmtDate, LoadingBlock, PageHeader, Section, Spinner } from "@/components/ui";
import { api, errMsg } from "@/lib/api";
import { useApi } from "@/lib/hooks";

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
  const ov = useApi<Overview>(user.role === "admin" ? "/api/admin/overview" : null);
  const jobs = useApi<{ id: string; kind: string; status: string; attempts: number; error_code: string | null; updated_at: string }[]>(
    user.role === "admin" ? "/api/admin/jobs?status=failed" : null,
  );
  const [rec, setRec] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user.role !== "admin") return <Empty title="Administrators only">You do not have access to this page.</Empty>;

  async function recover() {
    setBusy(true);
    try {
      const r = await api<{ redispatched: number }>("/api/admin/jobs/recover", { method: "POST" });
      setRec(`Re-dispatched ${r.redispatched} stale job(s).`);
      await Promise.all([ov.reload(), jobs.reload()]);
    } catch (e) {
      setRec(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Restricted" title="Operations" actions={<button className="btn btn-secondary" onClick={recover} disabled={busy}>{busy ? <Spinner label="Recovering" /> : (<><RotateCcw className="h-4 w-4" aria-hidden /> Recover stale jobs</>)}</button>}>
        Aggregates and metadata only — resume and job-description content is never shown here.
      </PageHeader>
      {rec && <div className="mb-4"><Alert tone="info">{rec}</Alert></div>}
      {ov.error ? <ErrorState message={ov.error} onRetry={ov.reload} /> : !ov.data ? <LoadingBlock /> : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile k="Users" v={ov.data.users.total} sub={`${ov.data.users.verified} verified · ${ov.data.users.new_7d} new (7d)`} />
            <Tile k="Resumes" v={ov.data.resumes.total} sub={Object.entries(ov.data.resumes.by_status).map(([s, n]) => `${s} ${n}`).join(" · ") || "—"} />
            <Tile k="Queued / running" v={(ov.data.jobs.by_status.queued ?? 0) + (ov.data.jobs.by_status.running ?? 0)} sub={`${ov.data.jobs.by_status.failed ?? 0} failed total`} />
            <Tile k="LLM cost (7d)" v={`$${ov.data.llm_7d.reduce((a, x) => a + x.cost_usd, 0).toFixed(4)}`} sub={`${ov.data.llm_7d.reduce((a, x) => a + x.calls, 0)} calls`} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Failures (7 days)" id="fail">
              {ov.data.jobs.failures_7d.length === 0 ? <p className="text-sm text-muted">No failures.</p> : (
                <ul className="space-y-1 text-sm">{ov.data.jobs.failures_7d.map((f) => <li key={f.kind + f.code} className="flex justify-between"><span>{f.kind} · <code>{f.code}</code></span><span className="num">{f.count}</span></li>)}</ul>
              )}
              <p className="label mt-4">Average job duration (7d)</p>
              <ul className="text-sm">{Object.entries(ov.data.jobs.avg_seconds_7d).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="num">{v}s</span></li>)}</ul>
            </Section>
            <Section title="LLM providers (7 days)" id="llm">
              {ov.data.llm_7d.length === 0 ? <p className="text-sm text-muted">No calls.</p> : (
                <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-left">Provider</th><th className="text-right">Calls</th><th className="text-right">Failures</th><th className="text-right">Avg ms</th><th className="text-right">Cost</th></tr></thead>
                  <tbody>{ov.data.llm_7d.map((l) => <tr key={l.provider} className="border-t border-line"><td>{l.provider}</td><td className="num text-right">{l.calls}</td><td className="num text-right">{l.failures}</td><td className="num text-right">{l.avg_latency_ms}</td><td className="num text-right">${l.cost_usd.toFixed(4)}</td></tr>)}</tbody></table>
              )}
            </Section>
            <Section title="Engine versions" id="ver">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{Object.entries(ov.data.versions).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="num break-all">{v}</dd></div>)}</dl>
            </Section>
            <Section title="Configuration" id="cfg">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">{Object.entries(ov.data.config).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="num">{String(v)}</dd></div>)}</dl>
            </Section>
          </div>
          <Section title="Failed jobs" id="fj">
            {jobs.error ? <ErrorState message={jobs.error} onRetry={jobs.reload} /> : !jobs.data ? <LoadingBlock /> : jobs.data.length === 0 ? <p className="text-sm text-muted">None.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead className="text-xs text-muted"><tr><th className="text-left">Job</th><th className="text-left">Kind</th><th>Attempts</th><th className="text-left">Error</th><th className="text-left">Updated</th></tr></thead>
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
