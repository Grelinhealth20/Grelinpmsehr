import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt, blindIndex } from '../utils/crypto.js';
import { config } from '../config/env.js';

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
    specialty: row.specialty_uuid ? { uuid: row.specialty_uuid, name: row.specialty_name } : null,
    mustResetPassword: !!row.must_reset_password,
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
  u.access_level, u.credentials, u.password_hash, u.must_reset_password, u.failed_login_attempts, u.locked_until,
  u.last_login_at, u.password_changed_at, u.created_at, u.updated_at, u.specialty_id,
  s.uuid AS specialty_uuid, s.name AS specialty_name
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
  passwordHash,
  mustResetPassword = true,
  createdBy = null,
  status = 'active',
}) {
  const uuid = uuidv4();
  await execute(
    `INSERT INTO users
       (uuid, email_enc, email_bidx, full_name_enc, role, status, access_level, credentials, specialty_id,
        password_hash, must_reset_password, created_by, password_changed_at)
     VALUES
       (:uuid, :emailEnc, :emailBidx, :nameEnc, :role, :status, :accessLevel, :credentials, :specialtyId,
        :passwordHash, :mrp, :createdBy, NOW())`,
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
      passwordHash,
      mrp: mustResetPassword ? 1 : 0,
      createdBy,
    },
  );
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

export async function updateUserProfile(uuid, { fullName, role, accessLevel, credentials, specialtyId }) {
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
  if (!sets.length) return findRawByUuid(uuid);
  await execute(`UPDATE users SET ${sets.join(', ')} WHERE uuid = :uuid`, params);
  return findRawByUuid(uuid);
}

export async function setUserStatus(uuid, status) {
  await execute(`UPDATE users SET status = :status WHERE uuid = :uuid`, { uuid, status });
  return findRawByUuid(uuid);
}

export async function deleteUser(uuid) {
  const [res] = await execute(`DELETE FROM users WHERE uuid = :uuid`, { uuid });
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

export async function recordFailedLogin(userId) {
  // On reaching the threshold we set locked_until as a permanent lock marker.
  // The lock is cleared ONLY when a password is (re)set — see setPassword().
  await execute(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= :max THEN NOW()
              ELSE locked_until END
      WHERE id = :id`,
    { max: config.policy.maxFailedLogins, id: userId },
  );
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
