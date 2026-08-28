"""
Structured-OCR pipeline for Grelin Health face sheets / PCC documents.

Design: PP-StructureV2 (PaddleOCR) provides layout + table + text-line structure;
docTR provides a second, high-accuracy recognition pass. Both run per page. We
return:
  - ppLines / doctrLines : text lines with absolute-pixel boxes + confidence
  - kv                   : geometric key->value pairs (label: value) from layout
  - tables               : recovered table HTML (insurance blocks often live here)
  - text                 : a clean merged text blob for regex fallback

The medical field mapping (name/DOB/SSN/insurance -> schema) is intentionally NOT
done here — it lives in the Node backend so the tested validation layer stays in
one place. This service is a generic structured-OCR provider.
"""
import io
import os
import numpy as np
from PIL import Image

# Optional local model dir (offline / air-gapped hosts). If set and populated,
# PP-Structure loads from disk instead of downloading from Baidu's CDN.
_MODELS_DIR = os.environ.get("OCR_MODELS_DIR", "")
# PP-Structure adds layout/table recovery but is ~10x slower than plain PP-OCR.
# The deterministic parser works off PP-OCR text, so structure is OFF by default
# for speed; set OCR_USE_STRUCTURE=true to re-enable table recovery when needed.
_USE_STRUCTURE = os.environ.get("OCR_USE_STRUCTURE", "false").lower() == "true"
# CPU acceleration for PaddleOCR/PP-Structure inference on this host.
_CPU_THREADS = max(4, (os.cpu_count() or 4))
_MODEL_DIRS = {
    "det_model_dir": "en_PP-OCRv3_det_infer",
    "rec_model_dir": "en_PP-OCRv4_rec_infer",
    "cls_model_dir": "ch_ppocr_mobile_v2.0_cls_infer",
    "layout_model_dir": "picodet_lcnet_x1_0_fgd_layout_infer",
    "table_model_dir": "en_ppstructure_mobile_v2.0_SLANet_infer",
}


def _pp_kwargs():
    kw = dict(show_log=False, layout=True, table=True, ocr=True, lang="en",
              enable_mkldnn=True, cpu_threads=_CPU_THREADS)
    if _MODELS_DIR and os.path.isdir(_MODELS_DIR):
        for arg, sub in _MODEL_DIRS.items():
            path = os.path.join(_MODELS_DIR, sub)
            if os.path.isdir(path):
                kw[arg] = path
    return kw

# --- Lazy model singletons (loaded once per process) ------------------------
_pp = None
_ppocr = None
_doctr = None
_doctr_disabled = False  # set if the torch backend can't load (e.g. Windows w/o VC++ runtime)


def _preload_torch():
    """Import torch (docTR's backend) BEFORE PaddlePaddle so torch's native DLLs win the
    Windows loader search order. Paddle and torch ship conflicting copies of a shared runtime
    (libuv/OpenMP); if Paddle loads first, torch's shm.dll can't resolve its dependency and
    fails with WinError 127 ("specified procedure could not be found"), silently disabling
    docTR. Importing torch first registers its lib directory so both coexist. No-op / harmless
    if torch isn't installed. Cheap and idempotent (Python caches the import)."""
    try:
        import torch  # noqa: F401
    except Exception:  # noqa: BLE001
        pass


def _get_ppstructure():
    global _pp
    if _pp is None:
        _preload_torch()
        from paddleocr import PPStructure
        # layout + table recovery + OCR; English models (local dir if provided).
        _pp = PPStructure(**_pp_kwargs())
    return _pp


def _get_ppocr():
    """Plain PP-OCR (detection+recognition). Runs regardless of page layout, so
    text is never lost when PP-Structure classifies the whole page as a table."""
    global _ppocr
    if _ppocr is None:
        _preload_torch()
        from paddleocr import PaddleOCR
        kw = dict(use_angle_cls=True, lang="en", show_log=False,
                  enable_mkldnn=True, cpu_threads=_CPU_THREADS)
        if _MODELS_DIR and os.path.isdir(_MODELS_DIR):
            for arg, sub in (("det_model_dir", "en_PP-OCRv3_det_infer"),
                             ("rec_model_dir", "en_PP-OCRv4_rec_infer"),
                             ("cls_model_dir", "ch_ppocr_mobile_v2.0_cls_infer")):
                path = os.path.join(_MODELS_DIR, sub)
                if os.path.isdir(path):
                    kw[arg] = path
        _ppocr = PaddleOCR(**kw)
    return _ppocr


def _get_doctr():
    """docTR is a supplementary recognition pass. If its torch backend fails to
    load (common on Windows without the VC++ runtime), we disable it once and
    fall back to PP-StructureV2 alone — the service keeps working. On Linux/Docker
    torch loads normally and docTR is active."""
    global _doctr, _doctr_disabled
    if _doctr_disabled:
        return None
    if _doctr is None:
        try:
            from doctr.models import ocr_predictor
            _doctr = ocr_predictor(pretrained=True)
        except Exception as e:  # noqa: BLE001
            import logging
            logging.getLogger("grelin-ocr").warning("docTR unavailable, using PP-StructureV2 only: %s", e)
            _doctr_disabled = True
            return None
    return _doctr


def warmup():
    """Force-load models at boot so the first request isn't slow (docTR optional).

    ORDER MATTERS on Windows: load docTR's torch backend FIRST, before the PaddlePaddle
    engines. Paddle and torch ship conflicting copies of a shared native runtime; if Paddle
    loads first, torch's shm.dll fails to resolve its dependency (WinError 127) and docTR
    silently disables. Loading torch first lets both coexist for the process lifetime. The
    Paddle getters also call _preload_torch() so this ordering holds even off the warmup path."""
    _get_doctr()
    _get_ppocr()
    if _USE_STRUCTURE:
        _get_ppstructure()


# --- Input decoding ---------------------------------------------------------
def image_bytes_to_array(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    return np.array(img)


def pdf_to_images(data: bytes, dpi: int = 150):
    """Render each PDF page to an RGB numpy array (PyMuPDF, no external binaries)."""
    import fitz  # PyMuPDF
    doc = fitz.open(stream=data, filetype="pdf")
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    imgs = []
    try:
        for page in doc:
            pix = page.get_pixmap(matrix=mat, alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            imgs.append(np.array(img))
    finally:
        doc.close()
    return imgs


# --- Geometry helpers -------------------------------------------------------
def _poly_to_box(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return [min(xs), min(ys), max(xs), max(ys)]


def _cy(b):
    return (b[1] + b[3]) / 2.0


def _cx(b):
    return (b[0] + b[2]) / 2.0


def _v_overlap(a, b):
    top = max(a[1], b[1]); bot = min(a[3], b[3])
    return max(0.0, bot - top)


def _h_overlap(a, b):
    left = max(a[0], b[0]); right = min(a[2], b[2])
    return max(0.0, right - left)


# --- Engine passes ----------------------------------------------------------
def _doctr_lines(page_arr):
    model = _get_doctr()
    if model is None:
        return []
    result = model([page_arr])
    doc = result.export()
    out = []
    for page in doc.get("pages", []):
        h, w = page["dimensions"]
        for block in page.get("blocks", []):
            for line in block.get("lines", []):
                words = line.get("words", [])
                if not words:
                    continue
                text = " ".join(wd["value"] for wd in words).strip()
                if not text:
                    continue
                confs = [wd.get("confidence", 0.0) for wd in words]
                conf = sum(confs) / len(confs) if confs else 0.0
                (x0, y0), (x1, y1) = line["geometry"]
                box = [x0 * w, y0 * h, x1 * w, y1 * h]
                out.append({"text": text, "box": box, "conf": round(conf * 100, 1)})
    return out


def _ppocr_lines(page_arr):
    ocr = _get_ppocr()
    res = ocr.ocr(page_arr, cls=True)
    out = []
    if not res:
        return out
    page = res[0] if (len(res) == 1 and isinstance(res[0], list)) else res
    for item in page or []:
        if not item:
            continue
        try:
            box, (txt, conf) = item[0], item[1]
        except Exception:  # noqa: BLE001
            continue
        txt = (txt or "").strip()
        if not txt:
            continue
        out.append({"text": txt, "box": _poly_to_box(box), "conf": round(float(conf) * 100, 1)})
    return out


def _parse_table(html):
    """PCC face sheets are 2-column label/value tables. Turn each row into KV
    pairs (also handle 4-column key/val/key/val rows) and collect all cell text."""
    from bs4 import BeautifulSoup
    kv, texts = [], []
    try:
        soup = BeautifulSoup(html or "", "html.parser")
    except Exception:  # noqa: BLE001
        return kv, texts
    for tr in soup.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
        cells = [c for c in cells if c]
        texts.extend(cells)
        if len(cells) >= 2 and cells[0] and cells[1]:
            kv.append({"key": cells[0], "value": cells[1], "conf": 88})
        if len(cells) >= 4 and cells[2] and cells[3]:
            kv.append({"key": cells[2], "value": cells[3], "conf": 88})
    return kv, texts


def _ppstructure(page_arr):
    engine = _get_ppstructure()
    regions = engine(page_arr)
    lines, tables = [], []
    for reg in regions:
        rtype = reg.get("type")
        res = reg.get("res")
        if rtype == "table" and isinstance(res, dict) and res.get("html"):
            tables.append(res["html"])
        if isinstance(res, list):
            for item in res:
                txt = (item.get("text") or "").strip()
                if not txt:
                    continue
                conf = item.get("confidence", 0.0)
                poly = item.get("text_region")
                box = _poly_to_box(poly) if poly else reg.get("bbox", [0, 0, 0, 0])
                lines.append({"text": txt, "box": box, "conf": round(float(conf) * 100, 1)})
    return lines, tables


# --- Key/value pairing (geometric, form-aware) ------------------------------
_LABEL_HINT = (
    "name", "resident", "patient", "dob", "birth", "sex", "gender", "ssn",
    "social", "phone", "tel", "cell", "address", "insurance", "payer", "plan",
    "carrier", "policy", "member", "subscriber", "beneficiary", "medicaid",
    "medicare", "group", "hic", "id",
)


def _looks_like_label(t: str) -> bool:
    low = t.lower()
    return t.endswith(":") or any(h in low for h in _LABEL_HINT)


def _nearest_value(label, lines):
    """Prefer a value on the same row to the right; else the nearest line below."""
    lb = label["box"]
    right, below = None, None
    for cand in lines:
        if cand is label:
            continue
        cb = cand["box"]
        # same row, to the right
        if cb[0] >= lb[2] - 4 and _v_overlap(lb, cb) > 0.4 * (lb[3] - lb[1]):
            if right is None or cb[0] < right["box"][0]:
                right = cand
        # directly below, horizontally aligned
        elif cb[1] >= lb[3] - 4 and _h_overlap(lb, cb) > 0.3 * (lb[2] - lb[0]):
            if below is None or cb[1] < below["box"][1]:
                below = cand
    return right or below


def _build_kv(lines):
    kvs = []
    for ln in lines:
        t = ln["text"].strip()
        # inline "Key: Value"
        if ":" in t:
            k, v = t.split(":", 1)
            k, v = k.strip(), v.strip()
            if k and v:
                kvs.append({"key": k, "value": v, "conf": ln["conf"]})
                continue
            if k and not v and _looks_like_label(k + ":"):
                nv = _nearest_value(ln, lines)
                if nv:
                    kvs.append({"key": k, "value": nv["text"].strip(),
                                "conf": min(ln["conf"], nv["conf"])})
                continue
        # bare label -> nearest value
        if _looks_like_label(t):
            nv = _nearest_value(ln, lines)
            if nv and nv["text"].strip().lower() != t.lower():
                kvs.append({"key": t.rstrip(":").strip(), "value": nv["text"].strip(),
                            "conf": min(ln["conf"], nv["conf"])})
    return kvs


def _merged_text(pp_lines, doctr_lines):
    """docTR reads cleaner; use it as the text spine, top-to-bottom."""
    src = doctr_lines if doctr_lines else pp_lines
    ordered = sorted(src, key=lambda l: (round(_cy(l["box"]) / 12), _cx(l["box"])))
    return "\n".join(l["text"] for l in ordered)


def process_page(page_arr):
    ocr_lines = _ppocr_lines(page_arr)             # reliable raw text lines (spine)
    doctr_lines = _doctr_lines(page_arr)           # optional supplementary pass
    tables = []
    base = ocr_lines
    if _USE_STRUCTURE:
        pp_lines, tables = _ppstructure(page_arr)  # layout + table HTML (optional)
        if not base:
            base = pp_lines

    # Geometric KV from raw lines + structured KV from table rows (table first,
    # since 2-column label/value rows are the cleanest source on face sheets).
    kv = _build_kv(base)
    table_text = []
    for html in tables:
        tkv, ttext = _parse_table(html)
        kv = tkv + kv
        table_text.extend(ttext)

    text = _merged_text(base, doctr_lines)
    if table_text:
        text += ("\n" if text else "") + "\n".join(table_text)

    h, w = page_arr.shape[0], page_arr.shape[1]
    return {
        "width": int(w),
        "height": int(h),
        "kv": kv,
        # Raw table HTML is intentionally NOT returned — only its extracted text
        # is merged into `text`, so no markup ever crosses to the API/UI.
        "tableCount": len(tables),
        "ppLines": base,
        "doctrLines": doctr_lines,
        "text": text,
    }
