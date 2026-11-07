"""Run the document parser in an isolated child process with a wall-clock timeout and, on
POSIX, CPU and address-space limits. A malicious or pathological document can crash or
stall only the child, never the worker or API process."""

from __future__ import annotations

import base64
import json
import subprocess
import sys

from app.config import get_settings
from app.services.parsing.parsers import ParseError, parse_document


def _limits(mem_mb: int, cpu_s: int):  # pragma: no cover - POSIX only
    def apply():
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (mem_mb * 1024 * 1024, mem_mb * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 1))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))

    return apply


def parse_isolated(kind: str, data: bytes, *, timeout: int | None = None, in_process: bool | None = None) -> dict:
    s = get_settings()
    timeout = timeout or s.parse_timeout_seconds
    if in_process if in_process is not None else not s.parse_sandbox:
        return parse_document(kind, data, s.ocr_enabled, s.tesseract_cmd)

    payload = json.dumps(
        {"kind": kind, "data": base64.b64encode(data).decode(), "ocr": s.ocr_enabled, "tess": s.tesseract_cmd}
    ).encode()
    kwargs: dict = {}
    if sys.platform != "win32":  # pragma: no cover
        kwargs["preexec_fn"] = _limits(s.parse_memory_limit_mb, timeout)
    try:
        proc = subprocess.run(  # noqa: S603 - fixed interpreter + module, no shell
            # -s: no user site-packages; cwd is the backend root so `-m` resolves only our module.
            [sys.executable, "-s", "-m", "app.services.parsing.child"],
            input=payload,
            capture_output=True,
            timeout=timeout,
            cwd=_backend_root(),
            env=_child_env(),
            check=False,
            **kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        raise ParseError("parse_timeout", "Processing took too long and was stopped.", retryable=False) from exc
    if proc.returncode != 0 or not proc.stdout:
        raise ParseError("parser_crashed", "The document could not be processed safely.", retryable=True)
    out = json.loads(proc.stdout.decode())
    if "error" in out:
        raise ParseError(out["error"]["code"], out["error"]["message"], out["error"].get("retryable", False))
    return out["result"]


def _backend_root() -> str:
    from pathlib import Path

    return str(Path(__file__).resolve().parents[3])


def _child_env() -> dict[str, str]:
    """Minimal environment: no secrets (DB URL, keys) are passed to the parser process."""
    import os

    env = {"PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
    if sys.platform == "win32":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return env
