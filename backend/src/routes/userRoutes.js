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
  uuidParam,
} from '../validation/schemas.js';

const router = Router();

// Every route here requires an authenticated admin whose password is settled.
router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

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

export default router;
