"""Embedding backends.

- `sentence-transformers`: dense semantic embeddings (default model all-MiniLM-L6-v2).
- `tfidf`: deterministic TF-IDF (word 1-2 grams + char 3-5 grams) fitted on the role
  taxonomy and skill vocabulary. Lexical, not semantic; used when Sentence Transformers is
  not installed and always recorded in results so the two are never confused.

Cosine similarities are mapped to [0, 1] with fixed per-backend anchors. The mapped value
is a heuristic alignment signal, NOT a calibrated probability.
"""

from __future__ import annotations

import logging
import threading
from functools import lru_cache

import numpy as np

from app.config import get_settings

log = logging.getLogger(__name__)


class Embedder:
    name: str
    lo: float
    hi: float

    def encode(self, texts: list[str]) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError

    def similarity(self, a: list[str], b: list[str]) -> np.ndarray:
        ea, eb = self.encode(a), self.encode(b)
        return ea @ eb.T

    def normalise(self, cos: float | np.ndarray):
        return np.clip((cos - self.lo) / (self.hi - self.lo), 0.0, 1.0)


class SentenceTransformerEmbedder(Embedder):
    lo, hi = 0.10, 0.65

    def __init__(self, model_name: str) -> None:
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(model_name, device="cpu")
        self.name = f"st:{model_name}"
        self._lock = threading.Lock()

    def encode(self, texts: list[str]) -> np.ndarray:
        with self._lock:
            v = self.model.encode(texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        return np.asarray(v, dtype=np.float32)


class TfidfEmbedder(Embedder):
    name = "tfidf-word-char-v1"
    lo, hi = 0.02, 0.40

    def __init__(self) -> None:
        from scipy.sparse import hstack  # noqa: F401 - sklearn dependency
        from sklearn.feature_extraction.text import TfidfVectorizer

        from app.services.taxonomy import get_taxonomy

        tax = get_taxonomy()
        corpus = [r.profile_text() for r in tax.roles.values()]
        corpus += [" ".join((s.name, *s.aliases)) for s in tax.skills.values()]
        self.word = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1, lowercase=True)
        self.char = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True, min_df=1)
        self.word.fit(corpus)
        self.char.fit(corpus)

    def encode(self, texts: list[str]) -> np.ndarray:
        from scipy.sparse import hstack
        from sklearn.preprocessing import normalize

        m = hstack([self.word.transform(texts) * 0.7, self.char.transform(texts) * 0.3]).tocsr()
        return normalize(m).toarray().astype(np.float32)


_lock = threading.Lock()


@lru_cache
def get_embedder() -> Embedder:
    s = get_settings()
    with _lock:
        if s.embedding_backend in ("auto", "sentence-transformers"):
            try:
                return SentenceTransformerEmbedder(s.embedding_model)
            except Exception as exc:  # ImportError, model download failure, …
                if s.embedding_backend == "sentence-transformers":
                    raise
                log.warning("Sentence Transformers unavailable (%s); using TF-IDF fallback", type(exc).__name__)
        return TfidfEmbedder()
