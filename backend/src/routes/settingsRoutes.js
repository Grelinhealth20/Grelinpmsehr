import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../config/env.js';
import { updateSettingsSchema } from '../validation/schemas.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { recordAudit } from '../services/auditService.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

// Any authenticated user may READ the public feature flags (the EHR needs to know
// whether to surface eligibility verification). No PHI here.
router.get('/', async (req, res, next) => {
  try {
    res.json({ settings: await getSettings() });
  } catch (err) { next(err); }
});

// Only a super/master admin may CHANGE a system setting.
router.patch('/', csrfProtection, authorize(ROLES.SUPER_ADMIN), validate(updateSettingsSchema), async (req, res, next) => {
  try {
    const { settings, applied } = await updateSettings(req.body, req.authUserId);
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'settings.update',
      entityType: 'settings',
      entityId: 'system',
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { applied },
    });
    res.json({ settings });
  } catch (err) { next(err); }
});

export default router;
