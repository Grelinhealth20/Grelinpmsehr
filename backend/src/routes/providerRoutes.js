import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { listProviders } from '../services/userService.js';
import { listProviderFacilities } from '../services/facilityService.js';

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

export default router;
