/**
 * Provider Reports + RVU Payscale routes. Provider-facing EHR surface: same guard chain as the encounter
 * routes (authenticate + password-settled + EHR access). All GET (read-only) — the provider is taken from
 * the session, so no CSRF and no client-supplied provider id. Strictly own-data.
 */
import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { requireEhrAccess } from '../middleware/permissions.js';
import { authorize } from '../middleware/authorize.js';
import { ROLES } from '../config/env.js';
import * as ctrl from '../controllers/reportsController.js';

const router = Router();
router.use(authenticate, requirePasswordSettled);

// ADMIN (master + super admin) — group-wide per-provider pay. Defined BEFORE requireEhrAccess so it is
// gated by role (admins do not carry EHR access), never exposing another provider's data to a provider.
router.get('/admin/payscale', authorize(ROLES.SUPER_ADMIN), ctrl.adminPayscale);
router.get('/admin/download/encounters', authorize(ROLES.SUPER_ADMIN), ctrl.adminDownloadEncounters); // .xlsx
router.get('/admin/download/billing', authorize(ROLES.SUPER_ADMIN), ctrl.adminDownloadBilling);       // .xlsx
// Payroll: pay-period LOCK. Finalize + history = super/master; REOPEN a locked period = master only.
router.post('/admin/payroll/finalize', authorize(ROLES.SUPER_ADMIN), ctrl.finalize);
router.get('/admin/payroll/snapshots', authorize(ROLES.SUPER_ADMIN), ctrl.listFinalized);
router.post('/admin/payroll/reopen/:uuid', authorize(ROLES.MASTER_ADMIN), ctrl.reopen);

// Provider-facing — strictly the logged-in provider's OWN data.
router.use(requireEhrAccess);
router.get('/summary', ctrl.summary);        // encounters / types / signed+unsigned notes / patients visited
router.get('/payscale', ctrl.payscale);      // RVU-based pay for the current provider (real-time)
router.get('/pay-periods', ctrl.payPeriods); // bi-weekly / monthly pay history
router.get('/statement', ctrl.statement);    // monthly statement: procedures × weeks × POS × pay
router.get('/download/encounters', ctrl.downloadEncounters); // .xlsx visit/encounters report (own)
router.get('/download/billing', ctrl.downloadBilling);       // .xlsx detailed billing/claim report (own)

export default router;
