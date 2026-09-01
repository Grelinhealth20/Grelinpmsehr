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

// MFA (in-house TOTP). Authenticated (a session exists post-password) but NOT password-settled/
// MFA-settled gated — these ARE the endpoints that complete the MFA stage. Rate-limited to resist
// code brute-forcing; each acts only on the authenticated user.
router.post('/mfa/setup', authenticate, csrfProtection, authController.mfaSetup);
router.post('/mfa/enroll', authenticate, csrfProtection, authLimiter, authController.mfaEnroll);
router.post('/mfa/verify', authenticate, csrfProtection, authLimiter, authController.mfaVerify);
router.post('/mfa/recovery', authenticate, csrfProtection, authLimiter, authController.mfaRecovery);

export default router;
