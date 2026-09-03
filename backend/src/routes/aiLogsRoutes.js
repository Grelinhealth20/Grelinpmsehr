import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ROLES } from '../config/env.js';
import { listAiUsage } from '../services/aiUsageService.js';

/**
 * Super-Admin AI usage logs — every AI (custom-template) request with real OpenAI token spend,
 * captured in real time. Read-only; super/master admin only.
 */
const router = Router();
router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    res.json(await listAiUsage({ page, pageSize }));
  } catch (err) { next(err); }
});

export default router;
