import 'dotenv/config';

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
    port: int('API_PORT', 4000),
    gatewayOrigin: process.env.GATEWAY_ORIGIN || 'http://127.0.0.1:8080',
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
    ssl: bool('DB_SSL', false),
  },

  crypto: {
    phiKey: required('PHI_ENC_KEY'),
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
    serviceUrl: process.env.OCR_SERVICE_URL || 'http://127.0.0.1:8600',
    apiKey: process.env.OCR_API_KEY || '',
    timeoutMs: int('OCR_TIMEOUT_MS', 60000),
  },

  // NPPES NPI Registry (CMS, public) — auto-fills SNF facility NPI + address.
  nppes: {
    enabled: bool('NPPES_ENABLED', true),
    baseUrl: process.env.NPPES_BASE_URL || 'https://npiregistry.cms.hhs.gov/api/',
    timeoutMs: int('NPPES_TIMEOUT_MS', 8000),
  },

  // Stedi — real-time eligibility (270/271) + Payer Network search. The API key is
  // secret; add it to .env as STEDI_API_KEY. Eligibility runs entirely server-side.
  stedi: {
    apiKey: process.env.STEDI_API_KEY || '',
    baseUrl: process.env.STEDI_BASE_URL || 'https://healthcare.us.stedi.com/2024-04-01',
    timeoutMs: int('STEDI_TIMEOUT_MS', 20000),
    enabled: !!process.env.STEDI_API_KEY,
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
