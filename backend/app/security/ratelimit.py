"""Fixed-window rate limiter with in-memory (single process) or Redis backend."""

from __future__ import annotations

import threading
import time
from collections import defaultdict

from fastapi import HTTPException, status

from app.config import get_settings


class _MemoryBackend:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))

    def hit(self, key: str, window: int) -> int:
        now = time.time()
        with self._lock:
            count, reset_at = self._counts[key]
            if now >= reset_at:
                count, reset_at = 0, now + window
            count += 1
            self._counts[key] = (count, reset_at)
            return count

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()


class _RedisBackend:  # pragma: no cover - exercised in docker/integration
    def __init__(self, url: str) -> None:
        import redis

        self._r = redis.Redis.from_url(url)

    def hit(self, key: str, window: int) -> int:
        bucket = f"rl:{key}:{int(time.time() // window)}"
        pipe = self._r.pipeline()
        pipe.incr(bucket)
        pipe.expire(bucket, window + 1)
        count, _ = pipe.execute()
        return int(count)

    def reset(self) -> None:
        pass


_backend: _MemoryBackend | _RedisBackend | None = None


def backend():
    global _backend
    if _backend is None:
        s = get_settings()
        _backend = _RedisBackend(s.redis_url) if s.rate_limit_backend == "redis" else _MemoryBackend()
    return _backend


def reset_rate_limits() -> None:
    global _backend
    if _backend is not None:
        _backend.reset()
    _backend = None


def enforce(key: str, limit: int, window_seconds: int = 60) -> None:
    if limit <= 0:
        return
    if backend().hit(key, window_seconds) > limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many requests. Please wait and try again."},
            headers={"Retry-After": str(window_seconds)},
        )
