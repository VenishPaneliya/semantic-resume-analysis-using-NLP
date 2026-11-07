"""Application-level encryption at rest (Fernet / AES-128-CBC + HMAC-SHA256).

Keys come from ENCRYPTION_KEYS (comma separated, newest first) so keys can be rotated:
encryption uses the first key, decryption tries all of them. In development without keys a
key is derived from SECRET_KEY and a warning is logged; production refuses to start
without explicit keys (see config._production_guards)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.config import get_settings

log = logging.getLogger(__name__)


@lru_cache
def _fernet() -> MultiFernet:
    s = get_settings()
    keys = [k.strip() for k in s.encryption_keys.split(",") if k.strip()]
    if not keys:
        log.warning("ENCRYPTION_KEYS not set; deriving a development key from SECRET_KEY")
        derived = base64.urlsafe_b64encode(hashlib.sha256(("enc:" + s.secret_key).encode()).digest())
        keys = [derived.decode()]
    return MultiFernet([Fernet(k.encode() if isinstance(k, str) else k) for k in keys])


def reset_crypto_cache() -> None:
    _fernet.cache_clear()


def encrypt_bytes(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_bytes(token: bytes) -> bytes:
    try:
        return _fernet().decrypt(token)
    except InvalidToken as exc:  # pragma: no cover - only on key loss/tamper
        raise ValueError("Unable to decrypt stored data (wrong key or tampered)") from exc


def encrypt_str(value: str) -> str:
    return encrypt_bytes(value.encode("utf-8")).decode("ascii")


def decrypt_str(value: str) -> str:
    return decrypt_bytes(value.encode("ascii")).decode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def keyed_hash(value: str) -> str:
    """HMAC used for pseudonymous identifiers in logs (e.g. IP addresses)."""
    return hmac.new(get_settings().secret_key.encode(), value.encode(), hashlib.sha256).hexdigest()[:32]
