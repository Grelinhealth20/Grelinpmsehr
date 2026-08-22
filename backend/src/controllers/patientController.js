import { v4 as uuidv4 } from 'uuid';
import {
  listPatients, createPatient, updatePatient, deletePatient, getRawByUuid, toPublicPatient,
} from '../services/patientService.js';
import {
  listDocuments, listRawDocuments, getRawDocByUuid, findDocByType,
  createDocumentRecord, deleteDocumentRecord,
} from '../services/patientDocumentService.js';
import {
  s3Enabled, ensurePatientFolder, uploadPatientObject, signedGetUrl, deleteObject, deleteObjects, getObjectBytes,
} from '../services/s3Service.js';
import { extractDocument, ocrEnabled } from '../services/docExtractService.js';
import { recordAudit } from '../services/auditService.js';

const DOC_TYPES = new Set(['license_front', 'license_back', 'insurance_front', 'insurance_back', 'other']);
const ALLOWED_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
// Cards (license/insurance) are scans → images or PDF. Patient records → images
// (OCR-able scans), PDF, or Word documents.
const IMG_PDF = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const RECORDS_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const allowedMimes = (docType) => (docType === 'other' ? RECORDS_MIME : IMG_PDF);
const MAX_BYTES = 10 * 1024 * 1024;

/** STRICT isolation: a patient (and its documents) is only reachable by its owner. */
async function ownedPatientOr404(req) {
  const row = await getRawByUuid(req.params.uuid);
  if (!row) { const e = new Error('Patient not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  if (Number(row.provider_id) !== Number(req.authUserId)) {
    // 404 (not 403) so existence of other providers' patients isn't revealed.
    const e = new Error('Patient not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return row;
}
const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/* --- Patients -------------------------------------------------------------- */
export async function list(req, res, next) {
  try { res.json({ patients: await listPatients(req.authUserId) }); }
  catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const { demographics, insurance, facility, emergencyContact, emergencyContacts } = req.body;
    const patient = await createPatient({ providerId: req.authUserId, demographics, insurance, facility, emergencyContact, emergencyContacts, createdBy: req.authUserId });
    if (s3Enabled()) { try { await ensurePatientFolder(patient.uuid); } catch { /* folder marker is best-effort */ } }
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.create', entityType: 'patient', entityId: patient.uuid, ...ctx(req), metadata: { mrn: patient.mrn } });
    res.status(201).json({ patient });
  } catch (err) { next(err); }
}

export async function getOne(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    const documents = await listDocuments(row.id);
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.view', entityType: 'patient', entityId: row.uuid, ...ctx(req) });
    res.json({ patient: toPublicPatient(row), documents });
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    const patient = await updatePatient(row.uuid, req.body);
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.update', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { fields: Object.keys(req.body) } });
    res.json({ patient });
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    if (s3Enabled()) {
      const docs = await listRawDocuments(row.id);
      try { await deleteObjects([...docs.map((d) => d.s3_key), `patients/${row.uuid}/.keep`]); } catch { /* best-effort */ }
    }
    await deletePatient(row.uuid);
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.delete', entityType: 'patient', entityId: row.uuid, ...ctx(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

/* --- Documents ------------------------------------------------------------- */
export async function listDocs(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    res.json({ documents: await listDocuments(row.id) });
  } catch (err) { next(err); }
}

export async function uploadDoc(req, res, next) {
  try {
    if (!s3Enabled()) return res.status(503).json({ error: 'Document storage is not configured.', code: 'S3_DISABLED' });
    const row = await ownedPatientOr404(req);
    const docType = req.body.docType;
    if (!DOC_TYPES.has(docType)) return res.status(400).json({ error: 'Invalid document type.', code: 'BAD_DOC_TYPE' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.', code: 'NO_FILE' });
    const ext = ALLOWED_MIME[req.file.mimetype];
    if (!ext || !allowedMimes(docType).has(req.file.mimetype)) {
      const msg = docType === 'other' ? 'Records accept images, PDF or Word documents.' : 'Use JPG, PNG, WEBP or PDF.';
      return res.status(400).json({ error: `Unsupported file type. ${msg}`, code: 'BAD_MIME' });
    }
    if (req.file.size > MAX_BYTES) return res.status(400).json({ error: 'File exceeds the 10 MB limit.', code: 'TOO_LARGE' });

    // Replace an existing slot (e.g. re-upload license front) — delete the old object.
    if (docType !== 'other') {
      const existing = await findDocByType(row.id, docType);
      if (existing) { try { await deleteObject(existing.s3_key); } catch { /* ignore */ } await deleteDocumentRecord(existing.uuid); }
    }

    const key = `${docType}/${uuidv4()}${ext}`; // stored under patients/{patientUuid}/...
    const s3Key = await uploadPatientObject(row.uuid, key, req.file.buffer, req.file.mimetype);
    const doc = await createDocumentRecord({
      patientId: row.id, docType, s3Key, fileName: req.file.originalname,
      contentType: req.file.mimetype, size: req.file.size, uploadedBy: req.authUserId,
    });
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.document.upload', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { docType } });
    res.status(201).json({ document: doc });
  } catch (err) { next(err); }
}

export async function getDocUrl(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    const doc = await getRawDocByUuid(req.params.docUuid);
    if (!doc || Number(doc.patient_id) !== Number(row.id)) return res.status(404).json({ error: 'Document not found.', code: 'NOT_FOUND' });
    const url = await signedGetUrl(doc.s3_key, 300);
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.document.view', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { docType: doc.doc_type } });
    res.json({ url, expiresIn: 300 });
  } catch (err) { next(err); }
}

// Auto-fill supports OCR-able scans only (images + PDF), not Word docs.
const EXTRACT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/**
 * Stateless auto-fill: run OCR on an uploaded face sheet and return suggestions
 * WITHOUT persisting anything (no S3 object, no DB row). Lets the New Patient
 * form be populated before the patient is created. The in-memory buffer is
 * discarded when the request ends.
 */
export async function extractUpload(req, res, next) {
  try {
    if (!ocrEnabled()) return res.status(503).json({ error: 'Document extraction is not configured.', code: 'OCR_DISABLED' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.', code: 'NO_FILE' });
    if (!EXTRACT_MIME.has(req.file.mimetype)) return res.status(400).json({ error: 'Auto-fill supports image (JPG, PNG, WEBP) or PDF face sheets.', code: 'BAD_MIME' });
    if (req.file.size > MAX_BYTES) return res.status(400).json({ error: 'File exceeds the 10 MB limit.', code: 'TOO_LARGE' });

    const suggestions = await extractDocument({ buffer: req.file.buffer, contentType: req.file.mimetype, fileName: req.file.originalname });
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.extract.stateless', entityType: 'extraction', entityId: 'adhoc', ...ctx(req), metadata: { mime: req.file.mimetype, size: req.file.size } });
    res.json({ suggestions });
  } catch (err) { next(err); }
}

/** Auto-extract demographics + insurance suggestions from an uploaded document. */
export async function extractDoc(req, res, next) {
  try {
    if (!ocrEnabled()) return res.status(503).json({ error: 'Document extraction is not configured.', code: 'OCR_DISABLED' });
    if (!s3Enabled()) return res.status(503).json({ error: 'Document storage is not configured.', code: 'S3_DISABLED' });
    const row = await ownedPatientOr404(req);
    const doc = await getRawDocByUuid(req.params.docUuid);
    if (!doc || Number(doc.patient_id) !== Number(row.id)) return res.status(404).json({ error: 'Document not found.', code: 'NOT_FOUND' });

    // OCR runs on the raw bytes (image or PDF); fetch them from the patient's S3 folder.
    const buffer = await getObjectBytes(doc.s3_key);
    const fileName = `document${ALLOWED_MIME[doc.content_type] || ''}`;
    const suggestions = await extractDocument({ buffer, contentType: doc.content_type, fileName });

    await recordAudit({ actorUserId: req.authUserId, action: 'patient.document.extract', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { docType: doc.doc_type, engine: 'ppstructure+doctr' } });
    res.json({ suggestions });
  } catch (err) { next(err); }
}

export async function deleteDoc(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    const doc = await getRawDocByUuid(req.params.docUuid);
    if (!doc || Number(doc.patient_id) !== Number(row.id)) return res.status(404).json({ error: 'Document not found.', code: 'NOT_FOUND' });
    try { await deleteObject(doc.s3_key); } catch { /* ignore */ }
    await deleteDocumentRecord(doc.uuid);
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.document.delete', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { docType: doc.doc_type } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}
