import { Router } from 'express';
import * as userController from '../controllers/userController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../config/env.js';
import {
  createUserSchema,
  updateUserSchema,
  statusSchema,
  adminResetPasswordSchema,
  setUserFacilitiesSchema,
  uuidParam,
} from '../validation/schemas.js';

const router = Router();

// Every route here requires an authenticated admin whose password is settled.
router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

// Live NPPES lookup for an individual provider (by NPI or name) — declared before
// the :uuid routes so "/nppes" is not captured as a user id.
router.get('/nppes', userController.nppesProviderSearch);

router.get('/', userController.list);
router.post('/', csrfProtection, validate(createUserSchema), userController.create);

router.get('/:uuid', validate(uuidParam, 'params'), userController.getOne);
router.patch(
  '/:uuid',
  csrfProtection,
  validate(uuidParam, 'params'),
  validate(updateUserSchema),
  userController.update,
);
router.patch(
  '/:uuid/status',
  csrfProtection,
  validate(uuidParam, 'params'),
  validate(statusSchema),
  userController.changeStatus,
);
router.post(
  '/:uuid/reset-password',
  csrfProtection,
  validate(uuidParam, 'params'),
  validate(adminResetPasswordSchema),
  userController.adminResetPassword,
);
router.delete('/:uuid', csrfProtection, validate(uuidParam, 'params'), userController.remove);

// Facility assignments for a provider / billing user.
router.get('/:uuid/facilities', validate(uuidParam, 'params'), userController.facilities);
router.put('/:uuid/facilities', csrfProtection, validate(uuidParam, 'params'), validate(setUserFacilitiesSchema), userController.setFacilities);

export default router;
