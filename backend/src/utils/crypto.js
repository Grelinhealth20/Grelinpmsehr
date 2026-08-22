import crypto from 'node:crypto';
import { config } from '../config/env.js';

/**
 * Field-level encryption for PHI at rest.
 *
 *  - Confidentiality + integrity via AES-256-GCM (authenticated encryption).
 *  - Random 96-bit IV per value; the auth tag is stored alongside ciphertext.
 *  - Wire format (stored as VARBINARY): [1B version][12B IV][16B tag][N ciphertext].
 *
 * Blind index: deterministic HMAC-SHA256 keyed with a separate secret. Lets us
 * look up an encrypted identifier (e.g. email) by equality without exposing or
 * decrypting the plaintext. Uses a distinct key so it can never be used to roll
 * back the encryption.
 */

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

function decodeKey(b64, label) {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error(`[crypto] ${label} must be a 32-byte (256-bit) base64 key`);
  }
  return key;
}

const PHI_KEY = decodeKey(config.crypto.phiKey, 'PHI_ENC_KEY');
const BIDX_KEY = decodeKey(config.crypto.blindIndexKey, 'BLIND_INDEX_KEY');

/**
 * Encrypt a UTF-8 string. Returns a Buffer suitable for a VARBINARY column.
 * `null`/`undefined` pass through so nullable columns stay null.
 */
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', PHI_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

/**
 * Decrypt a Buffer produced by {@link encrypt}. Throws if the data has been
 * tampered with (GCM auth check fails) — a defensive integrity guarantee.
 */
export function decrypt(payload) {
  if (payload === null || payload === undefined) return null;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new Error('[crypto] ciphertext too short');
  const version = buf[0];
  if (version !== VERSION) throw new Error(`[crypto] unsupported ciphertext version ${version}`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', PHI_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Deterministic, case-insensitive blind index for equality lookups.
 * Returns a 64-char hex string (fits CHAR(64)).
 */
export function blindIndex(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHmac('sha256', BIDX_KEY).update(normalized).digest('hex');
}

/** SHA-256 hex of an opaque token (for storing refresh tokens without the raw value). */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Cryptographically strong random token, URL-safe base64. */
export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison (avoids timing side-channels). */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
