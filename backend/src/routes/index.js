import { Router } from 'express';
import authRoutes from './authRoutes.js';
import userRoutes from './userRoutes.js';
import auditRoutes from './auditRoutes.js';
import specialtyRoutes from './specialtyRoutes.js';
import appointmentRoutes from './appointmentRoutes.js';
import patientRoutes from './patientRoutes.js';
import encounterRoutes from './encounterRoutes.js';

const router = Router();

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'grelin-pms-api' }));

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/specialties', specialtyRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/patients', patientRoutes);
router.use('/encounters', encounterRoutes);
router.use('/audit', auditRoutes);

export default router;
