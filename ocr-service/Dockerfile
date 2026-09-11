# ============================================================================
# Grelin OCR microservice — PP-StructureV2 + docTR (CPU image)
# ----------------------------------------------------------------------------
# Loads PaddleOCR / PP-StructureV2 and docTR models to perform structured
# extraction from face sheets and medical documents.
# ============================================================================
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OCR_WARMUP=true

# System libraries required by PaddleOCR, docTR, OpenCV, and PyMuPDF rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY extractor.py main.py ./

EXPOSE 6003

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:6003/health', timeout=5)" || exit 1

# Single worker: each worker loads the full models into memory. Scale horizontally
# (more containers) rather than multiple workers per container.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "6003", "--workers", "1"]
