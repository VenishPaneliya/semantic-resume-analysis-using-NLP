"""PDF (ReportLab) and DOCX (python-docx) rendering.

- Text is real text (selectable/extractable), never rasterised.
- PDF metadata (title, author, subject, language) is set for assistive technology.
- Entry headings are kept with their first bullets across page breaks.
- Unresolved [ADD: …] placeholders are visibly highlighted and returned to the caller.
- Section order is the user's saved order; templates control typography only.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from xml.sax.saxutils import escape

from app.schemas.resume import ResumeContent
from app.services.llm.grounding import PLACEHOLDER_RE

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@dataclass(frozen=True)
class Template:
    id: str
    name: str
    description: str
    body_font: str
    bold_font: str
    italic_font: str
    accent: str  # hex
    base_size: float
    heading_case_upper: bool
    recommended_order: tuple[str, ...]


TEMPLATES: dict[str, Template] = {
    "student": Template("student", "Fresher / Student", "Education and projects first; clean sans-serif with a blue accent.",
                        "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "#1d4ed8", 10.5, True,
                        ("summary", "education", "projects", "experience", "skills", "certifications", "achievements", "languages")),
    "professional": Template("professional", "Experienced Professional", "Experience-led, classic serif typography.",
                             "Times-Roman", "Times-Bold", "Times-Italic", "#111827", 11, False,
                             ("summary", "experience", "skills", "education", "certifications", "achievements", "projects", "languages")),
    "technical": Template("technical", "Technical Specialist", "Skills summary up front, dense layout, teal accent.",
                          "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "#0f766e", 10, True,
                          ("summary", "skills", "experience", "projects", "education", "certifications", "achievements", "languages")),
}

SECTION_TITLES = {"summary": "Summary", "experience": "Experience", "projects": "Projects", "education": "Education",
                  "skills": "Skills", "certifications": "Certifications", "achievements": "Achievements", "languages": "Languages"}


def fmt_date(d: str | None) -> str:
    if not d:
        return ""
    parts = d.split("-")
    return f"{MONTHS[int(parts[1]) - 1]} {parts[0]}" if len(parts) == 2 else parts[0]


def date_range(start: str | None, end: str | None, current: bool = False) -> str:
    s, e = fmt_date(start), ("Present" if current else fmt_date(end))
    return f"{s} – {e}" if s and e else s or e


def find_placeholders(c: ResumeContent) -> list[dict]:
    found = []
    def scan(path, text):
        for m in PLACEHOLDER_RE.finditer(text or ""):
            found.append({"path": path, "placeholder": m.group(0)})
    scan("summary", c.summary)
    for path, _o, t in c.all_bullets():
        scan(path, t)
    for a in c.achievements:
        scan(f"achievements/{a.id}", a.text)
    return found


# ---------------------------------------------------------------- PDF


def render_pdf(c: ResumeContent, template_id: str, page_size: str) -> tuple[bytes, int]:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4, LETTER
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable,
        KeepTogether,
        ListFlowable,
        ListItem,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
    )

    t = TEMPLATES[template_id]
    size = A4 if page_size == "A4" else LETTER
    accent = colors.HexColor(t.accent)
    buf = io.BytesIO()
    pages = {"n": 0}

    def on_page(canvas, doc):
        pages["n"] = doc.page

    doc = SimpleDocTemplate(
        buf, pagesize=size, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=14 * mm, bottomMargin=14 * mm,
        title=f"Resume – {c.contact.name or 'Candidate'}", author=c.contact.name or "", subject="Resume",
        creator="Resume Intelligence", lang="en",
    )
    bs = t.base_size
    st = {
        "name": ParagraphStyle("name", fontName=t.bold_font, fontSize=bs + 9, leading=bs + 12, textColor=accent, alignment=TA_LEFT),
        "contact": ParagraphStyle("contact", fontName=t.body_font, fontSize=bs - 1, leading=bs + 2, textColor=colors.HexColor("#374151")),
        "h": ParagraphStyle("h", fontName=t.bold_font, fontSize=bs + 1.5, leading=bs + 4, textColor=accent, spaceBefore=8, spaceAfter=2),
        "entry": ParagraphStyle("entry", fontName=t.bold_font, fontSize=bs, leading=bs + 3),
        "meta": ParagraphStyle("meta", fontName=t.italic_font, fontSize=bs - 0.5, leading=bs + 2.5, textColor=colors.HexColor("#4b5563")),
        "body": ParagraphStyle("body", fontName=t.body_font, fontSize=bs, leading=bs + 3.2),
        "bullet": ParagraphStyle("bullet", fontName=t.body_font, fontSize=bs, leading=bs + 3),
    }

    def P(text: str, style: str = "body") -> Paragraph:  # noqa: N802
        safe = escape(text or "")
        safe = PLACEHOLDER_RE.sub(lambda m: f'<font backColor="#fde68a" color="#92400e"><b>{m.group(0)}</b></font>', safe)
        return Paragraph(safe, st[style])

    def heading(key: str):
        title = SECTION_TITLES[key]
        return [Paragraph(escape(title.upper() if t.heading_case_upper else title), st["h"]),
                HRFlowable(width="100%", thickness=0.6, color=accent, spaceBefore=0, spaceAfter=3)]

    def bullets(items: list[str]):
        if not items:
            return []
        return [ListFlowable([ListItem(P(x, "bullet"), leftIndent=10, value="•") for x in items],
                             bulletType="bullet", start="•", leftIndent=10, bulletFontSize=bs - 1)]

    story: list = []
    story.append(P(c.contact.name or "[ADD: your name]", "name"))
    contact_bits = [x for x in [c.contact.email, c.contact.phone, c.contact.location] if x] + [lnk.url.replace("https://", "") for lnk in c.contact.links]
    if contact_bits:
        story.append(P("  |  ".join(contact_bits), "contact"))
    story.append(Spacer(1, 4))

    for key in c.section_order:
        block: list = []
        if key == "summary" and c.summary:
            block = [*heading(key), P(c.summary)]
        elif key == "experience" and c.experience:
            block = heading(key)
            for e in c.experience:
                head = [P(" — ".join(x for x in [e.title, e.organization] if x) or "Role", "entry"),
                        P("  ·  ".join(x for x in [date_range(e.start, e.end, e.current), e.location] if x), "meta")]
                bl = bullets([b.text for b in e.bullets])
                # keep heading with first bullet block so it never orphans at a page bottom
                block.append(KeepTogether(head + bl[:1]))
                block += bl[1:]
                block.append(Spacer(1, 3))
        elif key == "projects" and c.projects:
            block = heading(key)
            for p in c.projects:
                head = [P(p.name + (f"  ({', '.join(p.technologies)})" if p.technologies else ""), "entry")]
                meta = "  ·  ".join(x for x in [date_range(p.start, p.end), (p.url or "").replace("https://", "")] if x)
                if meta:
                    head.append(P(meta, "meta"))
                bl = bullets([b.text for b in p.bullets])
                block.append(KeepTogether(head + bl[:1]))
                block += bl[1:]
                block.append(Spacer(1, 3))
        elif key == "education" and c.education:
            block = heading(key)
            for ed in c.education:
                line = ", ".join(x for x in [ed.degree, ed.institution] if x)
                meta = "  ·  ".join(x for x in [date_range(ed.start, ed.end), ed.location, f"Grade: {ed.grade}" if ed.grade else None] if x)
                block.append(KeepTogether([P(line, "entry"), *( [P(meta, "meta")] if meta else []), *bullets(ed.details)]))
        elif key == "skills" and (c.skills.technical or c.skills.soft or c.skills.other):
            block = heading(key)
            if c.skills.technical:
                block.append(Paragraph(f"<b>Technical:</b> {escape(', '.join(c.skills.technical))}", st["body"]))
            if c.skills.other:
                block.append(Paragraph(f"<b>Tools &amp; other:</b> {escape(', '.join(c.skills.other))}", st["body"]))
            if c.skills.soft:
                block.append(Paragraph(f"<b>Professional:</b> {escape(', '.join(c.skills.soft))}", st["body"]))
        elif key == "certifications" and c.certifications:
            block = heading(key) + bullets([" — ".join(x for x in [ce.name, ce.issuer, fmt_date(ce.date)] if x) for ce in c.certifications])
        elif key == "achievements" and c.achievements:
            block = heading(key) + bullets([a.text for a in c.achievements])
        elif key == "languages" and c.languages:
            block = [*heading(key), P(", ".join(f"{lang.name}{f' ({lang.proficiency})' if lang.proficiency else ''}" for lang in c.languages))]
        story += block

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue(), pages["n"]


# ---------------------------------------------------------------- DOCX


def render_docx(c: ResumeContent, template_id: str, page_size: str) -> bytes:
    from docx import Document
    from docx.enum.text import WD_COLOR_INDEX
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt, RGBColor

    t = TEMPLATES[template_id]
    doc = Document()
    sec = doc.sections[0]
    if page_size == "A4":
        sec.page_width, sec.page_height = Mm(210), Mm(297)
    else:
        sec.page_width, sec.page_height = Mm(215.9), Mm(279.4)
    for side in ("left_margin", "right_margin"):
        setattr(sec, side, Mm(16))
    sec.top_margin = sec.bottom_margin = Mm(14)
    font_name = "Times New Roman" if t.body_font.startswith("Times") else "Arial"
    normal = doc.styles["Normal"]
    normal.font.name = font_name
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), font_name)
    normal.font.size = Pt(t.base_size)
    accent = RGBColor.from_string(t.accent.lstrip("#").upper())
    doc.core_properties.title = f"Resume – {c.contact.name or 'Candidate'}"
    doc.core_properties.author = c.contact.name or ""
    doc.core_properties.subject = "Resume"
    doc.core_properties.language = "en"

    def add_runs(par, text: str, bold=False, italic=False, size=None, color=None):
        pos = 0
        for m in PLACEHOLDER_RE.finditer(text or ""):
            if m.start() > pos:
                r = par.add_run(text[pos:m.start()])
                r.bold, r.italic = bold, italic
                if size:
                    r.font.size = Pt(size)
                if color:
                    r.font.color.rgb = color
            r = par.add_run(m.group(0))
            r.bold = True
            r.font.highlight_color = WD_COLOR_INDEX.YELLOW
            pos = m.end()
        if pos < len(text or ""):
            r = par.add_run(text[pos:])
            r.bold, r.italic = bold, italic
            if size:
                r.font.size = Pt(size)
            if color:
                r.font.color.rgb = color
        return par

    def heading(key):
        h = doc.add_heading(level=1)
        title = SECTION_TITLES[key]
        add_runs(h, title.upper() if t.heading_case_upper else title, bold=True, size=t.base_size + 1.5, color=accent)
        h.paragraph_format.space_before = Pt(8)
        h.paragraph_format.space_after = Pt(2)
        h.paragraph_format.keep_with_next = True

    def bullet(text):
        p = doc.add_paragraph(style="List Bullet")
        add_runs(p, text)
        p.paragraph_format.space_after = Pt(1)

    def entry(title: str, meta: str):
        p = doc.add_paragraph()
        add_runs(p, title, bold=True)
        p.paragraph_format.keep_with_next = True
        p.paragraph_format.space_after = Pt(0)
        if meta:
            m = doc.add_paragraph()
            add_runs(m, meta, italic=True, size=t.base_size - 0.5)
            m.paragraph_format.keep_with_next = True
            m.paragraph_format.space_after = Pt(1)

    name = doc.add_paragraph()
    add_runs(name, c.contact.name or "[ADD: your name]", bold=True, size=t.base_size + 9, color=accent)
    bits = [x for x in [c.contact.email, c.contact.phone, c.contact.location] if x] + [lnk.url.replace("https://", "") for lnk in c.contact.links]
    if bits:
        add_runs(doc.add_paragraph(), "  |  ".join(bits), size=t.base_size - 1)

    for key in c.section_order:
        if key == "summary" and c.summary:
            heading(key)
            add_runs(doc.add_paragraph(), c.summary)
        elif key == "experience" and c.experience:
            heading(key)
            for e in c.experience:
                entry(" — ".join(x for x in [e.title, e.organization] if x) or "Role",
                      "  ·  ".join(x for x in [date_range(e.start, e.end, e.current), e.location] if x))
                for b in e.bullets:
                    bullet(b.text)
        elif key == "projects" and c.projects:
            heading(key)
            for p in c.projects:
                entry(p.name + (f"  ({', '.join(p.technologies)})" if p.technologies else ""),
                      "  ·  ".join(x for x in [date_range(p.start, p.end), (p.url or "").replace("https://", "")] if x))
                for b in p.bullets:
                    bullet(b.text)
        elif key == "education" and c.education:
            heading(key)
            for ed in c.education:
                entry(", ".join(x for x in [ed.degree, ed.institution] if x),
                      "  ·  ".join(x for x in [date_range(ed.start, ed.end), ed.location, f"Grade: {ed.grade}" if ed.grade else None] if x))
                for d in ed.details:
                    bullet(d)
        elif key == "skills" and (c.skills.technical or c.skills.soft or c.skills.other):
            heading(key)
            for label, items in (("Technical", c.skills.technical), ("Tools & other", c.skills.other), ("Professional", c.skills.soft)):
                if items:
                    p = doc.add_paragraph()
                    add_runs(p, f"{label}: ", bold=True)
                    add_runs(p, ", ".join(items))
        elif key == "certifications" and c.certifications:
            heading(key)
            for ce in c.certifications:
                bullet(" — ".join(x for x in [ce.name, ce.issuer, fmt_date(ce.date)] if x))
        elif key == "achievements" and c.achievements:
            heading(key)
            for a in c.achievements:
                bullet(a.text)
        elif key == "languages" and c.languages:
            heading(key)
            add_runs(doc.add_paragraph(), ", ".join(f"{lang.name}{f' ({lang.proficiency})' if lang.proficiency else ''}" for lang in c.languages))
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def safe_filename(name: str | None, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", (name or "resume").strip())[:60].strip("_") or "resume"
    return f"{base}_resume.{ext}"
