import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/patientController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { createPatientSchema, updatePatientSchema, uuidParam } from '../validation/schemas.js';

// In-memory upload; capped so a large file can never exhaust the process.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const router = Router();

// Any authenticated user with a settled password manages their OWN patients.
router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
router.post('/', csrfProtection, validate(createPatientSchema), ctrl.create);
router.get('/:uuid', validate(uuidParam, 'params'), ctrl.getOne);
router.patch('/:uuid', csrfProtection, validate(uuidParam, 'params'), validate(updatePatientSchema), ctrl.update);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), ctrl.remove);

// Documents (license / insurance images) — strictly scoped to the owned patient.
router.get('/:uuid/documents', validate(uuidParam, 'params'), ctrl.listDocs);
router.post('/:uuid/documents', csrfProtection, validate(uuidParam, 'params'), upload.single('file'), ctrl.uploadDoc);
router.get('/:uuid/documents/:docUuid/url', validate(uuidParam, 'params'), ctrl.getDocUrl);
router.delete('/:uuid/documents/:docUuid', csrfProtection, validate(uuidParam, 'params'), ctrl.deleteDoc);

export default router;
