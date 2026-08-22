import { Router } from 'express';
import * as appt from '../controllers/appointmentController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { createAppointmentSchema, updateAppointmentSchema, uuidParam } from '../validation/schemas.js';

const router = Router();

// Any authenticated user with a settled password manages their OWN schedule.
router.use(authenticate, requirePasswordSettled);

router.get('/', appt.list);
router.post('/', csrfProtection, validate(createAppointmentSchema), appt.create);
router.patch('/:uuid', csrfProtection, validate(uuidParam, 'params'), validate(updateAppointmentSchema), appt.update);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), appt.remove);

export default router;
