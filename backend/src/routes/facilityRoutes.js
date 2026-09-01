import { Router } from 'express';
import * as ctrl from '../controllers/facilityController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../config/env.js';
import {
  createFacilitySchema, updateFacilitySchema, facilityStatusSchema,
  assignProviderSchema, uuidParam, providerUuidParam,
} from '../validation/schemas.js';

const router = Router();

// Facility administration is restricted to Super/Master admins.
router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

// Live NPPES lookup (by NPI or name) — declared before the :uuid routes.
router.get('/nppes', ctrl.nppesSearch);

router.get('/', ctrl.list);
router.post('/', csrfProtection, validate(createFacilitySchema), ctrl.create);

router.get('/:uuid', validate(uuidParam, 'params'), ctrl.getOne);
router.patch('/:uuid', csrfProtection, validate(uuidParam, 'params'), validate(updateFacilitySchema), ctrl.update);
router.post('/:uuid/status', csrfProtection, validate(uuidParam, 'params'), validate(facilityStatusSchema), ctrl.status);
// Per-facility feature switches: coding engine (claims scrubbing) and eligibility verification.
router.post('/:uuid/flags', csrfProtection, validate(uuidParam, 'params'), ctrl.flags);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), ctrl.remove);

// Provider ⇄ facility assignment.
router.post('/:uuid/providers', csrfProtection, validate(uuidParam, 'params'), validate(assignProviderSchema), ctrl.assign);
router.delete('/:uuid/providers/:providerUuid', csrfProtection, validate(providerUuidParam, 'params'), ctrl.unassign);

export default router;
