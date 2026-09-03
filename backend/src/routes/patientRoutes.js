import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/patientController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { ocrLimiter } from '../middleware/rateLimiters.js';
import { ROLES } from '../config/env.js';
import { createPatientSchema, updatePatientSchema, uuidParam, importEligibilitySchema, verifyEligibilitySchema } from '../validation/schemas.js';

// In-memory upload; capped so a large file can never exhaust the process.
// Field caps bound the non-file multipart parts too (buffered in memory) so a
// crafted request can't balloon memory with thousands of tiny text fields.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20, fieldSize: 100 * 1000, parts: 30 },
});

// Stored patient RECORDS (medical / labs / imaging / insurance) — images, PDF, Word, NO OCR — accept
// large files up to 250 MB each. OCR paths keep the small 10 MB cap above (OCR of a huge image is a
// DoS vector); these are stored as-is and never OCR-processed, so a higher ceiling is safe.
const recordUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024, files: 1, fields: 20, fieldSize: 100 * 1000, parts: 30 },
});

const router = Router();

// Any authenticated user with a settled password manages their OWN patients.
router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
// Stateless face-sheet auto-fill: OCR a face sheet BEFORE the patient exists.
// Nothing is written to S3 or the DB — the buffer is processed in memory only.
router.post('/extract-upload', csrfProtection, ocrLimiter, upload.single('file'), ctrl.extractUpload);
router.post('/', csrfProtection, validate(createPatientSchema), ctrl.create);
router.get('/:uuid', validate(uuidParam, 'params'), ctrl.getOne);
router.patch('/:uuid', csrfProtection, validate(uuidParam, 'params'), validate(updatePatientSchema), ctrl.update);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), ctrl.remove);

// Break-glass emergency access (ONC (d)(6)): time-boxed, reason-mandatory, fully-audited override that
// lets an authorized CLINICIAN reach a patient outside their normal ownership scope in an emergency.
// Restricted to clinical roles (providers + admin oversight) — a billing user has no clinical reason to
// break-glass into a chart. The grant it issues is READ-ONLY (enforced in ownedPatientOr404: honored
// only for GET), so it can never be used to modify or delete another provider's patient record.
router.post('/:uuid/emergency-access', authorize(ROLES.PROVIDER, ROLES.SUPER_ADMIN), csrfProtection, validate(uuidParam, 'params'), ctrl.emergencyAccess);

// Benefits Verification (X12 271 eligibility) — strictly scoped to the owned patient.
router.get('/:uuid/eligibility', validate(uuidParam, 'params'), ctrl.listEligibility);
router.get('/:uuid/facesheet/pdf', validate(uuidParam, 'params'), ctrl.downloadFaceSheet);
router.get('/:uuid/benefits/pdf', validate(uuidParam, 'params'), ctrl.downloadBenefits);
// Live, server-side Stedi verification (inputs pulled from the Face Sheet).
router.post('/:uuid/eligibility/verify', csrfProtection, validate(uuidParam, 'params'), validate(verifyEligibilitySchema), ctrl.verifyNow);
// Programmatic ingest of a 271 the caller already holds.
router.post('/:uuid/eligibility', csrfProtection, validate(uuidParam, 'params'), validate(importEligibilitySchema), ctrl.importEligibility);

// Documents (license / insurance images) — strictly scoped to the owned patient.
router.get('/:uuid/documents', validate(uuidParam, 'params'), ctrl.listDocs);
router.post('/:uuid/documents', csrfProtection, validate(uuidParam, 'params'), recordUpload.single('file'), ctrl.uploadDoc);
router.get('/:uuid/documents/:docUuid/url', validate(uuidParam, 'params'), ctrl.getDocUrl);
router.post('/:uuid/documents/:docUuid/extract', csrfProtection, ocrLimiter, validate(uuidParam, 'params'), ctrl.extractDoc);
router.delete('/:uuid/documents/:docUuid', csrfProtection, validate(uuidParam, 'params'), ctrl.deleteDoc);

export default router;
