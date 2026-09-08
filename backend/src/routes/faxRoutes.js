import { Router } from 'express';
import * as ctrl from '../controllers/referralController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { ROLES } from '../config/env.js';

const router = Router();

// PUBLIC — the Fax.Plus (Svix) webhook. It carries NO user session; its authenticity is the Svix HMAC
// signature verified in the handler over the raw body. Must be declared BEFORE the authenticate guard.
router.post('/webhook', ctrl.faxWebhook);

// Everything below requires an authenticated user.
router.use(authenticate, requirePasswordSettled);
router.get('/status', ctrl.faxStatus); // non-secret integration status (any authenticated user)
// One-time OAuth consent + token exchange — admin only (yields the refresh token for .env).
router.get('/authorize-url', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), ctrl.faxAuthorizeUrl);
router.get('/oauth/callback', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), ctrl.faxOauthCallback);
// ACTIVATE live faxing straight from the UI: exchange the pasted OAuth code, persist the refresh token
// (encrypted), flip live in-process (no restart), and verify — Super Admin only.
router.post('/activate', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.faxActivate);
// ACTIVATE via a Personal Access Token (direct API, no OAuth) — verified live before storing. Super Admin.
router.post('/personal-token', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.faxSetPersonalToken);
router.post('/webhook-secret', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.faxSetWebhookSecret);
// Inbound webhook ENDPOINT registration (instant inbound) — Super Admin. The signing secret is dashboard-only.
router.get('/ai-status', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), ctrl.faxAiStatus);
router.get('/webhooks', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), ctrl.faxListWebhooks);
router.post('/webhooks', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.faxRegisterWebhook);
router.delete('/webhooks/:id', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.faxDeleteWebhook);
router.post('/deactivate', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.faxDeactivate);

export default router;
