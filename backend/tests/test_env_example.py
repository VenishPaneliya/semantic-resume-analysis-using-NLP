"""`.env.example` documents every setting, with the default the code actually uses."""

from __future__ import annotations

import re
from pathlib import Path

from app.config import Settings

ROOT = Path(__file__).resolve().parents[2]


def _example_values() -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(#\s?)?([A-Z][A-Z0-9_]+)=(.*)$", line)
        if m:
            value = re.split(r"\s+#", m.group(3), maxsplit=1)[0].strip()
            out[m.group(2)] = None if m.group(1) else value
    return out


def test_env_example_lists_every_setting_with_the_code_default():
    example = _example_values()
    missing = sorted(n.upper() for n in Settings.model_fields if n.upper() not in example)
    assert not missing, f"add to .env.example: {missing}"
    for name, field in Settings.model_fields.items():
        value = example[name.upper()]
        default = field.default
        if value is None:  # commented out: must be an optional setting that is unset by default
            assert default in (None, ""), name
        elif name not in {"secret_key"} and value != "":
            assert str(default).lower() == value.lower() or str(default) == value, (name, default, value)
