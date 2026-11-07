"""Upload validation: extension, declared MIME, magic bytes, size, page count, encryption,
and DOCX container safety (zip bombs, macros, path traversal). Files are never executed;
these checks reject inputs that are malformed or designed to exhaust resources."""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

from app.config import get_settings

PDF_MIMES = {"application/pdf", "application/x-pdf"}
DOCX_MIMES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    # some browsers send a generic type for docx; magic-byte checks still apply
    "application/octet-stream",
    "application/zip",
}


class UploadRejected(Exception):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class ValidatedUpload:
    kind: str  # pdf | docx
    mime_type: str
    size: int
    page_count: int | None
    warnings: list[str]


def validate_upload(filename: str, declared_mime: str | None, data: bytes) -> ValidatedUpload:
    s = get_settings()
    name = (filename or "").strip().lower()
    if not data:
        raise UploadRejected("empty_file", "The uploaded file is empty.")
    if len(data) > s.max_upload_bytes:
        raise UploadRejected(
            "file_too_large", f"Files must be {s.max_upload_bytes // (1024 * 1024)} MB or smaller.", status=413
        )
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    mime = (declared_mime or "").split(";")[0].strip().lower()

    if ext == "pdf":
        if mime and mime not in PDF_MIMES:
            raise UploadRejected("mime_mismatch", "The file type does not match its .pdf extension.")
        return _validate_pdf(data)
    if ext == "docx":
        if mime and mime not in DOCX_MIMES:
            raise UploadRejected("mime_mismatch", "The file type does not match its .docx extension.")
        return _validate_docx(data)
    if ext in {"doc", "rtf", "odt", "pages", "txt", "docm"}:
        raise UploadRejected("unsupported_type", f".{ext} files are not supported. Please upload a PDF or DOCX.")
    raise UploadRejected("unsupported_type", "Only PDF and DOCX files are supported.")


def _validate_pdf(data: bytes) -> ValidatedUpload:
    s = get_settings()
    if b"%PDF-" not in data[:1024]:
        raise UploadRejected("bad_signature", "This file is not a valid PDF (missing PDF header).")
    warnings: list[str] = []
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            # an empty user password is common for "permissions-only" PDFs
            try:
                ok = reader.decrypt("")
            except Exception:
                ok = 0
            if not ok:
                raise UploadRejected(
                    "encrypted_pdf", "This PDF is password-protected. Please upload an unprotected copy."
                )
            warnings.append("pdf_permissions_encryption")
        pages = len(reader.pages)
    except UploadRejected:
        raise
    except (PdfReadError, Exception) as exc:  # noqa: B014 - pypdf raises many types
        raise UploadRejected("corrupted_pdf", "This PDF could not be read. It may be damaged.") from exc
    if pages == 0:
        raise UploadRejected("empty_pdf", "This PDF has no pages.")
    if pages > s.max_pdf_pages:
        raise UploadRejected("too_many_pages", f"Resumes must be {s.max_pdf_pages} pages or fewer (this file has {pages}).")
    if b"/JavaScript" in data or b"/JS " in data or b"/Launch" in data:
        # never executed by our parser; flagged so the user knows the file has active content
        warnings.append("pdf_active_content_ignored")
    return ValidatedUpload("pdf", "application/pdf", len(data), pages, warnings)


def _validate_docx(data: bytes) -> ValidatedUpload:
    s = get_settings()
    if not data.startswith(b"PK\x03\x04"):
        raise UploadRejected("bad_signature", "This file is not a valid DOCX document.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise UploadRejected("corrupted_docx", "This DOCX file could not be read. It may be damaged.") from exc
    infos = zf.infolist()
    if len(infos) > 2000:
        raise UploadRejected("docx_too_complex", "This document contains too many parts to process safely.")
    names = {i.filename for i in infos}
    if "[Content_Types].xml" not in names or "word/document.xml" not in names:
        raise UploadRejected("bad_signature", "This file is not a Word document.")
    if any(n.lower().endswith("vbaproject.bin") for n in names):
        raise UploadRejected("macro_document", "Documents containing macros are not accepted.")
    total = 0
    for i in infos:
        if i.filename.startswith("/") or ".." in i.filename.split("/"):
            raise UploadRejected("corrupted_docx", "This document contains invalid internal paths.")
        if i.flag_bits & 0x1:
            raise UploadRejected("encrypted_docx", "This document is password-protected.")
        total += i.file_size
        if i.compress_size and i.file_size / max(i.compress_size, 1) > 200 and i.file_size > 1_000_000:
            raise UploadRejected("docx_too_complex", "This document's compression ratio is unsafe to process.")
    if total > s.max_docx_uncompressed_bytes:
        raise UploadRejected("docx_too_complex", "This document expands to an unsafe size.")
    if "EncryptedPackage" in names:
        raise UploadRejected("encrypted_docx", "This document is password-protected.")
    return ValidatedUpload(
        "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", len(data), None, []
    )
