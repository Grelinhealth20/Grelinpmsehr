import { v4 as uuidv4 } from 'uuid';
import {
  listPatients, createPatient, updatePatient, applyPatientUpdateLocked, deletePatient, getRawByUuid, toPublicPatient, getPatientS3Ctx,
} from '../services/patientService.js';
import {
  listDocuments, getRawDocByUuid, findDocByType,
  createDocumentRecord, deleteDocumentRecord,
} from '../services/patientDocumentService.js';
import {
  s3Enabled, ensurePatientFolder, uploadPatientObject, signedGetUrl, deleteObject, deleteObjects, getObjectBytes, listPatientKeys,
} from '../services/s3Service.js';
import { extractDocument, ocrEnabled } from '../services/docExtractService.js';
import { saveCheck, listChecks, mergeVerificationIntoPatient } from '../services/eligibilityService.js';
import { verifyPatientEligibility, autoVerifyOnCreate, latestCheckForPolicy } from '../services/eligibilityWorkflow.js';
import { stediEnabled } from '../services/stediService.js';
import { recordAudit } from '../services/auditService.js';
import { faceSheetPdf, benefitsPdf } from '../services/pdfExport.js';
import { logger } from '../config/logger.js';

function sendPdf(res, out) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', out.buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.buffer);
}

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
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.create', entityType: 'patient', entityId: patient.uuid, ...ctx(req), metadata: { mrn: patient.mrn } });

    // Respond IMMEDIATELY after the DB write — the save never waits on S3 folder
    // creation or the real-time eligibility call (which take seconds). Both run in
    // the BACKGROUND; the payer-confirmed Face Sheet + benefits appear on the next
    // load / the Benefits tab. This keeps patient creation instant.
    res.status(201).json({ patient });

    const auditCtx = ctx(req); const actorUserId = req.authUserId;
    setImmediate(async () => {
      // Best-effort S3 folder marker.
      if (s3Enabled()) {
        try { const s3ctx = await getPatientS3Ctx(patient.uuid); if (s3ctx) await ensurePatientFolder(s3ctx); }
        catch (e) { logger.warn({ err: e.message }, 'patient folder create failed'); }
      }
      // Auto-trigger real-time eligibility (server-side). Non-fatal; writes back the
      // confirmed Face Sheet + benefits onto the patient record.
      try {
        const row = await getRawByUuid(patient.uuid);
        if (row) {
          const r = await autoVerifyOnCreate({ patient: toPublicPatient(row), patientId: row.id, providerId: row.provider_id });
          if (r?.check) await recordAudit({ actorUserId, action: 'patient.eligibility.verify', entityType: 'patient', entityId: patient.uuid, ...auditCtx, metadata: { auto: true, status: r.check.status, payer: r.payer?.name } });
        }
      } catch (e) { logger.warn({ err: e.message }, 'auto eligibility on create failed'); }
    });
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
      // Purge the patient's ENTIRE S3 folder (records, signed note documents, the
      // .keep marker — every object under the patient's hierarchical prefix) so no
      // PHI is left behind.
      try {
        const s3ctx = await getPatientS3Ctx(row.uuid);
        if (s3ctx) {
          const keys = await listPatientKeys(s3ctx);
          if (keys.length) await deleteObjects(keys);
        }
      } catch { /* best-effort */ }
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

    const key = `${docType}/${uuidv4()}${ext}`; // stored under the patient's hierarchical folder
    const s3ctx = await getPatientS3Ctx(row.uuid);
    if (s3ctx) { try { await ensurePatientFolder(s3ctx); } catch { /* best-effort */ } }
    const s3Key = await uploadPatientObject(s3ctx, key, req.file.buffer, req.file.mimetype);
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

/* --- Benefits Verification (X12 271 eligibility) --------------------------- */
export async function listEligibility(req, res, next) {
  try {
    const row = await ownedPatientOr404(req); // owner-only: no cross-patient benefits
    res.json({ checks: await listChecks(row.id) });
  } catch (err) { next(err); }
}

const SKIP_MSG = {
  no_insurance: 'Add insurance before verifying eligibility.',
  no_member_id: 'A member ID is required to verify eligibility.',
  no_payer: 'A payer is required to verify eligibility.',
  no_dob: 'Date of birth is required to verify eligibility.',
  no_name: 'Patient first and last name are required to verify eligibility.',
  payer_unresolved: 'Could not match this payer in the payer directory — check the payer name on the face sheet.',
  no_facility_npi: 'This provider has no assigned facility NPI — assign a facility first.',
  no_facility_state: 'The facility has no state on file — needed to route a Medicare Part B check.',
  no_dos: 'A date of service is required to verify eligibility.',
  stedi_disabled: 'Eligibility service is not configured.',
};

/** Live, server-side eligibility check (Stedi) — all inputs come from the Face Sheet. */
export async function verifyNow(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    if (!stediEnabled()) return res.status(503).json({ error: 'Eligibility service is not configured.', code: 'STEDI_DISABLED' });
    const policyIndex = Number(req.body?.policyIndex) || 0;
    const procedureCodes = Array.isArray(req.body?.procedureCodes) ? req.body.procedureCodes : [];
    const dosOverride = req.body?.dateOfService || null; // provider-set DOS (YYYY-MM-DD)
    // provider.npi = the patient's RENDERING provider's assigned facility NPI.
    // A manual "Verify" is always a deliberate user action → force a fresh check
    // (this is what bypasses the automatic same-insurance de-dupe / 2-call cap).
    const r = await verifyPatientEligibility({
      patient: toPublicPatient(row), patientId: row.id, providerId: row.provider_id,
      policyIndex, procedureCodes, dosOverride, force: true,
    });
    if (r.skipped === 'insurance_reused' || r.skipped === 'duplicate_this_month') {
      const existing = await latestCheckForPolicy(row.id, policyIndex);
      return res.json({ check: existing, patient: toPublicPatient(await getRawByUuid(row.uuid)), skipped: r.skipped });
    }
    if (r.skipped) return res.status(422).json({ error: SKIP_MSG[r.skipped] || 'Eligibility could not be verified.', code: `ELIG_${r.skipped.toUpperCase()}` });
    await recordAudit({
      actorUserId: req.authUserId, action: 'patient.eligibility.verify', entityType: 'patient', entityId: row.uuid,
      ...ctx(req), metadata: { policyIndex, payer: r.payer?.name, status: r.check?.status, live: true },
    });
    res.status(201).json({ check: r.check, patient: r.patient });
  } catch (err) {
    if (err.code === 'STEDI_US_IP_REQUIRED') {
      return res.status(502).json({
        error: 'Medicare eligibility requires a U.S.-based server connection. This environment’s network location is outside the U.S., so the payer rejected the request. Commercial payers are unaffected — deploy the backend on a U.S. host to enable Medicare Part B checks.',
        code: err.code,
      });
    }
    if (err.code && String(err.code).startsWith('STEDI')) {
      return res.status(502).json({ error: err.message, code: err.code });
    }
    next(err);
  }
}

/** Download the patient Face Sheet as a branded, non-editable PDF. Owner-scoped. */
export async function downloadFaceSheet(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    const out = await faceSheetPdf(row);
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.facesheet.download', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { format: 'pdf' } });
    sendPdf(res, out);
  } catch (err) { next(err); }
}

/** Download the patient's verified benefits as a branded, non-editable PDF. Owner-scoped. */
export async function downloadBenefits(req, res, next) {
  try {
    const row = await ownedPatientOr404(req);
    const policyIndex = Number(req.query?.policyIndex) || 0;
    const out = await benefitsPdf(row, policyIndex);
    if (!out) return res.status(404).json({ error: 'No verified benefits to download for this patient.', code: 'NO_BENEFITS' });
    await recordAudit({ actorUserId: req.authUserId, action: 'patient.benefits.download', entityType: 'patient', entityId: row.uuid, ...ctx(req), metadata: { format: 'pdf', policyIndex } });
    sendPdf(res, out);
  } catch (err) { next(err); }
}

/** Ingest a payer 271 response the caller already holds (programmatic integration). */
export async function importEligibility(req, res, next) {
  try {
    const row = await ownedPatientOr404(req); // patient-scoped write
    const { policyIndex = 0, response } = req.body;
    const check = await saveCheck({ patientId: row.id, policyIndex, response, createdBy: req.authUserId });
    // Payer-confirmed identity (address, group #, MBI, plan, cost-shares) corrects
    // the Face Sheet + this insurance policy — for THIS patient only. Applied under a
    // row lock against the freshest record so a concurrent edit is never clobbered.
    let appliedKeys = [];
    const patient = await applyPatientUpdateLocked(row.uuid, (cur) => {
      const p = mergeVerificationIntoPatient(cur, check.summary, policyIndex);
      appliedKeys = Object.keys(p);
      return p;
    });
    await recordAudit({
      actorUserId: req.authUserId, action: 'patient.eligibility.verify', entityType: 'patient', entityId: row.uuid,
      ...ctx(req), metadata: { policyIndex, payer: check.payer, status: check.status, updated: appliedKeys },
    });
    res.status(201).json({ check, patient });
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
