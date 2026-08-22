import { Router } from 'express';
import * as ctrl from '../controllers/encounterController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { updateEncounterSchema } from '../validation/schemas.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

router.get('/', ctrl.list);
router.patch('/:appointmentUuid', csrfProtection, validate(updateEncounterSchema), ctrl.updateStatus);

export default router;
