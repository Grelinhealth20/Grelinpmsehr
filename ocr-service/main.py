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
from fastapi.responses import JSONResponse
import extractor

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("grelin-ocr")

API_KEY = os.environ.get("OCR_API_KEY", "")
MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(15 * 1024 * 1024)))

# Fail-closed auth by DEFAULT. This PHI endpoint requires OCR_API_KEY unless an operator EXPLICITLY
# opts into insecure local development (OCR_DEV_INSECURE=true). This removes the previous footgun where a
# process merely missing the prod env marker (independent Python env — the Node app's NODE_ENV does not
# propagate here) would silently run auth-open. Secure-by-default: no key + no explicit opt-out => refuse.
_INSECURE = os.environ.get("OCR_DEV_INSECURE", "").lower() == "true"
REQUIRE_AUTH = not _INSECURE
if REQUIRE_AUTH and not API_KEY:
    # Refuse to boot rather than silently run auth-open.
    raise RuntimeError(
        "OCR_API_KEY is required. Set OCR_API_KEY (and the same value on the backend's OCR_API_KEY), "
        "or set OCR_DEV_INSECURE=true for local development only.")

app = FastAPI(title="Grelin OCR Service", version="1.0.0")


@app.on_event("startup")
def _startup():
    # Warm the models unless explicitly deferred (keeps first request fast). A warmup failure
    # is NOT swallowed as merely cosmetic: it means the OCR engine cannot run, which /health
    # then reports as unavailable (503) so the service is never routed traffic it will 500 on.
    if os.environ.get("OCR_WARMUP", "true").lower() == "true":
        ready, detail = extractor.probe_ready()
        if ready:
            log.info("OCR engine ready: %s", detail)
        else:
            log.error("OCR engine FAILED to load — /health will report unavailable: %s", detail.get("error"))


def _auth(x_ocr_key):
    # Defense in depth: if prod requires auth but no key is configured, reject
    # every request (startup already refuses to boot in this state — never open).
    if REQUIRE_AUTH and not API_KEY:
        raise HTTPException(status_code=401, detail="OCR authentication is not configured.")
    if API_KEY and x_ocr_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing OCR key.")


@app.get("/health")
def health():
    # HONEST, BINARY readiness: 200 only if the OCR engine can actually run; otherwise 503.
    # No "degraded" middle state — the caller (and any container orchestrator) gets a truthful
    # up/down signal, so a process whose engine failed to load is never treated as healthy.
    ready, detail = extractor.probe_ready()
    if not ready:
        return JSONResponse(status_code=503, content={"status": "unavailable", "error": detail.get("error"),
                                                       "engines": {k: detail[k] for k in ("ppocr", "ppStructure", "doctr")}})
    return {"status": "ok", "engines": {k: detail[k] for k in ("ppocr", "ppStructure", "doctr")},
            "models": ["pp-structure-v2", "pp-ocrv4", "doctr"]}


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
    except ValueError as e:
        # Clean 400 for the input-guard rejections raised by the extractor
        # (decompression bomb / oversized image dimensions).
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("OCR failed")
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}")
