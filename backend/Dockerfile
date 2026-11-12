# syntax=docker/dockerfile:1.7
# One image for API, Celery worker and beat. Build args:
#   INSTALL_ML=true   -> Sentence Transformers (CPU torch) + model baked into the image
#   INSTALL_OCR=true  -> Tesseract + Poppler for scanned PDFs
# base image pinned by digest (multi-arch index); refresh with
#   docker buildx imagetools inspect python:3.12-slim-bookworm --format '{{.Manifest.Digest}}'
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS base
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
# pip is only needed to build the venv. Removing it from the runtime image shrinks the attack surface and
# drops pip's bundled pkg_resources (pinned to an old setuptools), which scanners flag.
RUN pip uninstall -y pip
# torch wheels ship C++ headers, CMake files, test binaries and protoc that are never used at runtime (~220 MB);
# torch_shm_manager stays (torch.multiprocessing needs it)
RUN set -eu; t=/opt/venv/lib/python3.12/site-packages/torch; \
    if [ -d "$t" ]; then \
      rm -rf "$t/test" "$t/include" "$t/share"; \
      find "$t/bin" -mindepth 1 ! -name torch_shm_manager -exec rm -rf {} +; \
    fi

FROM base AS runtime
ARG INSTALL_OCR=false
RUN apt-get update \
 && if [ "$INSTALL_OCR" = "true" ]; then apt-get install -y --no-install-recommends tesseract-ocr poppler-utils; fi \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && python -m pip uninstall -y pip \
 && useradd --system --uid 10001 --home /app app
COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/hf /opt/hf
ENV PATH=/opt/venv/bin:$PATH HF_HOME=/opt/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
# Prometheus multiprocess mode: uvicorn workers / Celery pool children share counters through this directory
# (mount a tmpfs here in compose so it starts empty); see app/observability.py
ENV PROMETHEUS_MULTIPROC_DIR=/tmp/ri-metrics
COPY --chown=app:app . .
USER app
EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/live',timeout=3).status==200 else 1)" || exit 1
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --workers ${WEB_CONCURRENCY:-2}"]
