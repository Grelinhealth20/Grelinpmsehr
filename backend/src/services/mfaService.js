import crypto from 'node:crypto';
import { execute } from '../db/pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateSecret, verifyTotp, otpauthUri, base32Encode } from '../utils/totp.js';
import { qrDataUri } from '../utils/qrcode.js';
import { invalidateUserCache } from './userService.js';

/**
 * In-house MFA (TOTP) service. Every function operates ONLY on the user it is given — a user's
 * secret, recovery codes, and verification are never reachable by any other user. Secrets and
 * recovery-code hashes are stored ENCRYPTED (AES-256-GCM) at rest. Deterministic verification.
 */
const ISSUER = 'Grelin PMS & EHR';
const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MINUTES = 15;
const RECOVERY_COUNT = 10;

const emailOf = (row) => { try { return decrypt(row.email_enc); } catch { return row.uuid; } };
function newRecoveryCode() {
  // 10-char Base32, grouped XXXXX-XXXXX — easy to read/type, high entropy.
  const s = base32Encode(crypto.randomBytes(7)).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5, 10)}`;
}
function lockState(row) {
  if (!row.mfa_locked_until) return { locked: false, minutesLeft: 0 };
  const until = new Date(row.mfa_locked_until).getTime();
  const now = Date.now();
  return until > now ? { locked: true, minutesLeft: Math.ceil((until - now) / 60000) } : { locked: false, minutesLeft: 0 };
}
async function bumpFailure(row) {
  const n = (row.mfa_failed_attempts || 0) + 1;
  if (n >= MFA_MAX_FAILURES) {
    await execute('UPDATE users SET mfa_failed_attempts = :n, mfa_locked_until = DATE_ADD(NOW(), INTERVAL :m MINUTE) WHERE id = :id',
      { n, m: MFA_LOCK_MINUTES, id: row.id });
  } else {
    await execute('UPDATE users SET mfa_failed_attempts = :n WHERE id = :id', { n, id: row.id });
  }
  invalidateUserCache(row.uuid);
  return n >= MFA_MAX_FAILURES;
}

/** Status for the current user (drives the UI). */
export function mfaStatus(row) {
  return { enabled: !!row.mfa_enabled, enrolled: !!row.mfa_confirmed_at, stage: !row.mfa_enabled ? 'ok' : (row.mfa_confirmed_at ? 'pending' : 'setup') };
}

/**
 * Begin enrollment: mint a NEW secret (unconfirmed) for THIS user, return the otpauth URI, the
 * scannable QR (data URI), and the manual Base32 key (scannerless fallback). Regenerating before
 * confirmation simply replaces the pending secret.
 */
export async function beginSetup(row) {
  const secret = generateSecret();
  await execute('UPDATE users SET mfa_secret_enc = :s, mfa_confirmed_at = NULL WHERE id = :id', { s: encrypt(secret), id: row.id });
  invalidateUserCache(row.uuid);
  const uri = otpauthUri(secret, { account: emailOf(row), issuer: ISSUER });
  return { qr: qrDataUri(uri), manualKey: secret, otpauthUri: uri, issuer: ISSUER };
}

/**
 * Confirm enrollment: verify the first code against the pending secret. On success, mark confirmed,
 * generate ONE-TIME recovery codes (returned once, stored hashed), and seed the replay step.
 */
export async function confirmEnrollment(row, code) {
  if (!row.mfa_secret_enc) return { error: 'no_pending_secret' };
  const secret = decrypt(row.mfa_secret_enc);
  const res = verifyTotp(secret, code);
  if (!res.valid) return { error: 'invalid_code' };
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  const hashed = await Promise.all(codes.map(async (c) => ({ hash: await hashPassword(c.replace('-', '')), used: false })));
  await execute(
    `UPDATE users SET mfa_confirmed_at = NOW(), mfa_recovery_enc = :r, mfa_last_step = :st,
       mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = :id`,
    { r: encrypt(JSON.stringify(hashed)), st: res.step, id: row.id });
  invalidateUserCache(row.uuid);
  return { ok: true, recoveryCodes: codes };
}

/** Verify a login TOTP code (pending → satisfied). Replay-guarded + lockout after repeated failures. */
export async function verifyCode(row, code) {
  const lock = lockState(row);
  if (lock.locked) return { error: 'locked', minutesLeft: lock.minutesLeft };
  if (!row.mfa_secret_enc || !row.mfa_confirmed_at) return { error: 'not_enrolled' };
  const secret = decrypt(row.mfa_secret_enc);
  const res = verifyTotp(secret, code, { afterStep: Number(row.mfa_last_step ?? -1) });
  if (!res.valid) { const locked = await bumpFailure(row); return { error: 'invalid_code', locked }; }
  await execute('UPDATE users SET mfa_last_step = :st, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = :id', { st: res.step, id: row.id });
  invalidateUserCache(row.uuid);
  return { ok: true };
}

/** Verify a one-time recovery code (pending → satisfied). Consumes the code. */
export async function verifyRecovery(row, code) {
  const lock = lockState(row);
  if (lock.locked) return { error: 'locked', minutesLeft: lock.minutesLeft };
  if (!row.mfa_recovery_enc) return { error: 'no_recovery' };
  let list; try { list = JSON.parse(decrypt(row.mfa_recovery_enc)); } catch { return { error: 'no_recovery' }; }
  const norm = String(code || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z2-7]{10}$/.test(norm)) { await bumpFailure(row); return { error: 'invalid_code' }; }
  for (const entry of list) {
    if (entry.used) continue;
    if (await verifyPassword(entry.hash, norm)) { // eslint-disable-line no-await-in-loop
      entry.used = true;
      await execute('UPDATE users SET mfa_recovery_enc = :r, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = :id', { r: encrypt(JSON.stringify(list)), id: row.id });
      invalidateUserCache(row.uuid);
      return { ok: true, remaining: list.filter((e) => !e.used).length };
    }
  }
  await bumpFailure(row);
  return { error: 'invalid_code' };
}

/** SUPER-ADMIN: require/allow MFA for a user. Does NOT delete an existing enrollment. */
export async function adminSetEnabled(targetUuid, enabled) {
  const [rows] = await execute('SELECT id FROM users WHERE uuid = :u LIMIT 1', { u: targetUuid });
  if (!rows[0]) return { error: 'not_found' };
  await execute('UPDATE users SET mfa_enabled = :e WHERE id = :id', { e: enabled ? 1 : 0, id: rows[0].id });
  invalidateUserCache(targetUuid);
  return { ok: true, enabled: !!enabled };
}

/** SUPER-ADMIN: reset a user's MFA enrollment (they must re-scan a new QR next login). */
export async function adminResetMfa(targetUuid) {
  const [rows] = await execute('SELECT id FROM users WHERE uuid = :u LIMIT 1', { u: targetUuid });
  if (!rows[0]) return { error: 'not_found' };
  await execute(
    `UPDATE users SET mfa_secret_enc = NULL, mfa_confirmed_at = NULL, mfa_recovery_enc = NULL,
       mfa_last_step = NULL, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = :id`, { id: rows[0].id });
  invalidateUserCache(targetUuid);
  return { ok: true };
}
