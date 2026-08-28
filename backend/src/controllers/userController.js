import {
  listUsers,
  createUser,
  findRawByUuid,
  toPublicUser,
  updateUserProfile,
  setUserStatus,
  deleteUser,
  emailExists,
  setPassword,
} from '../services/userService.js';
import { hashPassword, validatePasswordPolicy } from '../utils/password.js';
import { recordAudit } from '../services/auditService.js';
import { findSpecialtyIdByUuid } from '../services/specialtyService.js';
import { listUserFacilities, setUserFacilities } from '../services/facilityService.js';
import { blindIndex } from '../utils/crypto.js';
import { searchProviders, nppesEnabled } from '../services/nppesService.js';
import { config, ROLES } from '../config/env.js';

const auditCtx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** Live NPPES lookup for an INDIVIDUAL provider (NPI-1) by NPI or name. */
export async function nppesProviderSearch(req, res, next) {
  try {
    if (!nppesEnabled()) return res.status(503).json({ error: 'NPPES registry lookup is not configured.', code: 'NPPES_DISABLED' });
    const { q = '', npi = '', state = '' } = req.query;
    const results = await searchProviders({ q, npi, state });
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

/** The configured master-admin account — protected from demotion/deletion. */
function isMasterAccount(row) {
  return row.role === ROLES.MASTER_ADMIN || row.email_bidx === blindIndex(config.masterAdmin.email);
}

/** Resolve a specialty UUID to its internal id; throws 400 if the UUID is unknown. */
async function resolveSpecialtyId(specialtyUuid) {
  if (specialtyUuid === undefined) return undefined; // not being changed
  if (specialtyUuid === null) return null; // explicitly cleared
  const id = await findSpecialtyIdByUuid(specialtyUuid);
  if (!id) {
    const e = new Error('Unknown specialty.');
    e.status = 400;
    e.code = 'UNKNOWN_SPECIALTY';
    throw e;
  }
  return id;
}

/** Resolve an array of specialty UUIDs → numeric ids (multi-specialty assignment). Returns
 *  undefined when not provided (no change); an empty array clears all assignments. */
async function resolveSpecialtyIds(specialtyUuids) {
  if (specialtyUuids === undefined) return undefined;
  const ids = [];
  for (const u of specialtyUuids) {
    const id = await findSpecialtyIdByUuid(u);
    if (!id) { const e = new Error('Unknown specialty.'); e.status = 400; e.code = 'UNKNOWN_SPECIALTY'; throw e; }
    ids.push(id);
  }
  return ids;
}

function ctxOf(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

/** Guard: only the master admin may act on another master-admin record. */
function assertCanManageTarget(actor, targetRow) {
  if (targetRow.role === ROLES.MASTER_ADMIN && actor.role !== ROLES.MASTER_ADMIN) {
    const e = new Error('Only the master administrator can manage this account.');
    e.status = 403;
    e.code = 'FORBIDDEN';
    throw e;
  }
}

/** Facilities a provider/billing user is assigned to. */
export async function facilities(req, res, next) {
  try {
    res.json({ facilities: await listUserFacilities(req.params.uuid) });
  } catch (err) { next(err); }
}

/** Replace a provider/billing user's facility assignments. */
export async function setFacilities(req, res, next) {
  try {
    const r = await setUserFacilities(req.params.uuid, req.body.facilityUuids || [], req.authUserId);
    if (r.notFound) return res.status(404).json({ error: 'User not found or not assignable.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'user.set_facilities', entityType: 'user', entityId: req.params.uuid, ...auditCtx(req), metadata: { count: (req.body.facilityUuids || []).length } });
    res.json({ facilities: await listUserFacilities(req.params.uuid) });
  } catch (err) { next(err); }
}

export async function list(req, res, next) {
  try {
    const { role, status } = req.query;
    const users = await listUsers({ role: role || null, status: status || null });
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const { email, fullName, role, accessLevel, credentials, specialtyUuid, specialtyUuids, npi, taxonomy, taxonomyCode, temporaryPassword } = req.body;
    const isProvider = role === ROLES.PROVIDER;

    const policyErrors = validatePasswordPolicy(temporaryPassword);
    if (policyErrors.length) {
      return res
        .status(400)
        .json({ error: 'Temporary password does not meet policy.', code: 'WEAK_PASSWORD', details: policyErrors });
    }
    if (await emailExists(email)) {
      return res.status(409).json({ error: 'A user with this email already exists.', code: 'EMAIL_TAKEN' });
    }

    // Specialty + NPPES identity (NPI / taxonomy) only apply to providers.
    const specialtyId = isProvider ? await resolveSpecialtyId(specialtyUuid) : null;
    const specialtyIds = isProvider ? await resolveSpecialtyIds(specialtyUuids) : undefined;

    const passwordHash = await hashPassword(temporaryPassword);
    const row = await createUser({
      email,
      fullName,
      role,
      accessLevel: accessLevel || null,
      credentials: isProvider ? (credentials || null) : null,
      specialtyId: specialtyId ?? null,
      specialtyIds,
      npi: isProvider ? (npi || null) : null,
      taxonomy: isProvider ? (taxonomy || null) : null,
      taxonomyCode: isProvider ? (taxonomyCode || null) : null,
      passwordHash,
      mustResetPassword: true, // new users must set their own password on first login
      createdBy: req.authUserId,
    });

    await recordAudit({
      actorUserId: req.authUserId,
      action: 'user.create',
      entityType: 'user',
      entityId: row.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { role },
    });

    res.status(201).json({ user: toPublicUser(row) });
  } catch (err) {
    next(err);
  }
}

export async function getOne(req, res, next) {
  try {
    const row = await findRawByUuid(req.params.uuid);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: toPublicUser(row) });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const row = await findRawByUuid(req.params.uuid);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    assertCanManageTarget(req.user, row);

    // The master administrator can never be demoted to another role.
    if (isMasterAccount(row) && req.body.role && req.body.role !== ROLES.MASTER_ADMIN) {
      return res.status(400).json({ error: 'The master administrator role cannot be changed.', code: 'MASTER_PROTECTED' });
    }

    const { specialtyUuid, specialtyUuids, ...rest } = req.body;
    const specialtyId = await resolveSpecialtyId(specialtyUuid);
    const specialtyIds = await resolveSpecialtyIds(specialtyUuids);
    const updated = await updateUserProfile(req.params.uuid, { ...rest, specialtyId, specialtyIds });
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'user.update',
      entityType: 'user',
      entityId: row.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { fields: Object.keys(req.body) },
    });
    res.json({ user: toPublicUser(updated) });
  } catch (err) {
    next(err);
  }
}

export async function changeStatus(req, res, next) {
  try {
    const row = await findRawByUuid(req.params.uuid);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    assertCanManageTarget(req.user, row);
    if (row.id === req.authUserId) {
      return res.status(400).json({ error: 'You cannot change your own account status.' });
    }

    const updated = await setUserStatus(req.params.uuid, req.body.status);
    await recordAudit({
      actorUserId: req.authUserId,
      action: `user.status.${req.body.status}`,
      entityType: 'user',
      entityId: row.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ user: toPublicUser(updated) });
  } catch (err) {
    next(err);
  }
}

export async function adminResetPassword(req, res, next) {
  try {
    const row = await findRawByUuid(req.params.uuid);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    assertCanManageTarget(req.user, row);

    const policyErrors = validatePasswordPolicy(req.body.temporaryPassword);
    if (policyErrors.length) {
      return res
        .status(400)
        .json({ error: 'Temporary password does not meet policy.', code: 'WEAK_PASSWORD', details: policyErrors });
    }

    const hash = await hashPassword(req.body.temporaryPassword);
    // clearMustReset=false → the user is forced to set a new password on next login.
    await setPassword(row.id, hash, { clearMustReset: false });
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'user.password.admin_reset',
      entityType: 'user',
      entityId: row.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ ok: true, message: 'Temporary password set. User must reset it on next login.' });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    const row = await findRawByUuid(req.params.uuid);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    assertCanManageTarget(req.user, row);
    if (row.role === ROLES.MASTER_ADMIN) {
      return res.status(400).json({ error: 'The master administrator account cannot be deleted.' });
    }
    if (row.id === req.authUserId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    await deleteUser(req.params.uuid);
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'user.delete',
      entityType: 'user',
      entityId: row.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
