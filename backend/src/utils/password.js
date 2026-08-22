import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config/env.js';

/**
 * Password hashing with scrypt (Node built-in, memory-hard, OWASP-recommended).
 * Zero native/3rd-party dependencies → no compile step, fully portable.
 *
 * Stored format:  scrypt$N$r$p$<saltHex>$<hashHex>
 * Parameters give a strong CPU/memory cost while staying responsive server-side.
 */
const scryptAsync = promisify(crypto.scrypt);

const PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 128 * (1 << 15) * 8 * 2 };

export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(plain), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(stored, plain) {
  try {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
    const [, nStr, rStr, pStr, saltHex, hashHex] = stored.split('$');
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scryptAsync(String(plain), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Enforce a strong password policy (length + character classes). Returns an
 * array of human-readable violations; empty array means the password is valid.
 */
export function validatePasswordPolicy(pw) {
  const errors = [];
  const min = config.policy.passwordMinLength;
  if (typeof pw !== 'string' || pw.length < min) {
    errors.push(`Password must be at least ${min} characters long.`);
  }
  if (typeof pw === 'string' && pw.length > 200) errors.push('Password must be at most 200 characters long.');
  if (!/[a-z]/.test(pw)) errors.push('Password must include a lowercase letter.');
  if (!/[A-Z]/.test(pw)) errors.push('Password must include an uppercase letter.');
  if (!/[0-9]/.test(pw)) errors.push('Password must include a digit.');
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push('Password must include a special character.');
  if (/\s/.test(pw)) errors.push('Password must not contain whitespace.');
  return errors;
}
