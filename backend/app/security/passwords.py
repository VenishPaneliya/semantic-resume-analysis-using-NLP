from __future__ import annotations

import re

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_ph = PasswordHasher()  # argon2id with library defaults (RFC 9106 low-memory profile)

# Common passwords and the words people build them from. A password is rejected when it is one
# of these, or when its "core" is: lowercased, common character swaps undone (@->a, 0->o, ...) and
# leading/trailing digits and symbols removed, so "Password1234!", "P@ssw0rd2024" and "qwerty12345"
# are caught although each is 10+ characters with a digit. Length + class checks do the rest.
_COMMON_PASSWORDS = frozenset({
    "1234567890", "12345678910", "0123456789", "1111111111", "0000000000", "1234512345", "1234567899",
    "9876543210", "1q2w3e4r5t", "1qaz2wsx3edc", "qwertyuiop", "asdfghjkl", "zxcvbnm", "qwerty123456",
    "qwerty12345", "password123", "password1234", "iloveyou123", "abcd123456", "abc1234567",
    "qazwsxedc", "qwe123qwe", "aa12345678", "asdf123456", "1q2w3e4r", "zaq12wsx",
})
_COMMON_WORDS = frozenset({
    "password", "passw", "passwd", "pass", "passwort", "motdepasse", "contrasena", "qwerty", "qwertz", "azerty",
    "asdf", "asdfgh", "zxcv", "abc", "abcd", "abcdef", "abcdefg", "abcdefgh", "abcdefghij", "iloveyou", "letmein",
    "welcome", "admin", "administrator", "login", "default", "changeme", "secret", "master", "monkey", "dragon",
    "football", "baseball", "soccer", "cricket", "sunshine", "princess", "shadow", "superman", "batman", "trustno",
    "starwars", "pokemon", "whatever", "freedom", "computer", "internet", "hello", "helloworld", "test", "tester",
    "testing", "guest", "user", "root", "summer", "winter", "spring", "autumn", "january", "india", "bharat",
    "mumbai", "delhi", "hindustan", "jaishriram", "omsairam", "krishna", "ganesh", "google", "facebook", "linkedin",
    "resume", "career", "qazwsx", "michael", "jennifer", "charlie", "jordan", "hunter", "ranger", "killer",
    "access", "flower", "lovely", "loveyou", "mylove", "angel", "family", "blessed", "chocolate", "samsung",
    "apple", "iphone", "matrix", "ninja", "mustang", "cheese", "pepper", "orange", "banana", "purple",
})
_SWAPS = str.maketrans({"@": "a", "4": "a", "0": "o", "1": "i", "!": "i", "3": "e", "$": "s", "5": "s", "7": "t"})
_EDGES = re.compile(r"^[\d\W_]+|[\d\W_]+$")


def _core(password: str) -> str:
    """Lowercase, strip leading/trailing digits and symbols, then undo common character swaps."""
    p = password.lower().strip()
    stripped = _EDGES.sub("", p)
    return re.sub(r"[\W_]+", "", stripped.translate(_SWAPS))


def is_common_password(password: str) -> bool:
    p = password.lower().strip()
    if p in _COMMON_PASSWORDS or re.sub(r"[\W_]+", "", p) in _COMMON_PASSWORDS:
        return True
    if len(set(p)) <= 2:  # "aaaaaaaaaa", "ababababab"
        return True
    core = _core(password)
    if not core:  # digits and symbols only; the letters-and-digits rule already applies
        return False
    if core in _COMMON_WORDS or core in _COMMON_PASSWORDS:
        return True
    # a common word repeated ("passwordpassword", "qwertyqwerty")
    return any(core == w * (len(core) // len(w)) for w in _COMMON_WORDS if len(core) % len(w) == 0)


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
    if is_common_password(password):
        problems.append("This password is too common or too easy to guess. Avoid common words and number patterns.")
    return problems
