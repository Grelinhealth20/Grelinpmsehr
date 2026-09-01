import { Router } from 'express';
import * as ctrl from '../controllers/encounterController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import {
  updateEncounterSchema, createEncounterSchema, createNoteSchema, updateNoteSchema, signNoteSchema, amendNoteSchema,
} from '../validation/schemas.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
router.post('/', csrfProtection, validate(createEncounterSchema), ctrl.createEncounter);

// Note templates available to the current provider (filtered to their service line).
router.get('/note-templates', ctrl.noteTemplates);

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
