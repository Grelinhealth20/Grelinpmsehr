import { Router } from 'express';
import multer from 'multer';
import * as ctrl from '../controllers/referralController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { ROLES } from '../config/env.js';
import { referralsEnabledForProvider } from '../services/facilityFaxService.js';

// Per-facility REFERRAL FEATURE gate: if a Super Admin has disabled Referrals for the user's facility
// (and all their facilities), every provider-facing referral endpoint is refused with a clear code.
// Super Admin oversight/config routes are NOT gated (they manage disabled facilities).
async function requireReferralsEnabled(req, res, next) {
  try {
    if (await referralsEnabledForProvider(req.authUserId)) return next();
    return res.status(403).json({ error: 'The Referrals feature is disabled for your facility. Contact your administrator.', code: 'REFERRALS_DISABLED' });
  } catch (err) { return next(err); }
}

// In-memory upload for enclosed PDF records — capped so a large file can't exhaust the process, and
// bounded field/parts so a crafted multipart can't balloon memory.
const attachUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 5, fieldSize: 100 * 1000, parts: 10 } });

const router = Router();

// Every referral endpoint requires an authenticated user with a settled password. All data access is
// OWNER-SCOPED inside the service (WHERE provider_id = authUserId) — a provider only ever reaches their
// own referrals; there is no cross-provider read/write path.
router.use(authenticate, requirePasswordSettled);

// Super Admin oversight — ALL referrals across every facility (declared before '/:uuid' so 'admin'
// isn't mistaken for a referral id, and BEFORE the feature gate so admins manage disabled facilities).
router.get('/admin/list', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), ctrl.adminList);
router.get('/admin/stats', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), ctrl.adminStats);
// Sync the Fax.Plus inbox directly (catch any received fax a webhook missed). Super Admin only.
router.post('/admin/poll-inbox', authorize(ROLES.SUPER_ADMIN, ROLES.MASTER_ADMIN), csrfProtection, ctrl.adminSyncInbox);

// From here on, every provider-facing referral endpoint requires the facility's Referrals feature to be ON.
router.use(requireReferralsEnabled);

router.get('/options', ctrl.referralOptions); // specialties / directions / priorities / statuses
router.get('/nppes', ctrl.nppesLookup); // NPI registry lookup for the referred-to consultant/facility
router.get('/stats', ctrl.stats);
router.post('/refresh-inbox', csrfProtection, ctrl.refreshInbox); // force a live fetch of incoming faxes (manual Refresh)
router.get('/', ctrl.list);
router.post('/', csrfProtection, ctrl.create);
router.get('/:uuid', ctrl.getOne);
router.patch('/:uuid', csrfProtection, ctrl.update);
router.delete('/:uuid', csrfProtection, ctrl.remove);
router.get('/:uuid/letter', ctrl.generate); // deterministic Part B consultation letter (text)
router.get('/:uuid/pdf', ctrl.pdf); // enterprise referral PDF (facility letterhead) — preview + download
router.get('/:uuid/received-document', ctrl.receivedDocument); // stream an incoming fax's received PDF (read-scoped)
router.post('/:uuid/fax', csrfProtection, ctrl.sendFax); // send this referral out via Fax.Plus
router.post('/:uuid/fax/ai', csrfProtection, ctrl.faxAiRun); // on-demand Fax.Plus AI (button-triggered)
router.post('/:uuid/fax/restore', csrfProtection, ctrl.restoreDocument); // re-fetch a missing received document (no data loss)
router.get('/:uuid/fax/status', ctrl.reconcileFax); // pull authoritative fax status from Fax.Plus (real-time sync)
// Enclosed-record attachments (uploaded PDFs added to the faxed package)
router.get('/:uuid/attachments', ctrl.listAttachments);
router.post('/:uuid/attachments', csrfProtection, attachUpload.single('file'), ctrl.uploadAttachment);
router.delete('/:uuid/attachments/:attUuid', csrfProtection, ctrl.removeAttachment);

export default router;
