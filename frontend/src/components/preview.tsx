import type { DiffOp, ResumeContent } from "@/lib/types";
import { SECTION_LABEL } from "./content-form";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmt(d: string | null) {
  if (!d) return "";
  const [y, m] = d.split("-");
  return m ? `${MON[Number(m) - 1]} ${y}` : y;
}
function range(s: string | null, e: string | null, cur = false) {
  const a = fmt(s);
  const b = cur ? "Present" : fmt(e);
  return a && b ? `${a} – ${b}` : a || b;
}

/** Renders text with [ADD: …] placeholders visibly highlighted. */
export function WithPlaceholders({ text }: { text: string }) {
  const parts = text.split(/(\[(?:ADD|TODO|CONFIRM)[^\]]*\])/gi);
  return (
    <>
      {parts.map((p, i) =>
        /^\[(ADD|TODO|CONFIRM)/i.test(p) ? (
          <mark key={i} className="rounded bg-[#fde68a] px-0.5 font-semibold text-[#92400e]" title="Unresolved placeholder — replace with a real fact or remove">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function ResumePreview({ c, template = "professional" }: { c: ResumeContent; template?: string }) {
  const serif = template === "professional";
  const accent = template === "student" ? "#1d4ed8" : template === "technical" ? "#0f766e" : "#111827";
  const upper = template !== "professional";
  return (
    <article
      aria-label="Resume preview"
      className="mx-auto w-full max-w-[640px] bg-white px-7 py-8 text-[12.5px] leading-[1.45] text-[#111] shadow-[0_2px_20px_-8px_#0004]"
      style={{ fontFamily: serif ? "Georgia, 'Times New Roman', serif" : "Arial, Helvetica, sans-serif" }}
    >
      <h2 className="text-[22px] font-bold" style={{ color: accent, fontFamily: "inherit", letterSpacing: 0 }}>
        {c.contact.name || <WithPlaceholders text="[ADD: your name]" />}
      </h2>
      <p className="text-[11px] text-[#374151]">
        {[c.contact.email, c.contact.phone, c.contact.location, ...c.contact.links.map((l) => l.url.replace(/^https?:\/\//, ""))].filter(Boolean).join("  |  ")}
      </p>
      {c.section_order.map((k) => {
        const body = sectionBody(c, k);
        if (!body) return null;
        return (
          <section key={k} className="mt-3">
            <h3 className="border-b pb-0.5 text-[13px] font-bold" style={{ color: accent, borderColor: accent, fontFamily: "inherit", letterSpacing: upper ? "0.04em" : 0 }}>
              {upper ? SECTION_LABEL[k].toUpperCase() : SECTION_LABEL[k]}
            </h3>
            <div className="mt-1">{body}</div>
          </section>
        );
      })}
    </article>
  );
}

function sectionBody(c: ResumeContent, k: string) {
  switch (k) {
    case "summary":
      return c.summary ? <p><WithPlaceholders text={c.summary} /></p> : null;
    case "experience":
      return c.experience.length ? (
        <div className="space-y-2">
          {c.experience.map((e) => (
            <div key={e.id}>
              <p className="font-bold">{[e.title, e.organization].filter(Boolean).join(" — ")}</p>
              <p className="text-[11px] italic text-[#4b5563]">{[range(e.start, e.end, e.current), e.location].filter(Boolean).join("  ·  ")}</p>
              <ul className="ml-4 list-disc">
                {e.bullets.map((b) => (
                  <li key={b.id}><WithPlaceholders text={b.text} /></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null;
    case "projects":
      return c.projects.length ? (
        <div className="space-y-2">
          {c.projects.map((p) => (
            <div key={p.id}>
              <p className="font-bold">
                {p.name}
                {p.technologies.length > 0 && <span className="font-normal"> ({p.technologies.join(", ")})</span>}
              </p>
              <ul className="ml-4 list-disc">
                {p.bullets.map((b) => (
                  <li key={b.id}><WithPlaceholders text={b.text} /></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null;
    case "education":
      return c.education.length ? (
        <div className="space-y-1">
          {c.education.map((e) => (
            <div key={e.id}>
              <p className="font-bold">{[e.degree, e.institution].filter(Boolean).join(", ")}</p>
              <p className="text-[11px] italic text-[#4b5563]">{[range(e.start, e.end), e.grade ? `Grade: ${e.grade}` : null].filter(Boolean).join("  ·  ")}</p>
            </div>
          ))}
        </div>
      ) : null;
    case "skills": {
      const s = c.skills;
      if (!s.technical.length && !s.soft.length && !s.other.length) return null;
      return (
        <div>
          {s.technical.length > 0 && <p><b>Technical:</b> {s.technical.join(", ")}</p>}
          {s.other.length > 0 && <p><b>Tools &amp; other:</b> {s.other.join(", ")}</p>}
          {s.soft.length > 0 && <p><b>Professional:</b> {s.soft.join(", ")}</p>}
        </div>
      );
    }
    case "certifications":
      return c.certifications.length ? (
        <ul className="ml-4 list-disc">{c.certifications.map((x) => <li key={x.id}>{[x.name, x.issuer, fmt(x.date)].filter(Boolean).join(" — ")}</li>)}</ul>
      ) : null;
    case "achievements":
      return c.achievements.length ? <ul className="ml-4 list-disc">{c.achievements.map((a) => <li key={a.id}><WithPlaceholders text={a.text} /></li>)}</ul> : null;
    case "languages":
      return c.languages.length ? <p>{c.languages.map((l) => `${l.name}${l.proficiency ? ` (${l.proficiency})` : ""}`).join(", ")}</p> : null;
  }
  return null;
}

export function DiffView({ ops }: { ops: DiffOp[] }) {
  return (
    <p className="text-sm leading-relaxed">
      {ops.map((o, i) =>
        o.op === "equal" ? (
          <span key={i}>{o.text}</span>
        ) : o.op === "delete" ? (
          <del key={i} className="rounded bg-bad-soft text-bad decoration-bad/60">
            <span className="sr-only">removed: </span>
            {o.text}
          </del>
        ) : (
          <ins key={i} className="rounded bg-ok-soft text-ok no-underline">
            <span className="sr-only">added: </span>
            {o.text}
          </ins>
        ),
      )}
    </p>
  );
}
