# syntax=docker/dockerfile:1.7
# One image for API, Celery worker and beat. Build args:
#   INSTALL_ML=true   -> Sentence Transformers (CPU torch) + model baked into the image
#   INSTALL_OCR=true  -> Tesseract + Poppler for scanned PDFs
FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

FROM base AS build
ARG INSTALL_ML=true
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
# dependencies only (no source) so code changes do not invalidate this layer
COPY constraints.txt ./
# dev/test tools and AGPL PyMuPDF (used only in local tests) are excluded from the image
RUN set -eu; \
    grep -viE '^(pytest|ruff|mypy|pymupdf|colorama|iniconfig|pluggy|coverage)' constraints.txt > runtime.txt; \
    if [ "$INSTALL_ML" != "true" ]; then \
      grep -viE '^(torch|sentence|transformers|tokenizers|safetensors|huggingface|nvidia|hf-xet)' runtime.txt > r2.txt && mv r2.txt runtime.txt; \
    fi; \
    pip install --upgrade pip; \
    pip install --extra-index-url https://download.pytorch.org/whl/cpu -r runtime.txt; \
    pip install "pytesseract==0.3.13" "pdf2image==1.17.0"
# bake the embedding model so containers never download at runtime
ENV HF_HOME=/opt/hf
RUN if [ "$INSTALL_ML" = "true" ]; then \
      python -c "from sentence_transformers import SentenceTransformer as S; S('sentence-transformers/all-MiniLM-L6-v2', device='cpu')"; \
    else mkdir -p /opt/hf; fi

FROM base AS runtime
ARG INSTALL_OCR=false
RUN apt-get update \
 && if [ "$INSTALL_OCR" = "true" ]; then apt-get install -y --no-install-recommends tesseract-ocr poppler-utils; fi \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app app
COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/hf /opt/hf
ENV PATH=/opt/venv/bin:$PATH HF_HOME=/opt/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
COPY --chown=app:app . .
USER app
EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/live',timeout=3).status==200 else 1)" || exit 1
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --workers ${WEB_CONCURRENCY:-2}"]
