"""Shared helpers for the real-data evaluation: paths, statistics, text conversion."""

from __future__ import annotations

import html
import math
import random
import re
from html.parser import HTMLParser
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "var" / "eval_data"
SEED = 20261110


# ------------------------------------------------------------------ statistics
def auc(y: list[int], s: list[float]) -> float | None:
    """ROC-AUC via the Mann-Whitney U statistic (ties count one half)."""
    pos = [v for v, t in zip(s, y, strict=True) if t == 1]
    neg = [v for v, t in zip(s, y, strict=True) if t == 0]
    if not pos or not neg:
        return None
    from scipy.stats import rankdata

    ranks = rankdata(pos + neg)
    r_pos = float(np.sum(ranks[: len(pos)]))
    return (r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def spearman(x: list[float], y: list[float]) -> float | None:
    from scipy.stats import spearmanr

    if len(set(x)) < 2 or len(set(y)) < 2:
        return None
    return float(spearmanr(x, y).statistic)


def bootstrap(fn, groups: list, n: int = 1000, seed: int = SEED) -> tuple[float | None, float | None]:
    """95% percentile bootstrap CI. `groups` is a list of resampling units (each a list of rows),
    so dependent rows (e.g. pairs sharing a job description) are resampled together."""
    rng = random.Random(seed)
    vals = []
    for _ in range(n):
        rows = [r for g in (groups[rng.randrange(len(groups))] for _ in range(len(groups))) for r in g]
        v = fn(rows)
        if v is not None and not (isinstance(v, float) and math.isnan(v)):
            vals.append(v)
    if not vals:
        return None, None
    vals.sort()
    return round(vals[int(0.025 * len(vals))], 3), round(vals[min(len(vals) - 1, int(0.975 * len(vals)))], 3)


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0,
            "tp": tp, "fp": fp, "fn": fn}


def r3(x):
    return None if x is None else round(float(x), 3)


# ------------------------------------------------------------------ text helpers
class _Stripper(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "hr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "li":
            self.out.append("\n• ")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        self.out.append(data)


_MOJIBAKE_RUN = re.compile(r"[Â-ô][\u0080-¿�]{1,3}")


def fix_mojibake(s: str) -> str:
    """Repair UTF-8 text that was decoded as Latin-1 upstream (RemoteOK serves "3â\\x80\\x935+").
    Each suspicious run is re-decoded on its own; runs that do not decode are dropped to a space
    only when they contain U+FFFD (the original byte is lost)."""
    def fix(m: re.Match) -> str:
        run = m.group(0)
        try:
            return run.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return " " if "�" in run else run
    return _MOJIBAKE_RUN.sub(fix, s)


def _strip_once(s: str) -> str:
    p = _Stripper()
    p.feed(s or "")
    p.close()
    return html.unescape("".join(p.out))


def html_to_text(s: str) -> str:
    """HTML posting -> plain text with one line per block element and "• " for list items
    (the format a user pasting a posting would produce)."""
    text = _strip_once(fix_mojibake(s or ""))
    if re.search(r"<(p|li|ul|div|br|strong)\b", text):  # HTML that was escaped twice upstream (Arbeitnow)
        text = _strip_once(text)
    text = text.replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln in ("•", "") and (not out or out[-1] == ""):
            continue
        out.append("" if ln == "•" else ln)
    return "\n".join(out).strip()


_DE = re.compile(r"\b(und|der|die|das|mit|für|wir|sie|ist|von|eine?n?|bei|auf|zu|im|als)\b", re.I)
_EN = re.compile(r"\b(and|the|with|for|we|you|is|of|to|our|in|a|as|are|on)\b", re.I)


def language(text: str) -> str:
    """Coarse German-vs-not filter. Used to choose the hand-label sample (frozen before labelling);
    it lets French and Dutch postings through as "en" — see language_detail."""
    de, en = len(_DE.findall(text)), len(_EN.findall(text))
    return "de" if de > en else "en"


_FR = re.compile(r"\b(le|la|les|des|du|et|vous|nous|pour|une|dans|est|avec|sur|au)\b", re.I)
_NL = re.compile(r"\b(het|een|van|en|je|jij|wij|voor|met|zijn|naar|ook|bij|niet|wat)\b", re.I)


def language_detail(text: str) -> str:
    """en / de / fr / nl by stop-word counts (reporting only)."""
    counts = {"en": len(_EN.findall(text)), "de": len(_DE.findall(text)), "fr": len(_FR.findall(text)), "nl": len(_NL.findall(text))}
    return max(counts, key=counts.get)


def text_pages(text: str) -> list[dict]:
    return [{"page": 1, "char_start": 0, "char_end": len(text)}]


def repair_content(content: dict) -> tuple[dict, list[str]]:
    """`extract()` can return content that violates ResumeContent's own length limits (see the
    report's bug section). Truncate offending strings/lists to the schema limit, as a user would
    have to before confirming the review. Returns (content, list of repaired paths)."""
    from pydantic import ValidationError

    from app.schemas.resume import ResumeContent

    fixed: list[str] = []
    for _ in range(50):
        try:
            ResumeContent.model_validate(content)
            return content, fixed
        except ValidationError as e:
            errs = e.errors()
        for err in errs:
            loc, limit = err["loc"], (err.get("ctx") or {}).get("max_length")
            if err["type"] not in ("string_too_long", "too_long") or limit is None:
                raise ValueError(f"unrepairable: {err['type']} at {loc}")
            node = content
            for part in loc[:-1]:
                node = node[part]
            node[loc[-1]] = node[loc[-1]][:limit]
            fixed.append(".".join(str(p) for p in loc))
    raise ValueError("repair did not converge")


def lenient_content(text: str, chunk_words: int = 25) -> dict:
    """DIAGNOSTIC ONLY (not product behaviour): put the whole resume into one experience entry
    whose bullets are the text's lines/sentences (or fixed word windows when the text has no
    punctuation). Every recognised skill then counts as demonstrated, so ranking quality can be
    separated from section/entry extraction quality."""
    from app.schemas.resume import ResumeContent

    pieces = [p.strip() for p in re.split(r"\n+|(?<=[.;!?])\s+", text) if p.strip()]
    if len(pieces) < 3:
        words = text.split()
        pieces = [" ".join(words[i : i + chunk_words]) for i in range(0, len(words), chunk_words)]
    bullets = [{"text": p[:790]} for p in pieces[:400]]
    entries = [{"title": None, "bullets": bullets[i : i + 40]} for i in range(0, len(bullets), 40)] or [{"title": None}]
    return ResumeContent.model_validate({"experience": entries}).model_dump()
