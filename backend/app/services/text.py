"""Small text helpers."""

from __future__ import annotations


def clip(text: str, limit: int) -> str:
    """Shorten for quoting without cutting a word in half: "…and tuned the" not "…and tun"."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:-–—(")
    return (cut or text[:limit]) + "…"
