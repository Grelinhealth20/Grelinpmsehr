import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { listProviders } from '../services/userService.js';

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

export default router;
