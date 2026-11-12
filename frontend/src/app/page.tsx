"use client";

import { ArrowRight, Building2, Check, FileSearch, GitCompareArrows, ListChecks, ShieldCheck, Sparkles, Target } from "lucide-react";
import Link from "next/link";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/shell";
import { useT, type MessageKey } from "@/lib/i18n";

const FEATURES: { icon: typeof FileSearch; title: MessageKey; body: MessageKey }[] = [
  { icon: FileSearch, title: "landing.f1.title", body: "landing.f1.body" },
  { icon: Target, title: "landing.f2.title", body: "landing.f2.body" },
  { icon: ListChecks, title: "landing.f3.title", body: "landing.f3.body" },
  { icon: Sparkles, title: "landing.f4.title", body: "landing.f4.body" },
  { icon: GitCompareArrows, title: "landing.f5.title", body: "landing.f5.body" },
  { icon: ShieldCheck, title: "landing.f6.title", body: "landing.f6.body" },
];

const STEPS: MessageKey[] = ["landing.step1", "landing.step2", "landing.step3", "landing.step4"];
const HR_POINTS: MessageKey[] = ["landing.hr.p1", "landing.hr.p2", "landing.hr.p3", "landing.hr.p4"];

export default function Landing() {
  const t = useT();
  return (
    <div>
      <header className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
        <Logo />
        <nav aria-label={t("nav.account")} className="flex items-center gap-2">
          <LanguageSwitcher />
          <Link href="/login" className="btn btn-ghost whitespace-nowrap px-2.5 sm:px-3.5">
            {t("common.signIn")}
          </Link>
          {/* on phones the hero's main button already leads to registration */}
          <Link href="/register" className="btn btn-primary hidden whitespace-nowrap sm:inline-flex">
            {t("common.createAccount")}
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-10 lg:grid-cols-[1.15fr_1fr] lg:pt-20">
          <div>
            <p className="eyebrow rise">{t("landing.eyebrow")}</p>
            <h1 className="rise rise-1 mt-3 text-4xl leading-[1.05] sm:text-6xl">
              {t.rich("landing.hero", {
                em: (c) => <em className="text-teal not-italic underline decoration-ai-line decoration-4 underline-offset-8">{c}</em>,
              })}
            </h1>
            <p className="rise rise-2 mt-6 max-w-xl text-lg text-ink-2">
              {t("landing.intro")}
            </p>
            <div className="rise rise-3 mt-8 flex flex-wrap gap-3">
              <Link href="/register" className="btn btn-primary px-5 py-2.5 text-base">
                {t("landing.cta")} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="/login" className="btn btn-secondary px-5 py-2.5 text-base">
                {t("landing.haveAccount")}
              </Link>
            </div>
            <p className="rise rise-4 mt-6 max-w-lg text-xs text-muted">
              {t("landing.disclaimer")}
            </p>
          </div>

          {/* specimen card: an annotated resume line */}
          <div className="rise rise-2 relative" aria-hidden>
            <div className="card rotate-[1.2deg] p-6">
              <p className="eyebrow">{t("landing.specimen.eyebrow")}</p>
              <p className="mt-3 font-display text-lg leading-snug">
                <span className="bg-bad-soft line-through decoration-bad/60">Responsible for</span>{" "}
                <span className="bg-ok-soft">Automated</span> monthly reporting with Python and SQL
                <span className="bg-ai-soft text-ai"> [ADD: hours saved per month]</span>.
              </p>
              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                {[
                  [t("landing.specimen.quantified"), "0/1"],
                  [t("landing.specimen.actionVerb"), t("landing.specimen.fixed")],
                  [t("landing.specimen.newClaims"), t("landing.specimen.none")],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-md border border-line bg-paper px-2 py-2">
                    <p className="num text-sm font-semibold">{v}</p>
                    <p className="text-[11px] text-muted">{k}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="card absolute -bottom-8 -left-4 hidden w-60 -rotate-[2deg] p-4 sm:block">
              <p className="eyebrow">{t("landing.specimen.roleFit")}</p>
              {(
                [
                  [t("role.data_analyst"), 71],
                  [t("role.data_scientist"), 52],
                  [t("role.data_engineer"), 44],
                ] as const
              ).map(([r, s]) => (
                <div key={r} className="mt-2">
                  <div className="flex justify-between text-xs">
                    <span>{r}</span>
                    <span className="num">{s}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-paper-2">
                    <div className="h-full rounded-full bg-teal" style={{ width: `${s}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-y border-line bg-card/60">
          <div className="mx-auto grid max-w-6xl gap-px px-4 py-14 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="p-5">
                <Icon className="h-5 w-5 text-teal" aria-hidden />
                <h2 className="mt-3 text-lg">{t(title)}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{t(body)}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pt-14" aria-labelledby="hr-h" data-testid="landing-hr">
          <div className="card grid gap-6 p-6 sm:p-8 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <p className="eyebrow flex items-center gap-1.5">
                <Building2 className="h-4 w-4 shrink-0" aria-hidden /> {t("landing.hr.eyebrow")}
              </p>
              <h2 id="hr-h" className="mt-2 text-2xl">
                {t("landing.hr.title")}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{t("landing.hr.body")}</p>
              <p className="mt-3 text-xs text-muted">{t("landing.hr.note")}</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {HR_POINTS.map((k) => (
                <li key={k} className="flex gap-2 text-sm text-ink-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden /> <span>{t(k)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-2xl">{t("landing.how")}</h2>
          <ol className="mt-6 grid gap-6 sm:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s} className="border-t-2 border-teal pt-3">
                <span className="num text-xs text-muted">0{i + 1}</span>
                <p className="mt-1 font-medium">{t(s)}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
        {t("landing.footer")}
      </footer>
    </div>
  );
}
