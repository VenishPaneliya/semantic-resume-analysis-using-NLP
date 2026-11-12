"""Object storage behaviour that must be identical for the local and S3 backends."""

from __future__ import annotations

import io

import pytest
from botocore.exceptions import ClientError
from conftest import confirmed_version

from app.services import storage as storage_mod
from app.services.storage import S3Storage


def _client_error(code: str, status: int, op: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "x"}, "ResponseMetadata": {"HTTPStatusCode": status}}, op)


class FakeS3Client:
    """The subset of the boto3 S3 client that S3Storage uses, with real botocore errors."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_object(self, *, Bucket, Key, Body, **_):  # noqa: N803 - boto3 argument names
        self.objects[Key] = Body

    def get_object(self, *, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise _client_error("NoSuchKey", 404, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}

    def head_object(self, *, Bucket, Key):  # noqa: N803
        if Key not in self.objects:
            raise _client_error("404", 404, "HeadObject")  # HEAD has no body, so S3 sends only the status
        return {}

    def delete_object(self, *, Bucket, Key):  # noqa: N803
        self.objects.pop(Key, None)


def _s3(client) -> S3Storage:
    st = S3Storage.__new__(S3Storage)
    st.bucket, st.sse, st.client = "test-bucket", None, client
    return st


def test_s3_missing_object_raises_file_not_found():
    st = _s3(FakeS3Client())
    st.put("users/u/a.pdf", b"hello", "application/pdf")
    assert st.get("users/u/a.pdf") == b"hello"
    assert st.exists("users/u/a.pdf") is True
    st.delete("users/u/a.pdf")
    with pytest.raises(FileNotFoundError):
        st.get("users/u/a.pdf")
    assert st.exists("users/u/a.pdf") is False
    st.delete("users/u/a.pdf")  # deleting twice is fine


def test_s3_other_errors_are_not_reported_as_missing():
    class Denied(FakeS3Client):
        def get_object(self, **_):
            raise _client_error("AccessDenied", 403, "GetObject")

        def head_object(self, **_):
            raise _client_error("403", 403, "HeadObject")

    st = _s3(Denied())
    with pytest.raises(ClientError):
        st.get("users/u/a.pdf")
    with pytest.raises(ClientError):  # the readiness check must see this as a failure
        st.exists("users/u/a.pdf")


def test_download_after_resume_deleted_is_404_on_s3(make_user, pdf_bytes, monkeypatch):
    client = FakeS3Client()
    monkeypatch.setattr(storage_mod, "_storage", _s3(client))
    api = make_user()
    rid, _ = confirmed_version(api, pdf_bytes)
    url = api.get(f"/api/resumes/{rid}/original-link").json()["url"]
    assert api.get(url).status_code == 200
    assert api.delete(f"/api/resumes/{rid}").status_code == 204
    assert not client.objects
    r = api.get(url)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"
