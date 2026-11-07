"""End-to-end smoke test against a running deployment (e.g. docker compose).

    python scripts/smoke.py --api http://localhost:8000 --mailpit http://localhost:8025

Exercises the asynchronous path (Celery + Redis + S3/MinIO + SMTP/Mailpit): register, verify
via the emailed link, upload, wait for the worker, review, analyse, recommend, match a JD,
create + accept an AI suggestion, export PDF and download it through a signed link.
Uses a synthetic persona; exits non-zero on the first failure.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import uuid
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eval.synthetic import load, render  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--mailpit", default="http://localhost:8025")
    a = ap.parse_args()
    c = httpx.Client(base_url=a.api, timeout=60)

    def call(method: str, url: str, expect: int | tuple = 200, **kw):
        h = kw.pop("headers", {})
        if method != "GET" and c.cookies.get("ri_csrf"):
            h["x-csrf-token"] = c.cookies.get("ri_csrf")
        r = c.request(method, url, headers=h, **kw)
        ok = r.status_code in (expect if isinstance(expect, tuple) else (expect,))
        print(f"{'ok ' if ok else 'FAIL'} {method} {url} -> {r.status_code}")
        if not ok:
            print(r.text[:500])
            sys.exit(1)
        return r

    email = f"smoke-{uuid.uuid4().hex[:8]}@example.com"
    call("POST", "/api/auth/register", 201, json={"email": email, "password": "Smoke-test-pass-42"})
    token = None
    for _ in range(30):
        msgs = httpx.get(f"{a.mailpit}/api/v1/search", params={"query": f"to:{email}"}).json().get("messages", [])
        if msgs:
            body = httpx.get(f"{a.mailpit}/api/v1/message/{msgs[0]['ID']}").json()["Text"]
            token = re.search(r"token=([\w\-]+)", body).group(1)  # type: ignore[union-attr]
            break
        time.sleep(1)
    if not token:
        print("FAIL no verification email")
        sys.exit(1)
    call("POST", "/api/auth/verify-email", json={"token": token})

    persona = {p["id"]: p for p in load()["personas"]}["p03"]
    _, pdf = render(persona, "A")
    rid = call("POST", "/api/resumes", 202, files={"file": ("smoke.pdf", pdf, "application/pdf")}).json()["id"]
    for _ in range(60):
        st = call("GET", f"/api/resumes/{rid}").json()
        if st["status"] in ("needs_review", "failed"):
            break
        time.sleep(1)
    if st["status"] != "needs_review":
        print("FAIL parse status", st)
        sys.exit(1)
    ex = call("GET", f"/api/resumes/{rid}/extraction").json()
    vid = call("PUT", f"/api/resumes/{rid}/review", json={"content": ex["content"]}).json()["version_id"]
    an = call("GET", f"/api/versions/{vid}/analysis").json()
    print(f"   overall indicator {an['overall']}")
    rec = call("POST", f"/api/versions/{vid}/recommendations", json={}).json()
    print(f"   top role {rec['recommendations'][0]['role_id']} via {rec['embedding_model']}")
    jd = call("POST", "/api/job-descriptions", 201, json={"text": "ML Engineer\nRequirements\n- Python\n- MLflow\n- 3+ years of experience in machine learning"}).json()
    m = call("POST", f"/api/job-descriptions/{jd['id']}/match/{vid}").json()
    print(f"   JD compatibility {m['overall']}")
    s = call("POST", f"/api/versions/{vid}/suggestions", 201, json={"operation": "grammar", "target_path": "summary"}).json()
    call("POST", f"/api/suggestions/{s['id']}/accept", json={})
    e = call("POST", f"/api/resumes/{rid}/exports", 202, json={"format": "pdf", "template": "technical"}).json()
    for _ in range(60):
        e = call("GET", f"/api/exports/{e['id']}").json()
        if e["status"] in ("ready", "failed"):
            break
        time.sleep(1)
    if e["status"] != "ready":
        print("FAIL export", e)
        sys.exit(1)
    url = call("GET", f"/api/exports/{e['id']}/link").json()["url"]
    data = call("GET", url).content
    assert data.startswith(b"%PDF"), "export is not a PDF"
    print(f"   downloaded {len(data)} bytes PDF")
    call("POST", "/api/account/delete", json={"confirm_email": email, "password": "Smoke-test-pass-42"})
    print("SMOKE TEST PASSED")


if __name__ == "__main__":
    main()
