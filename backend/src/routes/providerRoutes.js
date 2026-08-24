import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { listProviders } from '../services/userService.js';
import { listProviderFacilities, listSchedulableProviders } from '../services/facilityService.js';

const router = Router();

// Any authenticated, settled user may list active providers (for pickers).
router.use(authenticate, requirePasswordSettled);

router.get('/', async (req, res, next) => {
  try {
    res.json({ providers: await listProviders() });
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
