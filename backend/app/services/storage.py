"""Private object storage. All objects are Fernet-encrypted before they leave the process
(S3 SSE is applied additionally). Downloads go through short-lived signed URLs."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import get_settings
from app.security.crypto import decrypt_bytes, encrypt_bytes


class Storage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> int: ...
    def exists(self, key: str) -> bool: ...


def _safe_key(key: str) -> str:
    if ".." in key.split("/") or key.startswith("/") or "\\" in key:
        raise ValueError("invalid storage key")
    return key


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.root / _safe_key(key)).resolve()
        if self.root not in p.parents:
            raise ValueError("invalid storage key")
        return p

    def put(self, key: str, data: bytes, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(encrypt_bytes(data))
        os.replace(tmp, p)

    def get(self, key: str) -> bytes:
        return decrypt_bytes(self._path(key).read_bytes())

    def delete(self, key: str) -> None:
        p = self._path(key)
        if p.exists():
            p.unlink()

    def delete_prefix(self, prefix: str) -> int:
        base = self._path(prefix.rstrip("/"))
        n = 0
        if base.is_dir():
            for f in sorted(base.rglob("*"), reverse=True):
                if f.is_file():
                    f.unlink()
                    n += 1
                else:
                    f.rmdir()
            base.rmdir()
        elif base.is_file():
            base.unlink()
            n = 1
        return n

    def exists(self, key: str) -> bool:
        return self._path(key).exists()


_S3_MISSING = {"NoSuchKey", "404", "NotFound", "NoSuchObject"}


def _is_missing(exc: Exception) -> bool:
    """True when a botocore error means "this object does not exist"."""
    response = getattr(exc, "response", None) or {}
    code = str((response.get("Error") or {}).get("Code", ""))
    status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return code in _S3_MISSING or status == 404


class S3Storage:
    """S3-compatible backend (AWS S3, SeaweedFS). Missing objects raise FileNotFoundError, like
    LocalStorage, so callers handle both backends the same way."""

    def __init__(self) -> None:  # pragma: no cover - needs an S3 endpoint
        import boto3

        s = get_settings()
        self.bucket = s.s3_bucket
        self.sse = s.s3_sse
        self.client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint_url,
            region_name=s.s3_region,
            aws_access_key_id=s.s3_access_key_id,
            aws_secret_access_key=s.s3_secret_access_key,
        )

    def put(self, key: str, data: bytes, content_type: str) -> None:
        extra = {"ServerSideEncryption": self.sse} if self.sse else {}
        self.client.put_object(
            Bucket=self.bucket,
            Key=_safe_key(key),
            Body=encrypt_bytes(data),
            ContentType="application/octet-stream",
            Metadata={"original-content-type": content_type},
            **extra,
        )

    def get(self, key: str) -> bytes:
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=_safe_key(key))
        except Exception as exc:
            if _is_missing(exc):
                raise FileNotFoundError(key) from exc
            raise
        return decrypt_bytes(obj["Body"].read())

    def delete(self, key: str) -> None:
        # S3 treats deleting a missing key as success; some compatible stores answer 404 instead
        try:
            self.client.delete_object(Bucket=self.bucket, Key=_safe_key(key))
        except Exception as exc:
            if not _is_missing(exc):
                raise

    def delete_prefix(self, prefix: str) -> int:
        n = 0
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=_safe_key(prefix)):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objs})
                n += len(objs)
        return n

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=_safe_key(key))
            return True
        except Exception as exc:
            if _is_missing(exc):
                return False
            raise  # auth or network errors must not look like "no such file"


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        s = get_settings()
        _storage = S3Storage() if s.storage_backend == "s3" else LocalStorage(s.local_storage_path)
    return _storage


def reset_storage() -> None:
    global _storage
    _storage = None


# ---- signed download URLs -------------------------------------------------------------
# Because objects are application-encrypted, downloads are proxied through the API, which
# decrypts after verifying a short-lived signed token bound to user + object.


def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="download-v1")


def sign_download(user_id: str, key: str, filename: str, content_type: str) -> str:
    return _signer().dumps({"u": user_id, "k": key, "f": filename, "t": content_type})


def verify_download(token: str) -> dict:
    try:
        return _signer().loads(token, max_age=get_settings().signed_url_ttl_seconds)
    except SignatureExpired as exc:
        raise PermissionError("expired") from exc
    except BadSignature as exc:
        raise PermissionError("invalid") from exc
