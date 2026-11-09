"""Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s) for two-factor login.
Compatible with Google Authenticator, Microsoft Authenticator, 1Password, Authy, etc."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP = 30
DIGITS = 6


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, counter: int) -> str:
    digest = hmac.new(_key(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    o = digest[-1] & 0x0F
    n = (struct.unpack(">I", digest[o:o + 4])[0] & 0x7FFFFFFF) % 10**DIGITS
    return str(n).zfill(DIGITS)


def verify(secret: str, code: str, *, at: float | None = None, window: int = 1) -> int | None:
    """Return the matching time step (for replay protection) or None. Allows ±window steps of clock drift."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != DIGITS:
        return None
    step = int((at if at is not None else time.time()) // STEP)
    for d in range(-window, window + 1):
        if hmac.compare_digest(code_at(secret, step + d), code):
            return step + d
    return None


def provisioning_uri(secret: str, account: str, issuer: str = "Resume Intelligence") -> str:
    return (f"otpauth://totp/{quote(issuer)}:{quote(account)}?secret={secret}&issuer={quote(issuer)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={STEP}")


def new_recovery_codes(n: int = 10) -> list[str]:
    return [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(n)]
