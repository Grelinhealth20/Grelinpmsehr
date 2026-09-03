import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/encounterController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { aiLimiter, ocrLimiter } from '../middleware/rateLimiters.js';

// In-memory upload for encounter lab/imaging attachments; capped at 25 MB (imaging can be large).
// Field caps bound the non-file multipart parts (buffered in memory) too.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 20, fieldSize: 100 * 1000, parts: 30 },
});
import {
  updateEncounterSchema, createEncounterSchema, createNoteSchema, updateNoteSchema, signNoteSchema, amendNoteSchema,
} from '../validation/schemas.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
router.post('/', csrfProtection, validate(createEncounterSchema), ctrl.createEncounter);

// Note templates available to the current provider (filtered to their service line).
router.get('/note-templates', ctrl.noteTemplates);

// Custom (provider-authored) note templates — owner-scoped CRUD.
router.get('/custom-templates', ctrl.listCustomTemplates);
router.post('/custom-templates', csrfProtection, ctrl.createCustomTemplate);
// AI-assisted DRAFT generation (returns a draft to review/edit/save; nothing persisted here).
// Per-provider rate limit — each call spends real OpenAI tokens.
router.post('/custom-templates/generate', csrfProtection, aiLimiter, ctrl.generateCustomTemplate);
router.put('/custom-templates/:uuid', csrfProtection, ctrl.updateCustomTemplate);
router.delete('/custom-templates/:uuid', csrfProtection, ctrl.deleteCustomTemplate);

// Encounter lab / imaging document attachments (S3-backed, per-encounter folders).
router.get('/:encounterUuid/documents', ctrl.listEncounterDocs);
router.post('/:encounterUuid/documents', csrfProtection, ocrLimiter, docUpload.single('file'), ctrl.uploadEncounterDoc);
router.get('/documents/:docUuid/url', ctrl.encounterDocUrl);
router.delete('/documents/:docUuid', csrfProtection, ctrl.deleteEncounterDoc);

// Server-side pagination (enterprise scale) — literal paths before param routes.
router.get('/patients', ctrl.listPatients);
router.get('/clinical-records', ctrl.clinicalRecords);
router.get('/patient/:patientUuid/encounters', ctrl.patientEncounters);
router.get('/patient/:patientUuid/rx-context', ctrl.rxContext);

// Clinical notes. Literal `/notes/...` segments are declared before the
// `/:appointmentUuid` param route so they never collide. (UUIDs are bound query
// params — an invalid one simply resolves to 404.)
router.get('/notes/:noteUuid', ctrl.getNote);
router.get('/notes/:noteUuid/pdf', ctrl.downloadNote);
// Billable codes captured on a note (diagnoses SNOMED→ICD-10, procedures CPT) + Part B scrub.
router.get('/notes/:noteUuid/codes', ctrl.getNoteCodes);
// Deterministic auto-coding suggestions from the note content (diagnoses + visit charge).
router.get('/notes/:noteUuid/predict', ctrl.predictNoteCodes);
router.put('/notes/:noteUuid/codes', csrfProtection, ctrl.saveNoteCodes);
router.post('/notes/:noteUuid/scrub', csrfProtection, ctrl.scrubNote);
router.patch('/notes/:noteUuid', csrfProtection, validate(updateNoteSchema), ctrl.updateNote);
router.post('/notes/:noteUuid/sign', csrfProtection, validate(signNoteSchema), ctrl.signNote);
router.post('/notes/:noteUuid/amend', csrfProtection, validate(amendNoteSchema), ctrl.amendNote);

router.get('/:encounterUuid/details', ctrl.encounterDetails);
router.get('/:encounterUuid/notes', ctrl.listNotes);
router.post('/:encounterUuid/notes', csrfProtection, validate(createNoteSchema), ctrl.createNote);

router.patch('/:appointmentUuid', csrfProtection, validate(updateEncounterSchema), ctrl.updateStatus);

export default router;
