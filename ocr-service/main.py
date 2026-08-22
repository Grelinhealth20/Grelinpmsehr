"""
Grelin OCR microservice (FastAPI).

Endpoints:
  GET  /health   -> liveness + model-load status
  POST /extract  -> multipart file (image/* or application/pdf) -> structured OCR

Security: PHI passes through this service, so if OCR_API_KEY is set the caller
MUST present it as `X-OCR-Key`. Bind to 127.0.0.1 for local testing; in
production run it on a private subnet / behind the same trust boundary as the
Node API (never expose it publicly).
"""
import os
import logging
from fastapi import FastAPI, UploadFile, File, Header, HTTPException
import extractor

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("grelin-ocr")

API_KEY = os.environ.get("OCR_API_KEY", "")
MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(15 * 1024 * 1024)))

app = FastAPI(title="Grelin OCR Service", version="1.0.0")


@app.on_event("startup")
def _startup():
    # Warm the models unless explicitly deferred (keeps first request fast).
    if os.environ.get("OCR_WARMUP", "true").lower() == "true":
        try:
            extractor.warmup()
            log.info("Models warmed up (PP-StructureV2 + docTR).")
        except Exception as e:  # non-fatal; first request will load lazily
            log.warning("Warmup skipped: %s", e)


def _auth(x_ocr_key):
    if API_KEY and x_ocr_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing OCR key.")


@app.get("/health")
def health():
    return {"status": "ok", "models": ["pp-structure-v2", "doctr"]}


@app.post("/extract")
async def extract(file: UploadFile = File(...), x_ocr_key: str = Header(default="")):
    _auth(x_ocr_key)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File too large.")

    ct = (file.content_type or "").lower()
    name = (file.filename or "").lower()
    try:
        if ct == "application/pdf" or name.endswith(".pdf"):
            page_arrays = extractor.pdf_to_images(data)
        elif ct.startswith("image/"):
            page_arrays = [extractor.image_bytes_to_array(data)]
        else:
            raise HTTPException(status_code=415, detail="Only image/* and application/pdf are supported.")
        pages = [extractor.process_page(arr) for arr in page_arrays]
        return {"pages": pages, "pageCount": len(pages)}
    except HTTPException:
        raise
    except Exception as e:
        log.exception("OCR failed")
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}")
