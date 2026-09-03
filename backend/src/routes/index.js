import { Router } from 'express';
import authRoutes from './authRoutes.js';
import userRoutes from './userRoutes.js';
import auditRoutes from './auditRoutes.js';
import specialtyRoutes from './specialtyRoutes.js';
import appointmentRoutes from './appointmentRoutes.js';
import patientRoutes from './patientRoutes.js';
import encounterRoutes from './encounterRoutes.js';
import providerRoutes from './providerRoutes.js';
import facilityRoutes from './facilityRoutes.js';
import payerRoutes from './payerRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import terminologyRoutes from './terminologyRoutes.js';
import codingRoutes from './codingRoutes.js';
import aiLogsRoutes from './aiLogsRoutes.js';
import fhirRoutes from '../fhir/fhirRoutes.js';

const router = Router();

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'grelin-pms-api' }));

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/specialties', specialtyRoutes);
router.use('/providers', providerRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/patients', patientRoutes);
router.use('/encounters', encounterRoutes);
router.use('/facilities', facilityRoutes);
router.use('/payers', payerRoutes);
router.use('/audit', auditRoutes);
router.use('/settings', settingsRoutes);
router.use('/terminology', terminologyRoutes);
router.use('/coding', codingRoutes);
router.use('/ai-logs', aiLogsRoutes);
// FHIR R4 / US Core API (ONC (g)(10) foundation). /metadata is public; resources are provider-scoped.
router.use('/fhir/R4', fhirRoutes);

export default router;
