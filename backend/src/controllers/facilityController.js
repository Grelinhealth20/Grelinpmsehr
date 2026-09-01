import {
  listFacilities, getFacility, createFacility, updateFacility,
  setFacilityStatus, setFacilityFlags, deleteFacility, assignProvider, unassignProvider,
} from '../services/facilityService.js';
import { searchFacilities, nppesEnabled } from '../services/nppesService.js';
import { recordAudit } from '../services/auditService.js';

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** Live NPPES lookup by NPI or name — returns complete candidate details to verify. */
export async function nppesSearch(req, res, next) {
  try {
    if (!nppesEnabled()) return res.status(503).json({ error: 'NPPES registry lookup is not configured.', code: 'NPPES_DISABLED' });
    const { q = '', npi = '', state = '', city = '' } = req.query;
    const results = await searchFacilities({ q, npi, state, city });
    res.json({ results });
  } catch (err) {
    if (err.code === 'NPPES_UNAVAILABLE') {
      return res.status(502).json({
        error: 'The NPPES registry could not be reached. Check the server’s internet access and try again.',
        code: 'NPPES_UNAVAILABLE',
      });
    }
    next(err);
  }
}

export async function list(req, res, next) {
  try {
    const { q = '', status = '' } = req.query;
    res.json({ facilities: await listFacilities({ q, status: status || null }) });
  } catch (err) { next(err); }
}

export async function getOne(req, res, next) {
  try {
    const facility = await getFacility(req.params.uuid);
    if (!facility) return res.status(404).json({ error: 'Facility not found.', code: 'NOT_FOUND' });
    res.json({ facility });
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const { facility, duplicate } = await createFacility(req.body, { adminId: req.authUserId });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.create', entityType: 'facility', entityId: facility.uuid, ...ctx(req), metadata: { npi: facility.npi, name: facility.name, duplicate } });
    res.status(duplicate ? 200 : 201).json({ facility, duplicate });
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const facility = await updateFacility(req.params.uuid, req.body);
    if (!facility) return res.status(404).json({ error: 'Facility not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.update', entityType: 'facility', entityId: facility.uuid, ...ctx(req), metadata: { fields: Object.keys(req.body) } });
    res.json({ facility });
  } catch (err) { next(err); }
}

export async function status(req, res, next) {
  try {
    const facility = await setFacilityStatus(req.params.uuid, req.body.status);
    if (!facility) return res.status(404).json({ error: 'Facility not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.status', entityType: 'facility', entityId: facility.uuid, ...ctx(req), metadata: { status: req.body.status } });
    res.json({ facility });
  } catch (err) { next(err); }
}

/** SUPER-ADMIN: turn the coding engine and/or eligibility on/off for this facility. */
export async function flags(req, res, next) {
  try {
    const patch = {};
    if (typeof req.body.codingEnabled === 'boolean') patch.codingEnabled = req.body.codingEnabled;
    if (typeof req.body.eligibilityEnabled === 'boolean') patch.eligibilityEnabled = req.body.eligibilityEnabled;
    const facility = await setFacilityFlags(req.params.uuid, patch);
    if (!facility) return res.status(404).json({ error: 'Facility not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.flags', entityType: 'facility', entityId: facility.uuid, ...ctx(req), metadata: patch });
    res.json({ facility });
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const ok = await deleteFacility(req.params.uuid);
    if (!ok) return res.status(404).json({ error: 'Facility not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.delete', entityType: 'facility', entityId: req.params.uuid, ...ctx(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

export async function assign(req, res, next) {
  try {
    const r = await assignProvider(req.params.uuid, req.body.providerUuid, req.authUserId);
    if (r.notFound) return res.status(404).json({ error: 'Facility or provider not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.assign_provider', entityType: 'facility', entityId: req.params.uuid, ...ctx(req), metadata: { providerUuid: req.body.providerUuid } });
    res.json({ facility: await getFacility(req.params.uuid) });
  } catch (err) { next(err); }
}

export async function unassign(req, res, next) {
  try {
    const r = await unassignProvider(req.params.uuid, req.params.providerUuid);
    if (r.notFound) return res.status(404).json({ error: 'Facility or provider not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'facility.unassign_provider', entityType: 'facility', entityId: req.params.uuid, ...ctx(req), metadata: { providerUuid: req.params.providerUuid } });
    res.json({ facility: await getFacility(req.params.uuid) });
  } catch (err) { next(err); }
}
