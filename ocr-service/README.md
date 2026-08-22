# Grelin OCR Service — PP‑StructureV2 + docTR

Open-source document extraction for face sheets / PCC documents. Replaces AWS
Textract. A small **Python FastAPI** service loads two Apache‑2.0 models:

- **PP‑StructureV2** (PaddleOCR) — layout + table + key/value structure
- **docTR** — deep‑learning OCR/recognition (second, high‑accuracy pass)

The Node backend (`backend/src/services/docExtractService.js`) POSTs a document
to `/extract`, gets back structured OCR (key/value pairs + text), and maps it
into patient demographics + insurance **suggestions** (human‑in‑the‑loop; never
auto‑saved). All PHI field logic + validation lives in the Node service.

---

## 1) Run locally (Windows, for testing)

From `ocr-service/` in **PowerShell**:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8600
```

First boot downloads the model weights (a few hundred MB) and warms them up —
give it a minute. When you see `Models warmed up (PP-StructureV2 + docTR).`
it's ready.

> Python 3.10 recommended. If `paddlepaddle` fails to install on your Python
> version, use 3.10 (`py -3.10 -m venv .venv`).

### Smoke test

```bash
curl http://127.0.0.1:8600/health
# -> {"status":"ok","models":["pp-structure-v2","doctr"]}

# Extract from a real face sheet (point at your own file):
curl -X POST http://127.0.0.1:8600/extract -F "file=@C:/path/to/facesheet.pdf"
```

The response is `{ "pages": [ { kv, tables, text, ppLines, doctrLines } ], "pageCount": N }`.

---

## 2) Wire the backend

The backend already points at `http://127.0.0.1:8600` by default, so once the
service is running, **Auto‑fill in the app works with no further config**.

Optional overrides in `backend/.env`:

```
OCR_SERVICE_URL=http://127.0.0.1:8600
OCR_API_KEY=            # if set here, also set it in the service (below)
OCR_TIMEOUT_MS=60000
```

To require a shared key (recommended once off‑localhost), start the service with:

```powershell
$env:OCR_API_KEY="a-long-random-string"; uvicorn main:app --host 127.0.0.1 --port 8600
```

and set the same value as `OCR_API_KEY` in `backend/.env`.

---

## 3) Run in Docker

```bash
docker build -t grelin-ocr ./ocr-service
docker run --rm -p 8600:8600 -e OCR_API_KEY=change-me grelin-ocr
```

Point the backend at it: `OCR_SERVICE_URL=http://<docker-host>:8600`.

---

## 4) Deploy on AWS (production)

- Build the image and push to **ECR**.
- Run on **ECS Fargate** or an **EC2** instance in a **private subnet** — never
  expose `/extract` publicly; only the Node API should reach it.
- CPU works; for throughput at 25k pages/mo use a small **GPU** host (g5/g6) and
  swap the CPU paddle/torch wheels in `requirements.txt` for CUDA builds.
- Set `OCR_API_KEY` and pass it to the backend. Keep everything inside your
  AWS account so PHI never leaves your trust boundary (BAA scope).

---

## Accuracy & tuning

- KV pairing is **geometric** (label → nearest value right/below). Face‑sheet
  layouts vary, so after testing on your real documents you may want to tune the
  label lists in `backend/src/services/docExtractService.js` (`pick(...)`) and
  the `_LABEL_HINT` set in `extractor.py`.
- Insurance blocks that render as **tables** come back in `tables` (HTML) — if a
  payer/member ID is missed, that's the place to add parsing.
- Results are always **suggestions** the provider reviews before saving; SSN /
  DOB / ZIP are format‑validated in Node before they're offered.

## Privacy

- No document is written to disk — everything is processed in memory and
  discarded after the response. No test data is stored by the service.
