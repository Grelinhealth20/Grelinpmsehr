import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt, blindIndex } from '../utils/crypto.js';
import { config } from '../config/env.js';
import { invalidateServiceLines, invalidateCredentials } from './accessScope.js';

/** Map a raw DB row to a safe, decrypted DTO (never leaks the password hash). */
export function toPublicUser(row) {
  if (!row) return null;
  return {
    uuid: row.uuid,
    email: decrypt(row.email_enc),
    fullName: decrypt(row.full_name_enc),
    role: row.role,
    status: row.status,
    accessLevel: row.access_level ? safeJson(row.access_level) : null,
    credentials: row.credentials ? (safeJson(row.credentials) || []) : [],
    specialty: row.specialty_uuid
      ? { uuid: row.specialty_uuid, name: row.specialty_name, serviceLine: row.specialty_service_line || 'snf' }
      : null,
    // ALL granted specialties (many-to-many). Falls back to the single primary for legacy rows.
    specialties: (() => {
      const arr = row.specialties_json ? (safeJson(row.specialties_json) || []) : [];
      if (arr.length) return arr;
      return row.specialty_uuid ? [{ uuid: row.specialty_uuid, name: row.specialty_name, serviceLine: row.specialty_service_line || 'snf' }] : [];
    })(),
    npi: row.npi || null,
    taxonomy: row.taxonomy || null,
    taxonomyCode: row.taxonomy_code || null,
    // Full NPPES (NPI-1) registry details — captured so nothing is dropped.
    licenseNumber: row.license_number || null,
    licenseState: row.license_state || null,
    gender: row.provider_gender || null,
    soleProprietor: row.sole_proprietor || null,
    enumerationDate: row.enumeration_date || null,
    nppesStatus: row.nppes_status || null,
    mustResetPassword: !!row.must_reset_password,
    // MFA policy + enrollment state (never the secret) — drives the Super Admin toggle + user UI.
    mfaEnabled: !!row.mfa_enabled,
    mfaEnrolled: !!row.mfa_confirmed_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const USER_SELECT = `SELECT u.id, u.uuid, u.email_enc, u.email_bidx, u.full_name_enc, u.role, u.status,
  u.access_level, u.credentials, u.npi, u.taxonomy, u.taxonomy_code,
  u.license_number, u.license_state, u.provider_gender, u.sole_proprietor, u.enumeration_date, u.nppes_status,
  u.password_hash, u.must_reset_password,
  u.mfa_enabled, u.mfa_secret_enc, u.mfa_confirmed_at, u.mfa_recovery_enc, u.mfa_last_step, u.mfa_failed_attempts, u.mfa_locked_until,
  UNIX_TIMESTAMP(u.mfa_locked_until) AS mfa_locked_until_epoch,
  u.failed_login_attempts, u.locked_until,
  u.last_login_at, u.password_changed_at, u.tokens_valid_after,
  UNIX_TIMESTAMP(u.tokens_valid_after) AS tokens_valid_after_epoch,
  u.created_at, u.updated_at, u.specialty_id,
  s.uuid AS specialty_uuid, s.name AS specialty_name, s.service_line AS specialty_service_line,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('uuid', sp.uuid, 'name', sp.name, 'serviceLine', sp.service_line))
     FROM user_specialties us2 JOIN specialties sp ON sp.id = us2.specialty_id WHERE us2.user_id = u.id) AS specialties_json
  FROM users u LEFT JOIN specialties s ON s.id = u.specialty_id`;

export async function findRawByEmail(email) {
  const [rows] = await execute(`${USER_SELECT} WHERE u.email_bidx = :bidx LIMIT 1`, {
    bidx: blindIndex(email),
  });
  return rows[0] || null;
}

export async function findRawByUuid(uuid) {
  const [rows] = await execute(`${USER_SELECT} WHERE u.uuid = :uuid LIMIT 1`, { uuid });
  return rows[0] || null;
}

/**
 * Short-TTL in-memory cache for the auth hot path. `authenticate` runs on EVERY
 * request; without this it pays a remote-DB round-trip (~240ms) per call. With a
 * brief TTL the identity/revocation check still refreshes within seconds while
 * the common case is served from memory. Mutations invalidate explicitly.
 */
const AUTH_CACHE_TTL_MS = 20_000;
const authUserCache = new Map(); // uuid -> { row, exp }

export function invalidateUserCache(uuid) {
  if (uuid) authUserCache.delete(uuid);
  else authUserCache.clear();
}

export async function findRawByUuidCached(uuid) {
  const now = Date.now();
  const hit = authUserCache.get(uuid);
  if (hit && hit.exp > now) return hit.row;
  const row = await findRawByUuid(uuid);
  authUserCache.set(uuid, { row, exp: now + AUTH_CACHE_TTL_MS });
  // Bound memory: drop the oldest entry if the map grows unexpectedly large.
  if (authUserCache.size > 5000) authUserCache.delete(authUserCache.keys().next().value);
  return row;
}

export async function emailExists(email) {
  const [rows] = await execute(
    `SELECT id FROM users WHERE email_bidx = :bidx LIMIT 1`,
    { bidx: blindIndex(email) },
  );
  return rows.length > 0;
}

export async function createUser({
  email,
  fullName,
  role,
  accessLevel = null,
  credentials = null,
  specialtyId = null,
  specialtyIds = undefined,
  npi = null,
  taxonomy = null,
  taxonomyCode = null,
  licenseNumber = null,
  licenseState = null,
  providerGender = null,
  soleProprietor = null,
  enumerationDate = null,
  nppesStatus = null,
  passwordHash,
  mustResetPassword = true,
  createdBy = null,
  status = 'active',
}) {
  const uuid = uuidv4();
  const [ins] = await execute(
    `INSERT INTO users
       (uuid, email_enc, email_bidx, full_name_enc, role, status, access_level, credentials, specialty_id,
        npi, taxonomy, taxonomy_code, license_number, license_state, provider_gender, sole_proprietor,
        enumeration_date, nppes_status, password_hash, must_reset_password, created_by, password_changed_at)
     VALUES
       (:uuid, :emailEnc, :emailBidx, :nameEnc, :role, :status, :accessLevel, :credentials, :specialtyId,
        :npi, :taxonomy, :taxonomyCode, :licenseNumber, :licenseState, :providerGender, :soleProprietor,
        :enumerationDate, :nppesStatus, :passwordHash, :mrp, :createdBy, NOW())`,
    {
      uuid,
      emailEnc: encrypt(email),
      emailBidx: blindIndex(email),
      nameEnc: encrypt(fullName),
      role,
      status,
      accessLevel: accessLevel ? JSON.stringify(accessLevel) : null,
      credentials: credentials && credentials.length ? JSON.stringify(credentials) : null,
      specialtyId: specialtyId ?? null,
      npi: npi || null,
      taxonomy: taxonomy || null,
      taxonomyCode: taxonomyCode || null,
      licenseNumber: licenseNumber || null,
      licenseState: licenseState || null,
      providerGender: providerGender || null,
      soleProprietor: soleProprietor || null,
      enumerationDate: enumerationDate || null,
      nppesStatus: nppesStatus || null,
      passwordHash,
      mrp: mustResetPassword ? 1 : 0,
      createdBy,
    },
  );
  // Persist the many-to-many specialty assignment (union access). Falls back to the single
  // specialtyId when the caller used the legacy field, so both paths populate the join table.
  const assign = specialtyIds !== undefined ? specialtyIds : (specialtyId ? [specialtyId] : []);
  if (assign.length) await setUserSpecialties(ins.insertId, assign);
  return findRawByUuid(uuid);
}

export async function listUsers({ role = null, status = null } = {}) {
  const clauses = [];
  const params = {};
  if (role) {
    clauses.push('u.role = :role');
    params.role = role;
  }
  if (status) {
    clauses.push('u.status = :status');
    params.status = status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await execute(`${USER_SELECT} ${where} ORDER BY u.created_at DESC`, params);
  return rows.map(toPublicUser);
}

/**
 * Replace a provider's specialty assignments (MANY-TO-MANY). The Super Admin selects one or
 * more specialties; access = the union of their service lines (see accessScope). The legacy
 * users.specialty_id is kept in sync as the "primary" (first) for display/back-compat.
 */
export async function setUserSpecialties(userId, specialtyIds) {
  const ids = [...new Set((specialtyIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  await execute('DELETE FROM user_specialties WHERE user_id = :u', { u: userId });
  for (const sid of ids) {
    await execute('INSERT IGNORE INTO user_specialties (user_id, specialty_id) VALUES (:u, :s)', { u: userId, s: sid });
  }
  await execute('UPDATE users SET specialty_id = :s WHERE id = :u', { u: userId, s: ids[0] ?? null });
  invalidateServiceLines(userId); // specialties changed → refresh the cached access scope now
}

/** Resolve a user's numeric id from their uuid. */
async function userIdByUuid(uuid) {
  const [rows] = await execute('SELECT id FROM users WHERE uuid = :uuid LIMIT 1', { uuid });
  return rows[0]?.id || null;
}

export async function updateUserProfile(uuid, { fullName, role, accessLevel, credentials, specialtyId, specialtyIds, npi, taxonomy, taxonomyCode, licenseNumber, licenseState, providerGender, soleProprietor, enumerationDate, nppesStatus }) {
  // Multi-specialty assignment (join table) — handled separately from the users columns so a
  // specialties-only edit still applies even when no other column changed.
  if (specialtyIds !== undefined) {
    const uid = await userIdByUuid(uuid);
    if (uid) await setUserSpecialties(uid, specialtyIds);
    invalidateUserCache(uuid);
  }
  const sets = [];
  const params = { uuid };
  if (fullName !== undefined) {
    sets.push('full_name_enc = :nameEnc');
    params.nameEnc = encrypt(fullName);
  }
  if (role !== undefined) {
    sets.push('role = :role');
    params.role = role;
  }
  if (accessLevel !== undefined) {
    sets.push('access_level = :accessLevel');
    params.accessLevel = accessLevel ? JSON.stringify(accessLevel) : null;
  }
  if (credentials !== undefined) {
    sets.push('credentials = :credentials');
    params.credentials = credentials && credentials.length ? JSON.stringify(credentials) : null;
  }
  if (specialtyId !== undefined) {
    sets.push('specialty_id = :specialtyId');
    params.specialtyId = specialtyId ?? null;
  }
  if (npi !== undefined) {
    sets.push('npi = :npi');
    params.npi = npi || null;
  }
  if (taxonomy !== undefined) {
    sets.push('taxonomy = :taxonomy');
    params.taxonomy = taxonomy || null;
  }
  if (taxonomyCode !== undefined) {
    sets.push('taxonomy_code = :taxonomyCode');
    params.taxonomyCode = taxonomyCode || null;
  }
  // Full NPPES (NPI-1) details.
  if (licenseNumber !== undefined) { sets.push('license_number = :licenseNumber'); params.licenseNumber = licenseNumber || null; }
  if (licenseState !== undefined) { sets.push('license_state = :licenseState'); params.licenseState = licenseState || null; }
  if (providerGender !== undefined) { sets.push('provider_gender = :providerGender'); params.providerGender = providerGender || null; }
  if (soleProprietor !== undefined) { sets.push('sole_proprietor = :soleProprietor'); params.soleProprietor = soleProprietor || null; }
  if (enumerationDate !== undefined) { sets.push('enumeration_date = :enumerationDate'); params.enumerationDate = enumerationDate || null; }
  if (nppesStatus !== undefined) { sets.push('nppes_status = :nppesStatus'); params.nppesStatus = nppesStatus || null; }
  if (!sets.length) return findRawByUuid(uuid);
  await execute(`UPDATE users SET ${sets.join(', ')} WHERE uuid = :uuid`, params);
  invalidateUserCache(uuid);
  // Credentials drive the viewer's MD/read-scope flag (cached) — refresh it immediately when changed
  // so an access-scope change never lags behind an admin edit.
  if (credentials !== undefined) { const uid = await userIdByUuid(uuid); if (uid != null) invalidateCredentials(uid); }
  return findRawByUuid(uuid);
}

export async function setUserStatus(uuid, status) {
  await execute(`UPDATE users SET status = :status WHERE uuid = :uuid`, { uuid, status });
  invalidateUserCache(uuid);
  return findRawByUuid(uuid);
}

export async function deleteUser(uuid) {
  const [res] = await execute(`DELETE FROM users WHERE uuid = :uuid`, { uuid });
  invalidateUserCache(uuid);
  return res.affectedRows > 0;
}

// --- Auth-related mutations --------------------------------------------------

export async function setPassword(userId, passwordHash, { clearMustReset = true } = {}) {
  await execute(
    `UPDATE users
        SET password_hash = :hash,
            password_changed_at = NOW(),
            must_reset_password = :mrp,
            failed_login_attempts = 0,
            locked_until = NULL
      WHERE id = :id`,
    { hash: passwordHash, mrp: clearMustReset ? 0 : 1, id: userId },
  );
  invalidateUserCache(); // password/lock state changed — refresh all cached identities
  await execute(
    `INSERT INTO password_history (user_id, password_hash) VALUES (:id, :hash)`,
    { id: userId, hash: passwordHash },
  );
  // Trim history to the configured window. LIMIT cannot be a bound parameter in
  // the prepared-statement protocol, so we inline a sanitized integer.
  const keep = Math.max(1, Math.min(50, Number.parseInt(config.policy.passwordHistorySize, 10) || 5));
  await execute(
    `DELETE FROM password_history
      WHERE user_id = :id AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM password_history WHERE user_id = :id2
          ORDER BY id DESC LIMIT ${keep}
        ) t
      )`,
    { id: userId, id2: userId },
  );
}

export async function getPasswordHistory(userId) {
  const keep = Math.max(1, Math.min(50, Number.parseInt(config.policy.passwordHistorySize, 10) || 5));
  const [rows] = await execute(
    `SELECT password_hash FROM password_history WHERE user_id = :id ORDER BY id DESC LIMIT ${keep}`,
    { id: userId },
  );
  return rows.map((r) => r.password_hash);
}

export async function recordFailedLogin(userId, { lock = true } = {}) {
  // On reaching the threshold we lock the account for a TIME WINDOW
  // (ACCOUNT_LOCK_MINUTES) after which it auto-unlocks — no admin action needed.
  // `lock=false` (master admin) still counts the attempt but never locks.
  await execute(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN :lock = 1 AND failed_login_attempts + 1 >= :max
                THEN DATE_ADD(NOW(), INTERVAL :mins MINUTE)
              ELSE locked_until END
      WHERE id = :id`,
    { max: config.policy.maxFailedLogins, mins: config.policy.accountLockMinutes, id: userId, lock: lock ? 1 : 0 },
  );
}

/** Clear a lapsed lock so the user gets a fresh attempt window (auto-unlock). */
export async function clearLockWindow(userId) {
  await execute(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = :id`, { id: userId });
}

/**
 * Current lock state, computed ENTIRELY in the database (NOW() vs locked_until)
 * so it is immune to any timezone offset between the DB and the app server.
 * @returns {Promise<{ locked: boolean, minutesLeft: number }>}
 */
export async function getLockState(userId) {
  const [rows] = await execute(
    `SELECT (locked_until IS NOT NULL AND locked_until > NOW()) AS locked,
        GREATEST(0, CEIL(TIMESTAMPDIFF(SECOND, NOW(), locked_until) / 60)) AS mins_left
       FROM users WHERE id = :id LIMIT 1`,
    { id: userId },
  );
  const r = rows[0] || {};
  return { locked: !!Number(r.locked), minutesLeft: Number(r.mins_left) || 0 };
}

export async function recordSuccessfulLogin(userId) {
  await execute(
    `UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
      WHERE id = :id`,
    { id: userId },
  );
}

export async function countUsers() {
  const [rows] = await execute(`SELECT COUNT(*) AS n FROM users`);
  return rows[0].n;
}

/** Active providers, as a minimal DTO for provider pickers (no email/PII leak). */
export async function listProviders() {
  const [rows] = await execute(
    `${USER_SELECT} WHERE u.role = 'provider' AND u.status = 'active' ORDER BY u.created_at DESC`,
  );
  return rows.map((r) => {
    const u = toPublicUser(r);
    return { uuid: u.uuid, fullName: u.fullName, credentials: u.credentials, specialty: u.specialty };
  });
}

/** Resolve a provider uuid to its internal id (only active providers qualify). */
export async function findProviderIdByUuid(uuid) {
  if (!uuid) return null;
  const [rows] = await execute(
    `SELECT id FROM users WHERE uuid = :uuid AND role = 'provider' AND status = 'active' LIMIT 1`,
    { uuid },
  );
  return rows[0]?.id ?? null;
}
