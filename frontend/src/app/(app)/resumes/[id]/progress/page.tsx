"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Empty, ErrorState, Field, fmtDate, LoadingBlock, Section } from "@/components/ui";
import { useApi } from "@/lib/hooks";
import { useT, type MessageKey } from "@/lib/i18n";
import type { HistoryPoint, ResumeHistory, RoleLeaderboard } from "@/lib/types";
import { useResume } from "../context";

// validated with the dataviz palette checker (lightness, chroma, CVD separation, contrast)
const C_QUALITY = "#0d9488";
const C_ROLE = "#4f46e5";

const SOURCE_KEY: Record<string, MessageKey> = {
  extracted: "progress.source.extracted",
  user_edit: "progress.source.user_edit",
  ai_accepted: "progress.source.ai_accepted",
  restore: "progress.source.restore",
};

export default function ProgressPage() {
  const t = useT();
  const { resume, versionId } = useResume();
  const roles = useApi<RoleLeaderboard>(versionId ? `/api/versions/${versionId}/leaderboard/roles` : null);
  const [role, setRole] = useState("");
  const defaultRole = resume.target_role && roles.data?.rows.some((r) => r.role_id === resume.target_role) ? resume.target_role : (roles.data?.rows[0]?.role_id ?? "");
  const roleId = role || defaultRole;
  const h = useApi<ResumeHistory>(versionId && roles.data ? `/api/resumes/${resume.id}/history${roleId ? `?role_id=${encodeURIComponent(roleId)}` : ""}` : null);

  if (!versionId) return <Empty title={t("resume.confirmFirst")}>{t("progress.emptyBody")}</Empty>;
  const roleTitle = roles.data?.rows.find((r) => r.role_id === roleId)?.title ?? t("progress.targetRole");

  return (
    <div className="space-y-6">
      <Section
        title={t("progress.health")}
        id="health"
        aside={
          <div className="w-full sm:w-72">
            <Field label={t("progress.targetRole")} id="hist-role">
              <select id="hist-role" className="input" value={roleId} onChange={(e) => setRole(e.target.value)}>
                {roles.data?.rows.map((r) => (
                  <option key={r.role_id} value={r.role_id} lang="en">
                    {r.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
      >
        {(roles.loading || h.loading) && !h.data ? (
          <LoadingBlock label={t("progress.scoring")} />
        ) : roles.error || h.error || !h.data ? (
          <ErrorState message={roles.error ?? h.error ?? t("progress.loadError")} onRetry={h.reload} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <Change label={t("progress.quality")} v={h.data.change.quality} />
              <Change label={t("progress.roleScore", { role: roleTitle })} v={h.data.change.target_score} />
              <span className="self-center text-xs text-muted">
                {t("progress.fromTo", { from: h.data.points[0]?.number ?? "", to: h.data.points[h.data.points.length - 1]?.number ?? "" })}
              </span>
            </div>
            <HealthChart points={h.data.points} roleTitle={roleTitle} />
            {h.data.points.length < 2 && (
              <Alert tone="info">
                {t.rich("progress.oneVersion", { link: (c) => <Link href={`/resumes/${resume.id}/editor`}>{c}</Link> })}
              </Alert>
            )}
            <p className="text-xs text-muted">
              {h.data.note} {t("progress.notProbability")}
            </p>
            <details className="rounded-md border border-line p-3">
              <summary className="cursor-pointer text-sm font-semibold">{t("progress.showTable")}</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                      <th scope="col" className="py-1.5 pr-3">{t("progress.col.version")}</th>
                      <th scope="col" className="py-1.5 pr-3">{t("progress.col.saved")}</th>
                      <th scope="col" className="py-1.5 pr-3 text-right">{t("progress.col.quality")}</th>
                      <th scope="col" className="py-1.5 pr-3 text-right" lang="en">{roleTitle}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h.data.points.map((p) => (
                      <tr key={p.version_id} className="border-b border-line last:border-0">
                        <td className="py-1.5 pr-3">
                          v{p.number} <span className="text-xs text-muted">{p.label ?? (SOURCE_KEY[p.source] ? t(SOURCE_KEY[p.source]) : p.source.replace("_", " "))}</span>
                        </td>
                        <td className="py-1.5 pr-3 text-xs text-muted">{fmtDate(p.created_at)}</td>
                        <td className="num py-1.5 pr-3 text-right">{p.quality ?? "—"}</td>
                        <td className="num py-1.5 pr-3 text-right">{p.target_score == null ? "—" : Math.round(p.target_score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}
      </Section>
    </div>
  );
}

function Change({ label, v }: { label: string; v: number | null }) {
  const Icon = v != null && v < 0 ? TrendingDown : TrendingUp;
  return (
    <div className="rounded-md border border-line bg-paper px-3 py-2" data-testid="history-change">
      <p className="text-xs text-muted">{label}</p>
      <p className={`num flex items-center gap-1 text-lg font-semibold ${v == null || v === 0 ? "text-ink-2" : v > 0 ? "text-ok" : "text-bad"}`}>
        {v != null && v !== 0 && <Icon className="h-4 w-4" aria-hidden />}
        {v == null ? "—" : v > 0 ? `+${v}` : v === 0 ? "±0" : v}
      </p>
    </div>
  );
}

function HealthChart({ points, roleTitle }: { points: HistoryPoint[]; roleTitle: string }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = 260;
  const m = { l: 36, r: 16, t: 14, b: 40 };
  const iw = w - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = points.length;
  const pad = 18; // keep the first and last markers off the axis line
  const x = (i: number) => m.l + pad + (n === 1 ? (iw - 2 * pad) / 2 : ((iw - 2 * pad) * i) / (n - 1));
  const y = (v: number) => m.t + ih - (ih * Math.max(0, Math.min(100, v))) / 100;
  const series = [
    { key: "quality" as const, label: t("progress.quality"), color: C_QUALITY, dash: undefined, get: (p: HistoryPoint) => p.quality },
    { key: "role" as const, label: t("progress.roleScore", { role: roleTitle }), color: C_ROLE, dash: "6 4", get: (p: HistoryPoint) => p.target_score },
  ];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 48))));

  return (
    <figure className="space-y-2" data-testid="history-chart">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label={t("progress.legend")}>
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="22" height="10" aria-hidden>
              <line x1="1" y1="5" x2="21" y2="5" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} />
              {s.key === "quality" ? <circle cx="11" cy="5" r="3.5" fill={s.color} /> : <rect x="7.5" y="1.5" width="7" height="7" fill={s.color} />}
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={box} className="relative w-full">
        <svg width={w} height={H} role="img" aria-label={t("progress.chartAria", { role: roleTitle, count: n })} className="block">
          {[0, 25, 50, 75, 100].map((tick) => (
            <g key={tick}>
              <line x1={m.l} x2={w - m.r} y1={y(tick)} y2={y(tick)} stroke="#e2e8f0" strokeWidth="1" />
              <text x={m.l - 6} y={y(tick)} dy="0.32em" textAnchor="end" fontSize="11" fill="#64748b">
                {tick}
              </text>
            </g>
          ))}
          <text x={12} y={m.t + ih / 2} transform={`rotate(-90 12 ${m.t + ih / 2})`} textAnchor="middle" fontSize="11" fill="#64748b">
            {t("progress.axisScore")}
          </text>
          {points.map((p, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={p.version_id} x={x(i)} y={H - m.b + 16} textAnchor="middle" fontSize="11" fill="#334155">
                v{p.number}
              </text>
            ) : null,
          )}
          <text x={m.l + iw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#64748b">
            {t("progress.axisVersion")}
          </text>
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} stroke="#cbd5e1" strokeWidth="1" />}
          {series.map((s) => {
            const pts = points.map((p, i) => [i, s.get(p)] as const).filter((q): q is readonly [number, number] => q[1] != null);
            if (!pts.length) return null;
            const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
            return (
              <g key={s.key}>
                <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} strokeLinejoin="round" />
                {pts.map(([i, v]) =>
                  s.key === "quality" ? (
                    <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5.5 : 4} fill={s.color} stroke="#fff" strokeWidth="2" />
                  ) : (
                    <rect key={i} x={x(i) - 4} y={y(v) - 4} width="8" height="8" fill={s.color} stroke="#fff" strokeWidth="2" />
                  ),
                )}
              </g>
            );
          })}
          {/* hit targets wider than the marks */}
          {points.map((p, i) => (
            <rect
              key={p.version_id}
              x={x(i) - Math.max(12, iw / Math.max(1, n - 1) / 2)}
              y={m.t}
              width={Math.max(24, iw / Math.max(1, n - 1))}
              height={ih}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {hover != null && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border border-line bg-card px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: Math.min(Math.max(0, x(hover) - 80), w - 170), top: 0, width: 170 }}
            role="status"
          >
            <p className="font-semibold">
              v{points[hover].number} · {fmtDate(points[hover].created_at)}
            </p>
            <p className="text-ink-2">{t("progress.tipQuality")} <span className="num font-semibold text-ink">{points[hover].quality ?? "—"}</span></p>
            <p className="text-ink-2">
              {roleTitle}: <span className="num font-semibold text-ink">{points[hover].target_score == null ? "—" : Math.round(points[hover].target_score!)}</span>
            </p>
          </div>
        )}
      </div>
      <figcaption className="sr-only">{t("progress.figcaption")}</figcaption>
    </figure>
  );
}
