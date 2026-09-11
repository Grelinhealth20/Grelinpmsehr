import { Router } from 'express';
import * as ctrl from '../controllers/facilityController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../config/env.js';
import {
  createFacilitySchema, updateFacilitySchema, facilityStatusSchema, facilityFlagsSchema, facilityFaxConfigSchema,
  assignProviderSchema, uuidParam, providerUuidParam,
} from '../validation/schemas.js';

const router = Router();

// Facility administration is restricted to Super/Master admins.
router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

// Live NPPES lookup (by NPI or name) — declared before the :uuid routes.
router.get('/nppes', ctrl.nppesSearch);
// Per-facility referral FAX configuration (incoming/outgoing numbers) — before the :uuid routes so
// 'fax-config' is never parsed as a facility uuid.
router.get('/fax-config', ctrl.faxConfigList);

router.get('/', ctrl.list);
router.post('/', csrfProtection, validate(createFacilitySchema), ctrl.create);

router.get('/:uuid', validate(uuidParam, 'params'), ctrl.getOne);
router.patch('/:uuid', csrfProtection, validate(uuidParam, 'params'), validate(updateFacilitySchema), ctrl.update);
router.post('/:uuid/status', csrfProtection, validate(uuidParam, 'params'), validate(facilityStatusSchema), ctrl.status);
// Per-facility feature switches: coding engine (claims scrubbing) and eligibility verification.
router.post('/:uuid/flags', csrfProtection, validate(uuidParam, 'params'), validate(facilityFlagsSchema), ctrl.flags);
// Per-facility referral FAX numbers: { incomingNumber?, outgoingNumber?, enabled? }
router.put('/:uuid/fax-config', csrfProtection, validate(uuidParam, 'params'), validate(facilityFaxConfigSchema), ctrl.faxConfigSet);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), ctrl.remove);
// MASTER-ONLY: completely wipe all of a facility's data (patients/charts/encounters/appointments/
// referrals/documents in DB + S3 + facility-scoped audit trail). The controller enforces master_admin;
// body: { confirmName (must equal the facility name), deleteFacility? }.
router.post('/:uuid/master-wipe', authorize(ROLES.MASTER_ADMIN), csrfProtection, validate(uuidParam, 'params'), ctrl.masterWipe);

// Provider ⇄ facility assignment.
router.post('/:uuid/providers', csrfProtection, validate(uuidParam, 'params'), validate(assignProviderSchema), ctrl.assign);
router.delete('/:uuid/providers/:providerUuid', csrfProtection, validate(providerUuidParam, 'params'), ctrl.unassign);

export default router;
