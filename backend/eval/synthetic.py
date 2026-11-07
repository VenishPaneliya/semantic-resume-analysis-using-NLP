"""Render synthetic personas into resume documents in several layouts.

Layouts (exercise parser robustness, not visual design):
  A — CAPS headings, "•" bullets, "Title | Org" + date line          (PDF)
  B — Title-case headings with colons, "-" bullets, "Org — Title (dates)" (PDF)
  C — Word document using heading/list styles                       (DOCX)

Every rendered document carries the persona's ground-truth content so extraction can be
scored field by field. SYNTHETIC DATA — see data/synthetic/personas_v1.json notice.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PERSONAS = ROOT / "data" / "synthetic" / "personas_v1.json"
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def load() -> dict:
    return json.loads(PERSONAS.read_text(encoding="utf-8"))


def _d(d: str | None) -> str:
    if not d:
        return ""
    p = d.split("-")
    return f"{MON[int(p[1]) - 1]} {p[0]}" if len(p) == 2 else p[0]


def _rng(s, e, cur=False) -> str:
    return f"{_d(s)} – {'Present' if cur else _d(e)}" if s else _d(e)


def render_text(c: dict, layout: str = "A") -> str:
    up = (lambda t: t.upper()) if layout == "A" else (lambda t: t + ":")
    bul = "•" if layout == "A" else "-"
    ct = c["contact"]
    out = [ct["name"]]
    bits = [x for x in [ct.get("location"), ct.get("email"), ct.get("phone")] if x] + [lnk["url"].replace("https://", "") for lnk in ct.get("links", [])]
    out.append(" | ".join(bits))
    out.append("")
    if c.get("summary"):
        out += [up("Summary"), c["summary"], ""]
    if c.get("experience"):
        out.append(up("Experience"))
        for e in c["experience"]:
            if layout == "A":
                out.append(f"{e['title']} | {e['organization']}")
                out.append(_rng(e.get("start"), e.get("end"), e.get("current", False)))
            else:
                out.append(f"{e['organization']} — {e['title']} ({_rng(e.get('start'), e.get('end'), e.get('current', False))})")
            out += [f"{bul} {b}" for b in e["bullets"]]
        out.append("")
    if c.get("projects"):
        out.append(up("Projects"))
        for p in c["projects"]:
            out.append(f"{p['name']} | {', '.join(p.get('technologies', []))}")
            out += [f"{bul} {b}" for b in p["bullets"]]
        out.append("")
    if c.get("education"):
        out.append(up("Education"))
        for ed in c["education"]:
            line = f"{ed['degree']}, {ed['institution']}, {_rng(ed.get('start'), ed.get('end'))}"
            if ed.get("grade"):
                line += f", CGPA: {ed['grade']}"
            out.append(line)
        out.append("")
    sk = c["skills"]
    if sk["technical"] or sk["soft"]:
        out.append(up("Skills"))
        if sk["technical"]:
            out.append("Technical: " + ", ".join(sk["technical"]))
        if sk["soft"]:
            out.append("Professional: " + ", ".join(sk["soft"]))
        out.append("")
    if c.get("certifications"):
        out.append(up("Certifications"))
        out += [f"{bul} {x['name']} - {x['issuer']}, {x['date']}" for x in c["certifications"]]
        out.append("")
    if c.get("achievements"):
        out.append(up("Achievements"))
        out += [f"{bul} {a['text']}" for a in c["achievements"]]
        out.append("")
    if c.get("languages"):
        out.append(up("Languages"))
        out.append(", ".join(f"{lang['name']} ({lang['proficiency']})" if lang.get("proficiency") else lang["name"] for lang in c["languages"]))
    return "\n".join(out).strip() + "\n"


def text_to_pdf(text: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    cv = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    y = h - 50
    for line in text.split("\n"):
        while len(line) > 105:
            cut = line.rfind(" ", 0, 105)
            cv.setFont("Helvetica", 10)
            cv.drawString(45, y, line[:cut])
            line = "  " + line[cut + 1:]
            y -= 13
        cv.setFont("Helvetica-Bold" if line.isupper() and line.strip() else "Helvetica", 10)
        cv.drawString(45, y, line)
        y -= 13
        if y < 50:
            cv.showPage()
            y = h - 50
    cv.save()
    return buf.getvalue()


def content_to_docx(c: dict) -> bytes:
    from docx import Document

    doc = Document()
    doc.add_paragraph(c["contact"]["name"])
    ct = c["contact"]
    doc.add_paragraph(" | ".join(x for x in [ct.get("location"), ct.get("email"), ct.get("phone")] if x))
    if c.get("summary"):
        doc.add_heading("Summary", level=1)
        doc.add_paragraph(c["summary"])
    if c.get("experience"):
        doc.add_heading("Work Experience", level=1)
        for e in c["experience"]:
            doc.add_paragraph(f"{e['title']} | {e['organization']}")
            doc.add_paragraph(_rng(e.get("start"), e.get("end"), e.get("current", False)))
            for b in e["bullets"]:
                doc.add_paragraph(b, style="List Bullet")
    if c.get("projects"):
        doc.add_heading("Projects", level=1)
        for p in c["projects"]:
            doc.add_paragraph(f"{p['name']} | {', '.join(p.get('technologies', []))}")
            for b in p["bullets"]:
                doc.add_paragraph(b, style="List Bullet")
    if c.get("education"):
        doc.add_heading("Education", level=1)
        for ed in c["education"]:
            doc.add_paragraph(f"{ed['degree']}, {ed['institution']}, {_rng(ed.get('start'), ed.get('end'))}")
    sk = c["skills"]
    if sk["technical"]:
        doc.add_heading("Technical Skills", level=1)
        doc.add_paragraph(", ".join(sk["technical"] + sk["soft"]))
    if c.get("certifications"):
        doc.add_heading("Certifications", level=1)
        for x in c["certifications"]:
            doc.add_paragraph(f"{x['name']} - {x['issuer']}, {x['date']}", style="List Bullet")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def render(persona: dict, layout: str) -> tuple[str, bytes]:
    """Returns (file kind, bytes)."""
    c = persona["content"]
    if layout == "C":
        return "docx", content_to_docx(c)
    return "pdf", text_to_pdf(render_text(c, layout))


if __name__ == "__main__":
    out = ROOT / "var" / "synthetic"
    out.mkdir(parents=True, exist_ok=True)
    for p in load()["personas"]:
        for layout in ("A", "B", "C"):
            kind, data = render(p, layout)
            (out / f"{p['id']}_{layout}.{kind}").write_bytes(data)
    print(f"Wrote synthetic documents to {out}")
