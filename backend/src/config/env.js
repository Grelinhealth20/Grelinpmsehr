import 'dotenv/config';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Pinned DB server CA (captured from the MySQL server's auto-generated CA). Its presence
// lets the API verify the DB TLS chain against a known cert instead of the system roots.
const DB_CA_PATH = process.env.DB_SSL_CA
  ? process.env.DB_SSL_CA
  : fileURLToPath(new URL('../../certs/db-ca.pem', import.meta.url));
const DB_CA_EXISTS = (() => { try { return fs.existsSync(DB_CA_PATH); } catch { return false; } })();

/**
 * Centralized, validated configuration. Fails fast on misconfiguration so the
 * service never boots in an insecure/half-configured state (SOC2 CC-family).
 */

function required(name, { allowInDev = false } = {}) {
  const val = process.env[name];
  if (val === undefined || val === '') {
    if (allowInDev && process.env.NODE_ENV !== 'production') return undefined;
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return val;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`[config] ${name} must be an integer`);
  return n;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true';
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  env: process.env.NODE_ENV || 'development',

  api: {
    host: process.env.API_HOST || '127.0.0.1',
    // Default aligned to the merged Docker/AWS port scheme (backend 6000, frontend 6001,
    // gateway 6002/6004, ocr 6003). Always overridden by API_PORT in .env / compose.
    port: int('API_PORT', 6000),
    gatewayOrigin: process.env.GATEWAY_ORIGIN || 'http://127.0.0.1:6002',
    // Shared secret the gateway must present. Enforced in production only so
    // local direct testing stays convenient.
    internalKey: process.env.INTERNAL_API_KEY || '',
  },

  db: {
    host: required('DB_HOST'),
    port: int('DB_PORT', 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    connectionLimit: int('DB_CONNECTION_LIMIT', 10),
    // TLS to MySQL. Encryption-in-transit is ON by default whenever a pinned DB CA is
    // present (DB_SSL can still force it on/off explicitly). With the pinned CA the chain
    // is verified (rejectUnauthorized) — MITM with a different cert is rejected.
    ssl: process.env.DB_SSL !== undefined ? bool('DB_SSL', false) : DB_CA_EXISTS,
    sslCa: DB_CA_EXISTS ? DB_CA_PATH : '',
    sslRejectUnauthorized: bool('DB_SSL_REJECT_UNAUTHORIZED', true),
    // Optional leaf-cert public-key pin (SPKI SHA-256, base64). When set, the DB server's leaf key must
    // match — defense against the pinned CA ever signing a substitute cert. Unset = CA-pinning only.
    sslPinSpki: (process.env.DB_CERT_SPKI_SHA256 || '').trim(),
  },

  crypto: {
    phiKey: required('PHI_ENC_KEY'),
    // Version stamped into new PHI ciphertext (default 1). Bump on key rotation so new writes are
    // tagged with the new key's version while old data still decrypts with its original key.
    phiKeyVersion: int('PHI_ENC_KEY_VERSION', 1),
    // Retired PHI keys kept for DECRYPT-ONLY during/after a rotation, so ciphertext written under an
    // older key stays readable without a flag-day re-encrypt. Format: "<version>:<base64key>,..." e.g.
    // "1:AAAA…==". Optional; empty when no rotation has happened.
    phiKeysOld: String(process.env.PHI_ENC_KEY_OLD || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .reduce((acc, pair) => { const i = pair.indexOf(':'); if (i > 0) acc[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); return acc; }, {}),
    blindIndexKey: required('BLIND_INDEX_KEY'),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: int('ACCESS_TOKEN_TTL', 1800),
    refreshTtl: int('REFRESH_TOKEN_TTL', 28800),
    // Automatic secret rotation cadence (default 40 min). New tokens are signed
    // with the newest secret; recent prior secrets stay valid until their tokens
    // expire, so rotation never disrupts a live session.
    rotateSeconds: int('KEY_ROTATION_SECONDS', 2400),
  },

  policy: {
    maxFailedLogins: int('MAX_FAILED_LOGINS', 5),
    accountLockMinutes: int('ACCOUNT_LOCK_MINUTES', 15),
    passwordMinLength: int('PASSWORD_MIN_LENGTH', 12),
    passwordHistorySize: int('PASSWORD_HISTORY_SIZE', 5),
  },

  masterAdmin: {
    // Required, fail-fast — never fall back to a source literal. A committed default
    // would seed the top-privilege account with a password that is public in git.
    email: required('MASTER_ADMIN_EMAIL'),
    password: required('MASTER_ADMIN_PASSWORD'),
    name: process.env.MASTER_ADMIN_NAME || 'Master Administrator',
  },

  s3: {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    enabled: !!(process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
  },

  // Document-AI extraction: open-source PP-StructureV2 + docTR, served by the
  // Python OCR microservice (ocr-service/). The Node API calls it over HTTP.
  ocr: {
    serviceUrl: process.env.OCR_SERVICE_URL || 'http://127.0.0.1:6003',
    apiKey: process.env.OCR_API_KEY || '',
    timeoutMs: int('OCR_TIMEOUT_MS', 60000),
  },

  // NPPES NPI Registry (CMS, public) — auto-fills SNF facility NPI + address.
  nppes: {
    enabled: bool('NPPES_ENABLED', true),
    baseUrl: process.env.NPPES_BASE_URL || 'https://npiregistry.cms.hhs.gov/api/',
    timeoutMs: int('NPPES_TIMEOUT_MS', 8000),
  },

  // UMLS Terminology Services (NLM) — real-time SNOMED CT US / RxNorm / CPT / ICD-10-CM /
  // HCPCS / CDT / LOINC lookups. The API key is secret; add it to .env as UMLS_API_KEY.
  // Lookups run server-side and are cached locally (terminology_cache) — real NLM data only.
  umls: {
    apiKey: process.env.UMLS_API_KEY || '',
    baseUrl: process.env.UMLS_BASE_URL || 'https://uts-ws.nlm.nih.gov/rest',
    timeoutMs: int('UMLS_TIMEOUT_MS', 12000),
    enabled: !!process.env.UMLS_API_KEY,
  },

  // Stedi — real-time eligibility (270/271) + Payer Network search. The API key is
  // secret; add it to .env as STEDI_API_KEY. Eligibility runs entirely server-side.
  stedi: {
    apiKey: process.env.STEDI_API_KEY || '',
    baseUrl: process.env.STEDI_BASE_URL || 'https://healthcare.us.stedi.com/2024-04-01',
    timeoutMs: int('STEDI_TIMEOUT_MS', 20000),
    enabled: !!process.env.STEDI_API_KEY,
  },
  // OpenAI — powers the AI-assisted custom-template builder. Add OPENAI_API_KEY to .env (the key is a
  // server-only secret; requests run entirely server-side, never from the browser). OPENAI_MODEL lets
  // you pick the model. Disabled (feature hidden) until a key is present — no mock, no fallback output.
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: int('OPENAI_TIMEOUT_MS', 30000),
    enabled: !!process.env.OPENAI_API_KEY,
  },
};

/** Roles, ordered by privilege. Used for RBAC checks. */
export const ROLES = Object.freeze({
  MASTER_ADMIN: 'master_admin',
  SUPER_ADMIN: 'super_admin',
  BILLING: 'billing',
  PROVIDER: 'provider',
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

/** Account status values. */
export const USER_STATUS = Object.freeze({
  ACTIVE: 'active',
  RESTRICTED: 'restricted',
  DISABLED: 'disabled',
});
