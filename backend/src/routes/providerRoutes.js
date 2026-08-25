import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { listProviders } from '../services/userService.js';
import { listProviderFacilities, listSchedulableProviders } from '../services/facilityService.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

// List active providers for pickers. Admins see the whole directory; a provider or
// billing user sees ONLY providers in their own facilities — never the full
// cross-facility staff roster (which would leak other tenants' personnel).
router.get('/', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'master_admin' || req.user.role === 'super_admin';
    const providers = isAdmin
      ? await listProviders()
      : await listSchedulableProviders(req.authUserId);
    res.json({ providers });
  } catch (err) {
    next(err);
  }
});

// The signed-in provider's assigned facilities (their billing facilities). Used
// by the EHR to scope patient creation and enforce facility isolation.
router.get('/facilities', async (req, res, next) => {
  try {
    res.json({ facilities: await listProviderFacilities(req.authUserId) });
  } catch (err) {
    next(err);
  }
});

// Rendering providers the caller may schedule — the active providers assigned to
// the caller's facilities. Front-desk/billing pick from this to book an appointment.
router.get('/schedulable', async (req, res, next) => {
  try {
    res.json({ providers: await listSchedulableProviders(req.authUserId) });
  } catch (err) {
    next(err);
  }
});

export default router;
