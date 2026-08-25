import { Router } from 'express';
import * as ctrl from '../controllers/payerController.js';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate, requirePasswordSettled);

// Payer directory search (reference data) for the Face Sheet payer picker.
router.get('/search', ctrl.search);

export default router;
