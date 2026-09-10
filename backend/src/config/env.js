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
    // Default aligned to the deployment port scheme (in-process API 6000, public edge 6002,
    // frontend 6001, ocr 6003). Always overridden by API_PORT in .env.
    port: int('API_PORT', 6000),
    gatewayOrigin: process.env.GATEWAY_ORIGIN || 'http://127.0.0.1:6002',
    // Shared secret the gateway must present. Enforced in production only so
    // local direct testing stays convenient.
    internalKey: process.env.INTERNAL_API_KEY || '',
  },

  // EDGE (single public service): the public edge — TLS, WAF, hardened headers, edge rate limits, and
  // the SPA reverse-proxy — is folded INTO this backend process. There is no separate gateway tier.
  // `combined` stays as a config surface (always on) so a bare run still starts the edge, not a
  // now-removed loopback-only mode. Set GATEWAY_PORT for local dev (port 80 needs privilege).
  edge: {
    combined: bool('COMBINED_EDGE', true),
    host: process.env.GATEWAY_HOST || '0.0.0.0', // public bind
    httpPort: int('GATEWAY_PORT', 80),
    httpsPort: int('GATEWAY_HTTPS_PORT', 443),
    tls: bool('GATEWAY_TLS', isProd),
    certPath: process.env.TLS_CERT_PATH || '',
    keyPath: process.env.TLS_KEY_PATH || '',
    canonicalHost: process.env.GATEWAY_CANONICAL_HOST || '',
    // Non-/api requests are reverse-proxied here (the frontend SPA container).
    frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:6001',
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
  // Fax.Plus (Alohi) programmable fax — sends/receives referral documents. OAuth2 authorization_code:
  // a one-time consent yields a refresh token (in .env) the backend auto-exchanges for access tokens.
  // `enabled` = fully wired for LIVE sending (needs the refresh token); `configured` = app creds present
  // (enough to build the one-time consent URL). No mock — the service throws when not enabled.
  faxplus: {
    clientId: process.env.FAXPLUS_CLIENT_ID || '',
    clientSecret: process.env.FAXPLUS_CLIENT_SECRET || '',
    redirectUri: process.env.FAXPLUS_REDIRECT_URI || '',
    refreshToken: process.env.FAXPLUS_REFRESH_TOKEN || '',
    // Personal Access Token (Alohi/Fax.Plus console → API) — a long-lived Bearer token used DIRECTLY, with
    // no OAuth consent/redirect/refresh. The simplest, most reliable auth for a server integration.
    personalAccessToken: process.env.FAXPLUS_PAT || '',
    userId: process.env.FAXPLUS_USER_ID || 'self',
    baseUrl: process.env.FAXPLUS_BASE_URL || 'https://restapi.fax.plus/v3',
    tokenUrl: process.env.FAXPLUS_TOKEN_URL || 'https://accounts.fax.plus/token',
    authorizeUrl: process.env.FAXPLUS_AUTHORIZE_URL || 'https://accounts.fax.plus/login',
    incomingNumber: process.env.FAXPLUS_INCOMING_NUMBER || '',
    outgoingNumber: process.env.FAXPLUS_OUTGOING_NUMBER || '',
    webhookSecret: process.env.FAXPLUS_WEBHOOK_SECRET || '',
    timeoutMs: int('FAXPLUS_TIMEOUT_MS', 45000),
    // `configured` = enough to attempt OAuth (client creds) OR a PAT is present. `enabled` = live now:
    // a Personal Access Token, OR a full OAuth setup (client creds + refresh token).
    configured: !!((process.env.FAXPLUS_CLIENT_ID && process.env.FAXPLUS_CLIENT_SECRET) || process.env.FAXPLUS_PAT),
    enabled: !!(process.env.FAXPLUS_PAT || (process.env.FAXPLUS_CLIENT_ID && process.env.FAXPLUS_CLIENT_SECRET && process.env.FAXPLUS_REFRESH_TOKEN)),
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
