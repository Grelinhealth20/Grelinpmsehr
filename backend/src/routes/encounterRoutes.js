import { Router } from 'express';
import * as ctrl from '../controllers/encounterController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import {
  updateEncounterSchema, createEncounterSchema, createNoteSchema, updateNoteSchema, signNoteSchema,
} from '../validation/schemas.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
router.post('/', csrfProtection, validate(createEncounterSchema), ctrl.createEncounter);

// Server-side pagination (enterprise scale) — literal paths before param routes.
router.get('/patients', ctrl.listPatients);
router.get('/patient/:patientUuid/encounters', ctrl.patientEncounters);

// Clinical notes. Literal `/notes/...` segments are declared before the
// `/:appointmentUuid` param route so they never collide. (UUIDs are bound query
// params — an invalid one simply resolves to 404.)
router.get('/notes/:noteUuid', ctrl.getNote);
router.patch('/notes/:noteUuid', csrfProtection, validate(updateNoteSchema), ctrl.updateNote);
router.post('/notes/:noteUuid/sign', csrfProtection, validate(signNoteSchema), ctrl.signNote);

router.get('/:encounterUuid/notes', ctrl.listNotes);
router.post('/:encounterUuid/notes', csrfProtection, validate(createNoteSchema), ctrl.createNote);

router.patch('/:appointmentUuid', csrfProtection, validate(updateEncounterSchema), ctrl.updateStatus);

export default router;
