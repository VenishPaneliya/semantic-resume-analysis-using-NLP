"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useT, type MessageKey } from "@/lib/i18n";
import type { Bullet, EmploymentType, ResumeContent, SectionKey } from "@/lib/types";

/** English section headings. Used inside the resume itself (preview/exports stay English) and as the list of
    section keys. For interface labels use SECTION_LABEL_KEY with t(). */
export const SECTION_LABEL: Record<SectionKey, string> = {
  summary: "Summary",
  experience: "Experience",
  projects: "Projects",
  education: "Education",
  skills: "Skills",
  certifications: "Certifications",
  achievements: "Achievements",
  languages: "Languages",
};

export const SECTION_LABEL_KEY: Record<SectionKey, MessageKey> = {
  summary: "form.section.summary",
  experience: "form.section.experience",
  projects: "form.section.projects",
  education: "form.section.education",
  skills: "form.section.skills",
  certifications: "form.section.certifications",
  achievements: "form.section.achievements",
  languages: "form.section.languages",
};

const EMP_KEY: Record<string, MessageKey> = {
  full_time: "form.emp.full_time",
  part_time: "form.emp.part_time",
  internship: "form.emp.internship",
  contract: "form.emp.contract",
  freelance: "form.emp.freelance",
  unknown: "form.emp.unknown",
};

const newId = () => Math.random().toString(16).slice(2, 12);

export function emptyContent(): ResumeContent {
  return {
    contact: { name: null, email: null, phone: null, location: null, links: [] },
    summary: null, experience: [], education: [], projects: [],
    skills: { technical: [], soft: [], other: [] }, certifications: [], achievements: [], languages: [],
    section_order: ["summary", "experience", "projects", "education", "skills", "certifications", "achievements", "languages"],
  };
}

type Mut = (c: ResumeContent) => void;

interface Props {
  value: ResumeContent;
  onChange: (v: ResumeContent) => void;
  /** annotation rendered next to a field/entry (confidence, evidence, uncertainty) */
  note?: (path: string) => ReactNode;
  /** actions rendered under a bullet (AI tools in the editor) */
  bulletActions?: (path: string, bullet: Bullet) => ReactNode;
  summaryActions?: ReactNode;
  /** highlight a field that has a pending AI suggestion */
  highlight?: (path: string) => boolean;
  sections?: SectionKey[];
  idPrefix?: string;
}

export function ContentForm({ value, onChange, note, bulletActions, summaryActions, highlight, sections, idPrefix = "f" }: Props) {
  const t = useT();
  const c = value;
  const set = (fn: Mut) => {
    const next = structuredClone(c);
    fn(next);
    onChange(next);
  };
  const str = (v: string) => (v.trim() === "" ? null : v);
  const order = sections ?? c.section_order;
  const pid = (s: string) => `${idPrefix}-${s}`;

  const bullets = (list: Bullet[], basePath: string, mutList: (fn: (l: Bullet[]) => void) => void) => (
    <fieldset className="mt-3">
      <legend className="label">{t("form.bullets")}</legend>
      <ul className="space-y-2">
        {list.map((b, i) => {
          const path = `${basePath}/bullets/${b.id}`;
          return (
            <li key={b.id} className={highlight?.(path) ? "rounded-md ring-2 ring-ai-line" : ""}>
              <div className="flex items-start gap-2">
                <span className="mt-2.5 text-muted" aria-hidden>
                  •
                </span>
                <textarea
                  className="input min-h-[2.6rem] flex-1 resize-y"
                  rows={2}
                  aria-label={t("form.bulletN", { n: i + 1 })}
                  value={b.text}
                  onChange={(e) => mutList((l) => (l[i].text = e.target.value))}
                />
                <button type="button" className="btn btn-ghost btn-sm mt-1" aria-label={t("form.removeBullet", { n: i + 1 })} onClick={() => mutList((l) => l.splice(i, 1))}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {note?.(path)}
              {bulletActions && <div className="ml-5 mt-1">{bulletActions(path, b)}</div>}
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => mutList((l) => l.push({ id: newId(), text: "" }))}>
        <Plus className="h-4 w-4" aria-hidden /> {t("form.addBullet")}
      </button>
    </fieldset>
  );

  const entryShell = (title: string, path: string, onRemove: () => void, children: ReactNode, i: number, total: number, move: (d: -1 | 1) => void) => (
    <div className="rounded-lg border border-line bg-paper/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{title}</p>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(-1)} aria-label={t("form.moveUp", { name: title })}>
            <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={i === total - 1} onClick={() => move(1)} aria-label={t("form.moveDown", { name: title })}>
            <ArrowDown className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} aria-label={t("form.removeNamed", { name: title })}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      {note?.(path)}
      {children}
    </div>
  );

  function moveIn<T>(arr: T[], i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  const input = (id: string, label: string, val: string | null, on: (v: string) => void, opts: { hint?: string; type?: string; pattern?: string } = {}) => (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type={opts.type ?? "text"}
        value={val ?? ""}
        placeholder={opts.hint}
        pattern={opts.pattern}
        onChange={(e) => on(e.target.value)}
      />
    </div>
  );
  const dateInput = (id: string, label: string, val: string | null, on: (v: string | null) => void) =>
    input(id, label, val, (v) => on(str(v)), { hint: t("form.dateHint"), pattern: "\\d{4}(-\\d{2})?" });

  const blocks: Record<SectionKey, ReactNode> = {
    summary: (
      <div className={highlight?.("summary") ? "rounded-md ring-2 ring-ai-line" : ""}>
        <label className="label" htmlFor={pid("summary")}>
          {t("form.summary")}
        </label>
        <textarea id={pid("summary")} className="input min-h-24" rows={4} value={c.summary ?? ""} onChange={(e) => set((n) => (n.summary = str(e.target.value)))} />
        {note?.("summary")}
        {summaryActions}
      </div>
    ),
    experience: (
      <div className="space-y-4">
        {c.experience.map((e, i) => {
          const base = `experience/${e.id}`;
          return (
            <div key={e.id}>
              {entryShell(
                e.title || e.organization || t("form.roleN", { n: i + 1 }),
                base,
                () => set((n) => n.experience.splice(i, 1)),
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {input(pid(`${e.id}-title`), t("form.jobTitle"), e.title, (v) => set((n) => (n.experience[i].title = str(v))))}
                    {input(pid(`${e.id}-org`), t("form.org"), e.organization, (v) => set((n) => (n.experience[i].organization = str(v))))}
                    {dateInput(pid(`${e.id}-start`), t("form.start"), e.start, (v) => set((n) => (n.experience[i].start = v)))}
                    {dateInput(pid(`${e.id}-end`), t("form.end"), e.current ? null : e.end, (v) => set((n) => (n.experience[i].end = v)))}
                    {input(pid(`${e.id}-loc`), t("form.location"), e.location, (v) => set((n) => (n.experience[i].location = str(v))))}
                    <div>
                      <label className="label" htmlFor={pid(`${e.id}-type`)}>
                        {t("form.type")}
                      </label>
                      <select
                        id={pid(`${e.id}-type`)}
                        className="input"
                        value={e.employment_type}
                        onChange={(ev) => set((n) => (n.experience[i].employment_type = ev.target.value as EmploymentType))}
                      >
                        {["full_time", "part_time", "internship", "contract", "freelance", "unknown"].map((et) => (
                          <option key={et} value={et}>
                            {t(EMP_KEY[et])}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <label className="mt-3 inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={e.current} onChange={(ev) => set((n) => {
                      n.experience[i].current = ev.target.checked;
                      if (ev.target.checked) n.experience[i].end = null;
                    })} />
                    {t("form.currentJob")}
                  </label>
                  {note?.(`${base}/dates`)}
                  {note?.(`${base}/organization`)}
                  {bullets(e.bullets, base, (fn) => set((n) => fn(n.experience[i].bullets)))}
                </>,
                i,
                c.experience.length,
                (d) => set((n) => moveIn(n.experience, i, d)),
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() =>
            set((n) => n.experience.push({ id: newId(), title: null, organization: null, location: null, start: null, end: null, current: false, employment_type: "full_time", bullets: [] }))
          }
        >
          <Plus className="h-4 w-4" aria-hidden /> {t("form.addRole")}
        </button>
      </div>
    ),
    projects: (
      <div className="space-y-4">
        {c.projects.map((p, i) => {
          const base = `projects/${p.id}`;
          return (
            <div key={p.id}>
              {entryShell(
                p.name || t("form.projectN", { n: i + 1 }),
                base,
                () => set((n) => n.projects.splice(i, 1)),
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {input(pid(`${p.id}-name`), t("form.projectName"), p.name, (v) => set((n) => (n.projects[i].name = v)))}
                    {input(pid(`${p.id}-url`), t("form.link"), p.url, (v) => set((n) => (n.projects[i].url = str(v))))}
                    <div className="sm:col-span-2">
                      {input(pid(`${p.id}-tech`), t("form.tech"), p.technologies.join(", "), (v) =>
                        set((n) => (n.projects[i].technologies = v.split(",").map((x) => x.trim()).filter(Boolean))),
                      )}
                    </div>
                  </div>
                  {bullets(p.bullets, base, (fn) => set((n) => fn(n.projects[i].bullets)))}
                </>,
                i,
                c.projects.length,
                (d) => set((n) => moveIn(n.projects, i, d)),
              )}
            </div>
          );
        })}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => set((n) => n.projects.push({ id: newId(), name: "New project", url: null, start: null, end: null, technologies: [], bullets: [] }))}>
          <Plus className="h-4 w-4" aria-hidden /> {t("form.addProject")}
        </button>
      </div>
    ),
    education: (
      <div className="space-y-4">
        {c.education.map((ed, i) => {
          const base = `education/${ed.id}`;
          return (
            <div key={ed.id}>
              {entryShell(
                ed.degree || ed.institution || t("form.educationN", { n: i + 1 }),
                base,
                () => set((n) => n.education.splice(i, 1)),
                <div className="grid gap-3 sm:grid-cols-2">
                  {input(pid(`${ed.id}-deg`), t("form.degree"), ed.degree, (v) => set((n) => (n.education[i].degree = str(v))))}
                  {input(pid(`${ed.id}-field`), t("form.field"), ed.field_of_study, (v) => set((n) => (n.education[i].field_of_study = str(v))))}
                  {input(pid(`${ed.id}-inst`), t("form.institution"), ed.institution, (v) => set((n) => (n.education[i].institution = str(v))))}
                  {input(pid(`${ed.id}-grade`), t("form.grade"), ed.grade, (v) => set((n) => (n.education[i].grade = str(v))))}
                  {dateInput(pid(`${ed.id}-start`), t("form.start"), ed.start, (v) => set((n) => (n.education[i].start = v)))}
                  {dateInput(pid(`${ed.id}-end`), t("form.end"), ed.end, (v) => set((n) => (n.education[i].end = v)))}
                </div>,
                i,
                c.education.length,
                (d) => set((n) => moveIn(n.education, i, d)),
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => set((n) => n.education.push({ id: newId(), degree: null, field_of_study: null, institution: null, location: null, start: null, end: null, grade: null, details: [] }))}
        >
          <Plus className="h-4 w-4" aria-hidden /> {t("form.addEducation")}
        </button>
      </div>
    ),
    skills: (
      <div className="grid gap-3">
        {(["technical", "soft", "other"] as const).map((k) => (
          <div key={k}>
            <label className="label" htmlFor={pid(`skills-${k}`)}>
              {t(k === "technical" ? "form.skills.technical" : k === "soft" ? "form.skills.soft" : "form.skills.other")}
            </label>
            <textarea
              id={pid(`skills-${k}`)}
              className="input"
              rows={2}
              value={c.skills[k].join(", ")}
              onChange={(e) => set((n) => (n.skills[k] = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)))}
            />
          </div>
        ))}
        {note?.("skills")}
      </div>
    ),
    certifications: (
      <div className="space-y-2">
        {c.certifications.map((ce, i) => (
          <div key={ce.id} className="grid items-end gap-2 sm:grid-cols-[2fr_1.3fr_1fr_auto]">
            {input(pid(`${ce.id}-name`), t("form.cert"), ce.name, (v) => set((n) => (n.certifications[i].name = v)))}
            {input(pid(`${ce.id}-iss`), t("form.issuer"), ce.issuer, (v) => set((n) => (n.certifications[i].issuer = str(v))))}
            {dateInput(pid(`${ce.id}-date`), t("form.date"), ce.date, (v) => set((n) => (n.certifications[i].date = v)))}
            <button type="button" className="btn btn-ghost btn-sm mb-1" aria-label={t("form.removeCert")} onClick={() => set((n) => n.certifications.splice(i, 1))}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => set((n) => n.certifications.push({ id: newId(), name: "", issuer: null, date: null, url: null }))}>
          <Plus className="h-4 w-4" aria-hidden /> {t("form.addCert")}
        </button>
      </div>
    ),
    achievements: (
      <div className="space-y-2">
        {c.achievements.map((a, i) => (
          <div key={a.id} className="flex items-start gap-2">
            <textarea className="input flex-1" rows={2} aria-label={t("form.achievementN", { n: i + 1 })} value={a.text} onChange={(e) => set((n) => (n.achievements[i].text = e.target.value))} />
            <button type="button" className="btn btn-ghost btn-sm" aria-label={t("form.removeAch")} onClick={() => set((n) => n.achievements.splice(i, 1))}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => set((n) => n.achievements.push({ id: newId(), text: "" }))}>
          <Plus className="h-4 w-4" aria-hidden /> {t("form.addAch")}
        </button>
      </div>
    ),
    languages: (
      <div className="space-y-2">
        {c.languages.map((l, i) => (
          <div key={l.id} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            {input(pid(`${l.id}-name`), t("form.language"), l.name, (v) => set((n) => (n.languages[i].name = v)))}
            {input(pid(`${l.id}-prof`), t("form.proficiency"), l.proficiency, (v) => set((n) => (n.languages[i].proficiency = str(v))))}
            <button type="button" className="btn btn-ghost btn-sm mb-1" aria-label={t("form.removeLang")} onClick={() => set((n) => n.languages.splice(i, 1))}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => set((n) => n.languages.push({ id: newId(), name: "", proficiency: null }))}>
          <Plus className="h-4 w-4" aria-hidden /> {t("form.addLang")}
        </button>
      </div>
    ),
  };

  return (
    <div className="space-y-5">
      <fieldset className="card p-5">
        <legend className="sr-only">{t("form.contact")}</legend>
        <h3 className="mb-3 text-lg">{t("form.contact")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["name", "email", "phone", "location"] as const).map((k) => (
            <div key={k}>
              {input(pid(`contact-${k}`), t(`form.contact.${k}` as const), c.contact[k], (v) => set((n) => (n.contact[k] = str(v))), { type: k === "email" ? "email" : "text" })}
              {note?.(`contact.${k}`)}
            </div>
          ))}
          <div className="sm:col-span-2">
            {input(pid("contact-links"), t("form.links"), c.contact.links.map((l) => l.url).join(", "), (v) =>
              set((n) => (n.contact.links = v.split(",").map((u) => u.trim()).filter(Boolean).map((url) => ({ label: /linkedin/i.test(url) ? "LinkedIn" : /github/i.test(url) ? "GitHub" : "Website", url })))),
            )}
          </div>
        </div>
      </fieldset>
      {order.map((k) => (
        <fieldset key={k} className="card p-5">
          <legend className="sr-only">{t(SECTION_LABEL_KEY[k])}</legend>
          <h3 className="mb-3 text-lg">{t(SECTION_LABEL_KEY[k])}</h3>
          {note?.(`section:${k}`)}
          {blocks[k]}
        </fieldset>
      ))}
    </div>
  );
}
