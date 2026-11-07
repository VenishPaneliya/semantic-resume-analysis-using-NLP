"""Document text extraction. Returns text with page offsets and *measured* layout
properties only (fonts and sizes reported by the PDF, page sizes, text-layer presence).
Visual layout is never inferred from text."""

from __future__ import annotations

import io
import re
from collections import Counter
from typing import Any

from app.versions import PARSER_VERSION


class ParseError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


_WS = re.compile(r"[ \t ]+")


_CID = re.compile(r"\(cid:\d+\)")


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # glyphs without a Unicode mapping (very often bullet symbols) are emitted as "(cid:N)"
    text = _CID.sub("•", text)
    text = text.replace("•", "•").replace("", "•").replace("●", "•").replace("▪", "•")
    lines = [_WS.sub(" ", ln).strip() for ln in text.split("\n")]
    out: list[str] = []
    for ln in lines:
        if not ln and out and not out[-1]:
            continue
        out.append(ln)
    return "\n".join(out).strip()


def parse_pdf(data: bytes, ocr_enabled: bool = False, tesseract_cmd: str | None = None) -> dict[str, Any]:
    import pdfplumber

    pages_out: list[dict] = []
    fonts: Counter[str] = Counter()
    sizes: Counter[float] = Counter()
    page_sizes: list[list[float]] = []
    images_per_page: list[int] = []
    warnings: list[str] = []
    try:
        pdf = pdfplumber.open(io.BytesIO(data), password="")
    except Exception as exc:
        raise ParseError("corrupted_pdf", "The PDF could not be opened.") from exc
    with pdf:
        for i, page in enumerate(pdf.pages, start=1):
            try:
                txt = page.extract_text(x_tolerance=1.5, y_tolerance=3) or ""
            except Exception:
                txt = ""
                warnings.append(f"page_{i}_text_extraction_failed")
            for ch in page.chars[:20000]:
                fn = str(ch.get("fontname", ""))
                fonts[fn.split("+")[-1]] += 1
                sizes[round(float(ch.get("size", 0)), 1)] += 1
            page_sizes.append([round(float(page.width), 1), round(float(page.height), 1)])
            images_per_page.append(len(page.images))
            pages_out.append({"page": i, "text": _clean(txt)})

    ocr_used = False
    total_chars = sum(len(p["text"]) for p in pages_out)
    if total_chars < 40:
        if ocr_enabled:
            pages_out = _ocr_pdf(data, tesseract_cmd)
            ocr_used = True
            warnings.append("ocr_used_text_may_contain_errors")
            if sum(len(p["text"]) for p in pages_out) < 40:
                raise ParseError("empty_text", "No readable text was found, even with OCR.")
        elif any(images_per_page):
            raise ParseError(
                "scanned_pdf",
                "This PDF appears to be a scanned image with no text layer. Enable OCR or upload a text-based PDF.",
            )
        else:
            raise ParseError("empty_text", "No readable text was found in this PDF.")

    text, offsets = _join_pages(pages_out)
    layout = {
        "source": "pdf",
        "page_count": len(pages_out),
        "page_sizes_pt": page_sizes,
        "has_text_layer": not ocr_used,
        "fonts": [{"name": n, "chars": c} for n, c in fonts.most_common(8)],
        "distinct_font_count": len(fonts),
        "font_sizes_pt": sorted(sizes.keys())[:30],
        "body_font_size_pt": sizes.most_common(1)[0][0] if sizes else None,
        "images_per_page": images_per_page,
        "chars_per_page": [len(p["text"]) for p in pages_out],
    }
    return {
        "kind": "pdf",
        "text": text,
        "pages": offsets,
        "layout": layout,
        "warnings": warnings,
        "ocr_used": ocr_used,
        "parser_version": PARSER_VERSION,
    }


def _ocr_pdf(data: bytes, tesseract_cmd: str | None) -> list[dict]:  # pragma: no cover - needs tesseract
    try:
        import pytesseract
        from pdf2image import convert_from_bytes
    except ImportError as exc:
        raise ParseError("ocr_unavailable", "OCR is enabled but OCR dependencies are not installed.") from exc
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
    images = convert_from_bytes(data, dpi=250, fmt="png")
    return [{"page": i, "text": _clean(pytesseract.image_to_string(img))} for i, img in enumerate(images, start=1)]


def parse_docx(data: bytes) -> dict[str, Any]:
    from docx import Document

    try:
        doc = Document(io.BytesIO(data))
    except Exception as exc:
        raise ParseError("corrupted_docx", "The DOCX file could not be opened.") from exc

    lines: list[str] = []
    fonts: Counter[str] = Counter()
    sizes: Counter[float] = Counter()
    heading_styles = 0
    # body in document order, including tables (common in resume templates)
    body = doc.element.body
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    for child in body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            p = Paragraph(child, doc)
            t = p.text
            style = (p.style.name if p.style is not None else "") or ""
            if style.lower().startswith(("heading", "title")):
                heading_styles += 1
            if style.lower().startswith("list") and t.strip():
                t = "• " + t
            lines.append(t)
            for r in p.runs:
                if r.font.name:
                    fonts[r.font.name] += len(r.text)
                if r.font.size:
                    sizes[round(r.font.size.pt, 1)] += len(r.text)
        elif tag == "tbl":
            tbl = Table(child, doc)
            for row in tbl.rows:
                seen = set()
                cells = []
                for c in row.cells:
                    if id(c._tc) in seen:
                        continue
                    seen.add(id(c._tc))
                    cells.append(c.text.strip())
                lines.append(" | ".join(x for x in cells if x))
    header_text = []
    for sec in doc.sections:
        for p in sec.header.paragraphs:
            if p.text.strip():
                header_text.append(p.text.strip())
    if header_text:
        lines = header_text + [""] + lines

    text = _clean("\n".join(lines))
    if len(text) < 40:
        raise ParseError("empty_text", "No readable text was found in this document.")
    layout = {
        "source": "docx",
        "page_count": None,  # DOCX has no fixed pagination; we do not guess
        "has_text_layer": True,
        "fonts": [{"name": n, "chars": c} for n, c in fonts.most_common(8)],
        "distinct_font_count": len(fonts),
        "font_sizes_pt": sorted(sizes.keys())[:30],
        "body_font_size_pt": sizes.most_common(1)[0][0] if sizes else None,
        "heading_style_paragraphs": heading_styles,
        "tables": len(doc.tables),
        "content_in_header": bool(header_text),
    }
    return {
        "kind": "docx",
        "text": text,
        "pages": [{"page": None, "char_start": 0, "char_end": len(text)}],
        "layout": layout,
        "warnings": ["content_in_page_header"] if header_text else [],
        "ocr_used": False,
        "parser_version": PARSER_VERSION,
    }


def _join_pages(pages: list[dict]) -> tuple[str, list[dict]]:
    parts: list[str] = []
    offsets: list[dict] = []
    cursor = 0
    for p in pages:
        if parts:
            parts.append("\n\n")
            cursor += 2
        start = cursor
        parts.append(p["text"])
        cursor += len(p["text"])
        offsets.append({"page": p["page"], "char_start": start, "char_end": cursor})
    return "".join(parts), offsets


def parse_document(kind: str, data: bytes, ocr_enabled: bool = False, tesseract_cmd: str | None = None) -> dict:
    if kind == "pdf":
        return parse_pdf(data, ocr_enabled, tesseract_cmd)
    if kind == "docx":
        return parse_docx(data)
    raise ParseError("unsupported_type", f"Unsupported document type: {kind}")
