"""Download the public datasets and live job postings used by `eval.real.run_real`.

    python -m eval.real.fetch [--force] [--skip-jobs]

Everything is cached under backend/var/eval_data/ (gitignored). Raw data can contain personal
information (public resume datasets); it must never be copied into git-tracked paths.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "var" / "eval_data"

HF = "https://huggingface.co/datasets"
DATASETS = {
    # name -> (url, local filename)
    "fit_train": (f"{HF}/cnamuangtoun/resume-job-description-fit/resolve/main/train.csv", "fit/train.csv"),
    "fit_test": (f"{HF}/cnamuangtoun/resume-job-description-fit/resolve/main/test.csv", "fit/test.csv"),
    "atlas": (f"{HF}/ahmedheakl/resume-atlas/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet", "atlas/train.parquet"),
    "skillspan_test": (f"{HF}/jjzha/skillspan/resolve/main/test.json", "skillspan/test.json"),
    "skillspan_dev": (f"{HF}/jjzha/skillspan/resolve/main/dev.json", "skillspan/dev.json"),
}

JOB_APIS = {
    "remotive": "https://remotive.com/api/remote-jobs?limit=150",
    "arbeitnow": "https://www.arbeitnow.com/api/job-board-api?page={page}",
    "remoteok": "https://remoteok.com/api",
}
UA = {"User-Agent": "resume-analysis-eval/1.0 (research evaluation; contact: repository owner)"}


def _get(client: httpx.Client, url: str) -> httpx.Response:
    for attempt in range(3):
        try:
            r = client.get(url, headers=UA, follow_redirects=True, timeout=120)
            r.raise_for_status()
            return r
        except httpx.HTTPError as e:  # noqa: PERF203
            if attempt == 2:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_datasets(client: httpx.Client, force: bool) -> dict:
    status = {}
    for name, (url, rel) in DATASETS.items():
        dest = DATA / rel
        if dest.exists() and not force:
            status[name] = {"url": url, "path": str(dest), "cached": True}
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            r = _get(client, url)
            dest.write_bytes(r.content)
            status[name] = {"url": url, "path": str(dest), "bytes": len(r.content)}
        except Exception as e:  # noqa: BLE001
            status[name] = {"url": url, "error": f"{type(e).__name__}: {e}"[:200]}
        print(name, status[name])
    return status


def fetch_jobs(client: httpx.Client) -> dict:
    """Live postings fetched today; stored as one JSON file with source, id, title, company, html."""
    jobs: list[dict] = []
    errors = {}
    try:
        data = _get(client, JOB_APIS["remotive"]).json()
        for j in data.get("jobs", []):
            jobs.append({"source": "remotive", "id": str(j.get("id")), "title": j.get("title"), "company": j.get("company_name"),
                         "category": j.get("category"), "html": j.get("description") or ""})
    except Exception as e:  # noqa: BLE001
        errors["remotive"] = str(e)[:200]
    try:
        for page in (1, 2):
            data = _get(client, JOB_APIS["arbeitnow"].format(page=page)).json()
            for j in data.get("data", []):
                jobs.append({"source": "arbeitnow", "id": j.get("slug"), "title": j.get("title"), "company": j.get("company_name"),
                             "category": ",".join(j.get("tags") or []), "html": j.get("description") or ""})
            time.sleep(1)
    except Exception as e:  # noqa: BLE001
        errors["arbeitnow"] = str(e)[:200]
    try:
        data = _get(client, JOB_APIS["remoteok"]).json()
        for j in data[1:] if isinstance(data, list) else []:  # first element is a legal notice
            jobs.append({"source": "remoteok", "id": str(j.get("id")), "title": j.get("position"), "company": j.get("company"),
                         "category": ",".join(j.get("tags") or []), "html": j.get("description") or ""})
    except Exception as e:  # noqa: BLE001
        errors["remoteok"] = str(e)[:200]
    fetched_at = datetime.now(UTC).isoformat(timespec="seconds")
    out = {"fetched_at": fetched_at, "apis": JOB_APIS, "errors": errors, "jobs": jobs}
    dest = DATA / "jobs" / "postings.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    counts = {}
    for j in jobs:
        counts[j["source"]] = counts.get(j["source"], 0) + 1
    print("jobs", counts, "errors", errors)
    return {"counts": counts, "errors": errors, "fetched_at": fetched_at}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-download cached datasets")
    ap.add_argument("--skip-jobs", action="store_true", help="keep the cached job postings snapshot")
    args = ap.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    with httpx.Client() as client:
        fetch_datasets(client, args.force)
        if not args.skip_jobs or not (DATA / "jobs" / "postings.json").exists():
            fetch_jobs(client)


if __name__ == "__main__":
    main()
