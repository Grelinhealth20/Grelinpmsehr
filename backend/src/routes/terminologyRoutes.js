import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { searchTerminology, cachedCount, TERM_SOURCES, umlsEnabled,
  lookupCpt, searchCpt, listCptModifiers, searchSnomed, searchRxnorm, snomedToIcd10cm } from '../services/terminologyService.js';
import { checkRxSafety } from '../services/medSafetyService.js';

const router = Router();
router.use(authenticate, requirePasswordSettled);

// SNOMED CT US — full local search: GET /terminology/snomed?q=pneumonia
router.get('/snomed', async (req, res, next) => {
  try {
    const { q = '', pageSize } = req.query;
    return res.json({ query: String(q), results: await searchSnomed(q, { pageSize: pageSize ? Number(pageSize) : 20 }) });
  } catch (err) { return next(err); }
});

// RxNorm (meds) — full local search: GET /terminology/rxnorm?q=metformin
router.get('/rxnorm', async (req, res, next) => {
  try {
    const { q = '', pageSize } = req.query;
    return res.json({ query: String(q), results: await searchRxnorm(q, { pageSize: pageSize ? Number(pageSize) : 20 }) });
  } catch (err) { return next(err); }
});

// Prescribing safety check — deterministic, fully-local: class-based allergy cross-check + duplicate/
// therapeutic-duplication, from the UMLS drug-class data (no external API). All params string-coerced.
// GET /terminology/rx-safety?name=lisinopril 10 MG Oral Tablet&rxcui=...&allergies=penicillin, sulfa&current=aspirin 81 MG|metformin 500 MG
router.get('/rx-safety', async (req, res, next) => {
  try {
    const { name = '', rxcui = '', allergies = '', current = '' } = req.query;
    if (!String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const currentDrugs = String(current).split('|').map((s) => s.trim()).filter(Boolean);
    return res.json(await checkRxSafety({ name: String(name), rxcui: String(rxcui), allergies: String(allergies), currentDrugs }));
  } catch (err) { return next(err); }
});

// SNOMED concept → billable ICD-10-CM (official complex map): GET /terminology/snomed/233604007/icd10cm
router.get('/snomed/:conceptId/icd10cm', async (req, res, next) => {
  try { return res.json(await snomedToIcd10cm(req.params.conceptId)); } catch (err) { return next(err); }
});

// AMA CPT® — search by code or descriptor: GET /terminology/cpt?q=nursing+facility
router.get('/cpt', async (req, res, next) => {
  try {
    const { q = '', pageSize } = req.query;
    const results = await searchCpt(q, { pageSize: pageSize ? Number(pageSize) : 20 });
    return res.json({ query: String(q), results });
  } catch (err) { return next(err); }
});

// AMA CPT® modifiers list: GET /terminology/cpt/modifiers
router.get('/cpt/modifiers', async (req, res, next) => {
  try { return res.json({ results: await listCptModifiers() }); } catch (err) { return next(err); }
});

// AMA CPT® single-code lookup (full descriptor set): GET /terminology/cpt/99308
router.get('/cpt/:code', async (req, res, next) => {
  try {
    const cpt = await lookupCpt(req.params.code);
    if (!cpt) return res.status(404).json({ error: 'CPT code not found' });
    return res.json(cpt);
  } catch (err) { return next(err); }
});

// Real-time terminology search: GET /terminology/search?q=office+visit&source=SNOMEDCT_US
router.get('/search', async (req, res, next) => {
  try {
    const { q = '', source = 'SNOMEDCT_US', pageSize } = req.query;
    const results = await searchTerminology(q, { source, pageSize: pageSize ? Number(pageSize) : 20 });
    return res.json({ source, query: String(q), umls: umlsEnabled(), results });
  } catch (err) { return next(err); }
});

// GET /terminology/status — whether UMLS is configured + how many real codes are cached per source.
router.get('/status', async (req, res, next) => {
  try {
    const cached = {};
    for (const s of TERM_SOURCES) cached[s] = await cachedCount(s);
    return res.json({ umls: umlsEnabled(), sources: TERM_SOURCES, cached, total: await cachedCount() });
  } catch (err) { return next(err); }
});

export default router;
