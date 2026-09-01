import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { scrubClaim, lookupPdpm, lookupHcc, estimatePayment } from '../services/codingService.js';
import { calcRaf, deriveSegment } from '../services/hccRafService.js';

const router = Router();
router.use(authenticate, requirePasswordSettled);

// CMS-HCC V28 risk-adjustment (RAF) for a diagnosis list. Body: { diagnoses|icds, age, sex, segment }
router.post('/raf', async (req, res, next) => {
  try {
    const b = req.body || {};
    let segment = b.segment; let segmentBasis = b.segment ? 'explicit' : null;
    if (!segment) { const s = deriveSegment({ age: b.age, insurance: b.insurance, facility: b.facility, dos: b.dos }); segment = s.segment; segmentBasis = s.basis; }
    return res.json(await calcRaf(b.diagnoses || b.icds || [], { age: b.age, sex: b.sex, segment, segmentBasis }));
  } catch (err) { return next(err); }
});

// Scrub a claim against NCCI PTP/MUE, ICD age-sex & specificity edits, LCD/Article coverage,
// and PDPM primary-diagnosis acceptability. Body: { lines, diagnoses, primaryDx, patient, fiscalYear }
router.post('/scrub', async (req, res, next) => {
  try { return res.json(await scrubClaim(req.body || {})); } catch (err) { return next(err); }
});

// PDPM clinical category for an ICD-10 code: GET /coding/pdpm/I4300?fy=2026
router.get('/pdpm/:icd', async (req, res, next) => {
  try {
    const r = await lookupPdpm(req.params.icd, Number(req.query.fy) || undefined);
    if (!r) return res.status(404).json({ error: 'ICD not found in PDPM mapping' });
    return res.json(r);
  } catch (err) { return next(err); }
});

// CMS-HCC categories for an ICD-10 code: GET /coding/hcc/E1122
router.get('/hcc/:icd', async (req, res, next) => {
  try { return res.json({ icd: req.params.icd, hccs: await lookupHcc(req.params.icd, req.query.model || null) }); }
  catch (err) { return next(err); }
});

// MPFS payment estimate: GET /coding/rvu/99306?facility=0&workGpci=1&peGpci=1&mpGpci=1
router.get('/rvu/:hcpcs', async (req, res, next) => {
  try {
    const q = req.query;
    const r = await estimatePayment(req.params.hcpcs, {
      workGpci: q.workGpci ? Number(q.workGpci) : 1,
      peGpci: q.peGpci ? Number(q.peGpci) : 1,
      mpGpci: q.mpGpci ? Number(q.mpGpci) : 1,
      facility: q.facility === '1' || q.facility === 'true',
      modifier: q.modifier || '',
    }, Number(q.year) || 2026);
    if (!r) return res.status(404).json({ error: 'HCPCS not found in MPFS RVU' });
    return res.json(r);
  } catch (err) { return next(err); }
});

export default router;
