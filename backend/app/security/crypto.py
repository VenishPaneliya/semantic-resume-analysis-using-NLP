"""Application-level encryption at rest (Fernet / AES-128-CBC + HMAC-SHA256).

Keys come from ENCRYPTION_KEYS (comma separated, newest first) so keys can be rotated: encryption uses
the first key, decryption tries all of them. Without ENCRYPTION_KEYS (development only; production
refuses to start, see config._production_guards) the key is derived from SECRET_KEY.

Data must never be orphaned silently, so decryption also tries keys derived from:
- the current SECRET_KEY, even when ENCRYPTION_KEYS is set (an install that started without
  ENCRYPTION_KEYS keeps reading its data after adding them; rewritten values use the new key);
- ENCRYPTION_FALLBACK_SECRET_KEYS (earlier SECRET_KEY values), and, outside production, the
  development defaults this project has shipped, so a dev stack whose default SECRET_KEY changed
  keeps working.
These derived keys are only ever used to decrypt."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.config import get_settings

log = logging.getLogger(__name__)

# SECRET_KEY defaults used by earlier versions (config.py and docker-compose.yml); development only
LEGACY_DEV_SECRET_KEYS = ("dev-insecure-change-me", "dev-insecure-change-me-dev-insecure-change-me")


def derive_key(secret_key: str) -> bytes:
    """The Fernet key derived from a SECRET_KEY when ENCRYPTION_KEYS is not set."""
    return base64.urlsafe_b64encode(hashlib.sha256(("enc:" + secret_key).encode()).digest())


def _fallback_secrets() -> list[str]:
    s = get_settings()
    out = [s.secret_key] + [k.strip() for k in s.encryption_fallback_secret_keys.split(",") if k.strip()]
    if s.env != "production":
        out += list(LEGACY_DEV_SECRET_KEYS)
    return list(dict.fromkeys(out))


@lru_cache
def _fernet() -> MultiFernet:
    s = get_settings()
    keys: list[bytes] = [k.encode() for k in s.encryption_key_list]
    if not keys:
        log.warning("ENCRYPTION_KEYS not set; deriving a development key from SECRET_KEY")
    keys += [derive_key(sk) for sk in _fallback_secrets()]  # first entry encrypts only when no explicit key
    return MultiFernet([Fernet(k) for k in dict.fromkeys(keys)])


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


def keyed_hash(value: str, secret_key: str | None = None) -> str:
    """HMAC used for pseudonymous identifiers in logs (e.g. IP addresses) and 2FA recovery codes."""
    key = secret_key if secret_key is not None else get_settings().secret_key
    return hmac.new(key.encode(), value.encode(), hashlib.sha256).hexdigest()[:32]


def keyed_hash_candidates(value: str) -> list[str]:
    """keyed_hash under the current SECRET_KEY first, then under the decryption fallbacks, so values
    hashed before a SECRET_KEY change (e.g. recovery codes) can still be matched."""
    return list(dict.fromkeys(keyed_hash(value, sk) for sk in _fallback_secrets()))
