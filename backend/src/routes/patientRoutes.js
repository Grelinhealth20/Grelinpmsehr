import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/patientController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { createPatientSchema, updatePatientSchema, uuidParam, importEligibilitySchema, verifyEligibilitySchema } from '../validation/schemas.js';

// In-memory upload; capped so a large file can never exhaust the process.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const router = Router();

// Any authenticated user with a settled password manages their OWN patients.
router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
// Stateless face-sheet auto-fill: OCR a face sheet BEFORE the patient exists.
// Nothing is written to S3 or the DB — the buffer is processed in memory only.
router.post('/extract-upload', csrfProtection, upload.single('file'), ctrl.extractUpload);
router.post('/', csrfProtection, validate(createPatientSchema), ctrl.create);
router.get('/:uuid', validate(uuidParam, 'params'), ctrl.getOne);
router.patch('/:uuid', csrfProtection, validate(uuidParam, 'params'), validate(updatePatientSchema), ctrl.update);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), ctrl.remove);

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
router.post('/:uuid/documents', csrfProtection, validate(uuidParam, 'params'), upload.single('file'), ctrl.uploadDoc);
router.get('/:uuid/documents/:docUuid/url', validate(uuidParam, 'params'), ctrl.getDocUrl);
router.post('/:uuid/documents/:docUuid/extract', csrfProtection, validate(uuidParam, 'params'), ctrl.extractDoc);
router.delete('/:uuid/documents/:docUuid', csrfProtection, validate(uuidParam, 'params'), ctrl.deleteDoc);

export default router;
