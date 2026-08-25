import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ROLES } from '../config/env.js';
import { listAudit } from '../services/auditService.js';

const router = Router();

router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, action, role, actorUuid, facilityUuid, dateFrom, dateTo, q } = req.query;
    const entries = await listAudit({ limit, offset, action, role, actorUuid, facilityUuid, dateFrom, dateTo, q });
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

export default router;
