import crypto from 'node:crypto';

/**
 * In-house TOTP (RFC 6238) + HOTP (RFC 4226) using only Node's crypto. No third-party service or
 * library. Deterministic: same secret + time step always yields the same code. Used for MFA.
 *
 * Secrets are Base32 (RFC 4648) so any standard authenticator app (Google/Microsoft Authenticator,
 * Authy, etc.) can consume them via the otpauth:// URI or manual key entry.
 */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALGO = 'sha1'; // RFC 6238 default; what every authenticator app expects for otpauth defaults

/** Cryptographically-random Base32 secret (default 20 bytes / 160 bits, per RFC 4226 recommendation). */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid Base32 character');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): HMAC-SHA1(secret, counter) with dynamic truncation → zero-padded DIGITS. */
export function hotp(secretB32, counter, digits = DIGITS) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter.
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(ALGO, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Current TOTP time step (counter) for a given unix time (ms). */
export function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The code for a specific step (test/verification helper). */
export function totpAt(secretB32, step) { return hotp(secretB32, step); }

/**
 * Verify a submitted code against the secret within ±window steps (default 1 = ±30s for clock
 * skew). Constant-time comparison. Returns { valid, step } — `step` lets the caller store the used
 * step for REPLAY prevention (never accept a step ≤ the last one already used).
 */
export function verifyTotp(secretB32, token, { window = 1, nowMs = Date.now(), afterStep = -1 } = {}) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { valid: false, step: null };
  const center = currentStep(nowMs);
  for (let w = -window; w <= window; w += 1) {
    const step = center + w;
    if (step <= afterStep) continue; // replay guard: this step was already used
    const expected = hotp(secretB32, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return { valid: true, step };
  }
  return { valid: false, step: null };
}

/**
 * otpauth:// provisioning URI for QR / manual entry. Kept SHORT (only the required secret + issuer;
 * SHA1/6-digit/30s are the app defaults and are omitted) so the QR stays a low version and scans
 * reliably. The issuer is what the authenticator app displays as the account name.
 */
export function otpauthUri(secretB32, { account, issuer }) {
  const label = encodeURIComponent(account);
  let query = `secret=${secretB32}`;
  if (issuer) query += `&issuer=${encodeURIComponent(issuer)}`;
  return `otpauth://totp/${label}?${query}`;
}

export const TOTP_CONFIG = { STEP_SECONDS, DIGITS, ALGO };
