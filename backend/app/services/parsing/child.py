"""Child-process entry point for sandboxed parsing. Reads a JSON job from stdin and writes a
JSON result to stdout. Imports nothing from the app beyond the pure parser module."""

from __future__ import annotations

import base64
import json
import sys


def main() -> None:
    job = json.loads(sys.stdin.buffer.read().decode())
    from app.services.parsing.parsers import ParseError, parse_document

    try:
        result = parse_document(job["kind"], base64.b64decode(job["data"]), job.get("ocr", False), job.get("tess"))
        out = {"result": result}
    except ParseError as e:
        out = {"error": {"code": e.code, "message": e.message, "retryable": e.retryable}}
    except Exception:
        out = {"error": {"code": "parser_crashed", "message": "The document could not be processed.", "retryable": True}}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
