import { ArrowRight, FileSearch, GitCompareArrows, ListChecks, ShieldCheck, Sparkles, Target } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/shell";

const FEATURES = [
  { icon: FileSearch, title: "Evidence-backed analysis", body: "Eight published rubric categories. Every deduction quotes the line in your resume that caused it." },
  { icon: Target, title: "Role fit you can audit", body: "Hybrid skill + semantic matching across a versioned role taxonomy. Shows the reasons, gaps and uncertainty." },
  { icon: ListChecks, title: "Requirement-by-requirement matching", body: "Paste a job description and see what is matched, partial, missing or simply not assessable from a resume." },
  { icon: Sparkles, title: "AI edits that cannot invent", body: "Suggestions are checked against your confirmed facts. New numbers, employers or skills are flagged and need your confirmation." },
  { icon: GitCompareArrows, title: "Versions and exports", body: "Append-only history, side-by-side comparison, and clean PDF/DOCX templates with visible placeholders." },
  { icon: ShieldCheck, title: "Private by default", body: "Encrypted storage, short-lived download links, contact details removed before any AI call, no training on your data." },
];

export default function Landing() {
  return (
    <div>
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Logo />
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link href="/login" className="btn btn-ghost">
            Sign in
          </Link>
          <Link href="/register" className="btn btn-primary">
            Create account
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-10 lg:grid-cols-[1.15fr_1fr] lg:pt-20">
          <div>
            <p className="eyebrow rise">Resume intelligence for students, graduates and professionals</p>
            <h1 className="rise rise-1 mt-3 text-4xl leading-[1.05] sm:text-6xl">
              Know what your resume <em className="text-teal not-italic underline decoration-ai-line decoration-4 underline-offset-8">actually</em> says.
            </h1>
            <p className="rise rise-2 mt-6 max-w-xl text-lg text-ink-2">
              Upload a PDF or Word resume. See which roles your evidence supports, what a job description is really asking for, and how to
              improve — without inventing a single qualification.
            </p>
            <div className="rise rise-3 mt-8 flex flex-wrap gap-3">
              <Link href="/register" className="btn btn-primary px-5 py-2.5 text-base">
                Analyse my resume <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="/login" className="btn btn-secondary px-5 py-2.5 text-base">
                I have an account
              </Link>
            </div>
            <p className="rise rise-4 mt-6 max-w-lg text-xs text-muted">
              Scores are advisory indicators with transparent rules. They are not ATS scores and do not predict interviews or hiring decisions.
            </p>
          </div>

          {/* specimen card: an annotated resume line */}
          <div className="rise rise-2 relative" aria-hidden>
            <div className="card rotate-[1.2deg] p-6">
              <p className="eyebrow">Experience · Bullet 2</p>
              <p className="mt-3 font-display text-lg leading-snug">
                <span className="bg-bad-soft line-through decoration-bad/60">Responsible for</span>{" "}
                <span className="bg-ok-soft">Automated</span> monthly reporting with Python and SQL
                <span className="bg-ai-soft text-ai"> [ADD: hours saved per month]</span>.
              </p>
              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                {[
                  ["Quantified", "0/1"],
                  ["Action verb", "fixed"],
                  ["New claims", "none"],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-md border border-line bg-paper px-2 py-2">
                    <p className="num text-sm font-semibold">{v}</p>
                    <p className="text-[11px] text-muted">{k}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="card absolute -bottom-8 -left-4 hidden w-60 -rotate-[2deg] p-4 sm:block">
              <p className="eyebrow">Role fit · relative</p>
              {[
                ["Data Analyst", 71],
                ["Data Scientist", 52],
                ["Data Engineer", 44],
              ].map(([r, s]) => (
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
                <h2 className="mt-3 text-lg">{title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-2xl">How it works</h2>
          <ol className="mt-6 grid gap-6 sm:grid-cols-4">
            {["Upload a PDF or DOCX", "Review & correct what we extracted", "Read the evidence-backed analysis", "Edit, tailor and export versions"].map((s, i) => (
              <li key={s} className="border-t-2 border-teal pt-3">
                <span className="num text-xs text-muted">0{i + 1}</span>
                <p className="mt-1 font-medium">{s}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
        Your uploads are encrypted, never used for model training by default, and can be exported or deleted at any time.
      </footer>
    </div>
  );
}
