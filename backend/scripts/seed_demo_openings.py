"""Load (or remove) clearly-labelled DEMO job openings.

    python scripts/seed_demo_openings.py           # add demo openings (idempotent)
    python scripts/seed_demo_openings.py --remove  # delete all demo openings and their applications

Demo rows are stored with is_demo=true and shown as "Sample opening" in the UI. Never run
this in a production deployment that real candidates use.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import JobOpening  # noqa: E402
from app.services.openings import extract_opening  # noqa: E402


def main() -> None:
    db = SessionLocal()
    try:
        existing = list(db.scalars(select(JobOpening).where(JobOpening.is_demo.is_(True))))
        if "--remove" in sys.argv:
            for o in existing:
                db.delete(o)
            db.commit()
            print(f"Removed {len(existing)} demo openings.")
            return
        have = {(o.title, o.company) for o in existing}
        data = json.loads((ROOT / "data" / "demo" / "openings_v1.json").read_text(encoding="utf-8"))
        added = 0
        for row in data["openings"]:
            if (row["title"], row["company"]) in have:
                continue
            o = JobOpening(**row, is_demo=True, status="open")
            extract_opening(o)
            db.add(o)
            added += 1
        db.commit()
        print(f"Added {added} demo openings ({len(existing)} already present).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
