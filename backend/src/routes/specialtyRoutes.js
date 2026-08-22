import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validate } from '../middleware/validate.js';
import { ROLES } from '../config/env.js';
import { createSpecialtySchema } from '../validation/schemas.js';
import { listSpecialties, createSpecialty, specialtyNameExists } from '../services/specialtyService.js';
import { recordAudit } from '../services/auditService.js';

const router = Router();

router.use(authenticate, requirePasswordSettled, authorize(ROLES.SUPER_ADMIN));

router.get('/', async (req, res, next) => {
  try {
    res.json({ specialties: await listSpecialties() });
  } catch (err) {
    next(err);
  }
});

router.post('/', csrfProtection, validate(createSpecialtySchema), async (req, res, next) => {
  try {
    const { name } = req.body;
    if (await specialtyNameExists(name)) {
      return res.status(409).json({ error: 'A specialty with this name already exists.', code: 'SPECIALTY_EXISTS' });
    }
    const specialty = await createSpecialty(name, req.authUserId);
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'specialty.create',
      entityType: 'specialty',
      entityId: specialty.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { name },
    });
    res.status(201).json({ specialty });
  } catch (err) {
    next(err);
  }
});

export default router;
