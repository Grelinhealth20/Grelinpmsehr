# Grelin OCR microservice — PP-StructureV2 + docTR (CPU image).
# For GPU, use an nvidia/cuda base and install the CUDA paddle/torch wheels.
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OCR_WARMUP=true

# System libs required by PaddleOCR/OpenCV, docTR, and PyMuPDF rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY extractor.py main.py ./

EXPOSE 8600
# Single worker: each worker loads full models into memory. Scale horizontally
# (more replicas) rather than many workers per container.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8600", "--workers", "1"]
