import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { authenticate } from '../middleware/authenticate.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import { loginSchema, changePasswordSchema } from '../validation/schemas.js';

const router = Router();

// Unauthenticated. Rate-limited to resist credential stuffing.
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/refresh', authLimiter, authController.refresh);
router.post('/logout', authController.logout);

// Authenticated. Note: change-password intentionally does NOT require the
// password to be "settled", so the forced first-login reset can complete.
router.get('/me', authenticate, authController.me);
router.post(
  '/change-password',
  authenticate,
  csrfProtection,
  validate(changePasswordSchema),
  authController.changePassword,
);

export default router;
