from __future__ import annotations

import re

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_ph = PasswordHasher()  # argon2id with library defaults (RFC 9106 low-memory profile)

# A tiny denylist of the most common passwords; length + class checks do the rest.
_COMMON = {"password", "password1", "12345678", "123456789", "qwerty123", "iloveyou", "letmein1"}


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        # constant-ish time: still run a hash to avoid user enumeration by timing
        _ph.hash(password)
        return False
    try:
        return _ph.verify(hashed, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(hashed: str) -> bool:
    return _ph.check_needs_rehash(hashed)


def password_problems(password: str) -> list[str]:
    problems = []
    if len(password) < 10:
        problems.append("Use at least 10 characters.")
    if len(password) > 256:
        problems.append("Use at most 256 characters.")
    if not re.search(r"[A-Za-z]", password) or not re.search(r"[0-9\W_]", password):
        problems.append("Include letters and at least one number or symbol.")
    if password.lower() in _COMMON:
        problems.append("This password is too common.")
    return problems
