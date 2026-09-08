import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { execute } from '../db/pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';

/**
 * Fax.Plus (Alohi) programmable-fax client — sends & receives referral documents in real time.
 *
 * Auth: OAuth2 authorization_code. A ONE-TIME consent (getAuthorizeUrl → exchangeCode) yields a refresh
 * token stored in .env; the backend exchanges it for short-lived access tokens on demand (cached in
 * memory until ~30s before expiry). Every live call carries `Authorization: Bearer <token>` +
 * `x-fax-clientid`. NO mock / fallback: when not configured the service throws a clear, typed error so
 * the caller surfaces it — a fax that "silently succeeded" against nothing would be a real patient-safety
 * and records-integrity risk.
 */

const F = () => config.faxplus;
export const faxConfigured = () => !!F().configured; // app creds present (enough to build consent URL)
export const faxEnabled = () => !!F().enabled;        // fully wired for live send/receive (refresh token)

function faxErr(message, code = 'FAX_ERROR', status = 502) { const e = new Error(message); e.code = code; e.status = status; return e; }
/** Extract a human-readable reason from a Fax.Plus error JSON (shapes vary: {reason}, {message},
 *  {error:{message}}, {errors:[…]}). Used so an API rejection surfaces WHY, never an opaque HTTP code. */
function apiReason(data) {
  if (!data || typeof data !== 'object') return '';
  const e = data.error;
  return String(
    data.reason || data.message || data.error_description
    || (e && typeof e === 'object' ? (e.message || e.reason || e.code) : (typeof e === 'string' ? e : ''))
    || (Array.isArray(data.errors) && data.errors.length ? (data.errors[0].message || data.errors[0].reason || JSON.stringify(data.errors[0])) : '')
    || '',
  ).slice(0, 300);
}
function requireEnabled() {
  if (!F().enabled) {
    throw faxErr(F().configured
      ? 'Fax is not activated yet — complete the one-time Fax.Plus authorization to obtain a refresh token (see the fax authorize URL).'
      : 'Fax.Plus is not configured. Add FAXPLUS_CLIENT_ID / FAXPLUS_CLIENT_SECRET to the server .env.',
    'FAX_DISABLED', 503);
  }
}

// ---- OAuth token management ---------------------------------------------------------------------
let tokenCache = { accessToken: null, exp: 0 };
function basicAuth() { return Buffer.from(`${F().clientId}:${F().clientSecret}`).toString('base64'); }

/** One-time consent URL — the account owner visits this once to authorize the app; Fax.Plus redirects
 *  to the configured redirect URI with a `?code=…` to exchange for tokens. */
export function getAuthorizeUrl(state = '') {
  if (!F().configured) throw faxErr('Fax.Plus client credentials are not configured.', 'FAX_DISABLED', 503);
  // Fax.Plus OAuth2 (per apidoc.fax.plus): authorize at accounts.fax.plus/login with scope=all — this is
  // what yields BOTH an access token and a refresh token on code exchange. (The granular fax:*/user:*
  // scopes are for Personal Access Tokens, not this authorization-code flow.)
  const p = new URLSearchParams({ response_type: 'code', client_id: F().clientId, redirect_uri: F().redirectUri,
    scope: 'all', ...(state ? { state } : {}) });
  return `${F().authorizeUrl}?${p.toString()}`;
}

/** Exchange the one-time authorization `code` for tokens. Returns { access_token, refresh_token, expires_in }
 *  — the refresh_token must be saved to .env as FAXPLUS_REFRESH_TOKEN to activate live faxing. */
export async function exchangeCode(code) {
  if (!F().configured) throw faxErr('Fax.Plus client credentials are not configured.', 'FAX_DISABLED', 503);
  const res = await fetch(F().tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth()}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: F().clientId, code: String(code || ''), redirect_uri: F().redirectUri }),
    signal: AbortSignal.timeout(F().timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw faxErr(`Fax.Plus token exchange failed (HTTP ${res.status}).`, 'FAX_OAUTH', 502);
  return data;
}

// ---- Persisted credential store (encrypted, DB-backed) ------------------------------------------
/**
 * The refresh token (and webhook secret) obtained via the one-time OAuth consent are SECRETS. They are
 * persisted ENCRYPTED (AES-256-GCM, the same field-level cipher used for PHI) in `app_settings`, so
 * activation survives a restart WITHOUT hand-editing .env. An env-provided value always WINS over the
 * DB value (explicit ops override); the DB store only fills the gap when env is unset.
 */
const K_REFRESH = 'faxplus_refresh_token_enc';
const K_WEBHOOK = 'faxplus_webhook_secret_enc';
const K_PAT = 'faxplus_personal_access_token_enc';

async function persistSecret(key, plaintext) {
  const value = plaintext ? encrypt(String(plaintext)).toString('base64') : null; // base64 of the versioned cipher buffer
  await execute(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at)
       VALUES (:k, CAST(:v AS JSON), NOW())
     ON DUPLICATE KEY UPDATE setting_value = CAST(:v AS JSON), updated_at = NOW()`,
    { k: key, v: JSON.stringify(value) },
  );
}
async function readSecret(key) {
  const [rows] = await execute('SELECT setting_value FROM app_settings WHERE setting_key = :k LIMIT 1', { k: key });
  if (!rows[0]) return null;
  let v = rows[0].setting_value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep raw */ } }
  if (!v || typeof v !== 'string') return null;
  try { return decrypt(Buffer.from(v, 'base64')); } catch (e) { logger.error({ err: e.message, key }, 'fax secret decrypt failed'); return null; }
}

/** Recompute the live `enabled` flag from the current in-memory credentials: a Personal Access Token
 *  (used directly), OR a full OAuth setup (client creds + refresh token). */
function recomputeEnabled() { const f = F(); f.enabled = !!(f.personalAccessToken || (f.clientId && f.clientSecret && f.refreshToken)); return f.enabled; }

/**
 * Boot-time load: if env did not provide the refresh token / webhook secret, hydrate them from the
 * encrypted DB store so a previously-activated integration comes back live after a restart. Safe to call
 * once at startup; never throws (a store miss just leaves the integration inactive, exactly as before).
 */
export async function loadPersistedFaxCredentials() {
  const f = F();
  try {
    if (!f.personalAccessToken) { const pat = await readSecret(K_PAT); if (pat) { f.personalAccessToken = pat; logger.info('Fax.Plus Personal Access Token loaded from encrypted store'); } }
    if (!f.refreshToken) { const t = await readSecret(K_REFRESH); if (t) { f.refreshToken = t; logger.info('Fax.Plus refresh token loaded from encrypted store'); } }
    if (!f.webhookSecret) { const w = await readSecret(K_WEBHOOK); if (w) { f.webhookSecret = w; } }
  } catch (e) { logger.error({ err: e.message }, 'loadPersistedFaxCredentials failed (integration stays inactive)'); }
  recomputeEnabled();
  return faxStatus();
}

/** Verify a token works LIVE against the Fax.Plus REST API (GET /accounts/self). Throws a typed error if
 *  the account cannot be reached — used so activation is never a mock (a bad token is rejected loudly). */
async function verifyLiveAccount() {
  const res = await fetch(acct(''), { headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
  if (!res.ok) throw faxErr(`Fax.Plus rejected the credentials (HTTP ${res.status}).`, 'FAX_OAUTH', res.status === 401 ? 401 : 502);
  return res.json().catch(() => ({}));
}

/**
 * ACTIVATE via a Personal Access Token (direct API) — the token is used as a Bearer with NO OAuth
 * consent/redirect/refresh. Persisted encrypted, flipped live in-process, and VERIFIED against the live
 * account (GET /accounts/self). Fails loud on an empty or rejected token. Super-Admin only.
 */
export async function setFaxPersonalAccessToken(token) {
  const t = String(token || '').trim();
  if (!t) { // empty clears it (deactivates the PAT path)
    await persistSecret(K_PAT, null); F().personalAccessToken = ''; recomputeEnabled();
    logger.warn('Fax.Plus Personal Access Token cleared'); return faxStatus();
  }
  const prev = F().personalAccessToken;
  F().personalAccessToken = t; // used directly by accessToken() during verify
  try { await verifyLiveAccount(); }
  catch (e) { F().personalAccessToken = prev; recomputeEnabled(); throw e; }
  await persistSecret(K_PAT, t);
  recomputeEnabled();
  logger.info('Fax.Plus Personal Access Token stored (encrypted) and verified live');
  return faxStatus();
}

/**
 * ACTIVATE live faxing from a one-time OAuth `code`: exchange it for tokens, PERSIST the refresh token
 * encrypted, flip the integration live IN-PROCESS (no restart), and VERIFY by fetching a real access
 * token. Fails loud (never a mock activation) if the exchange returns no refresh token or the verify
 * call fails. Super-Admin only (route-guarded).
 */
export async function activateFax(code) {
  if (!F().configured) throw faxErr('Fax.Plus client credentials are not configured.', 'FAX_DISABLED', 503);
  const trimmed = String(code || '').trim();
  if (!trimmed) throw faxErr('Paste the authorization code from the Fax.Plus redirect.', 'FAX_OAUTH', 400);
  const tokens = await exchangeCode(trimmed);
  const refresh = tokens?.refresh_token;
  if (!refresh) throw faxErr('Fax.Plus did not return a refresh token — re-run the authorization and try again.', 'FAX_OAUTH', 502);
  await persistSecret(K_REFRESH, refresh);
  // Flip live in-process and prime the token cache from what we just received (verified below).
  F().refreshToken = refresh;
  tokenCache = { accessToken: null, exp: 0 };
  recomputeEnabled();
  // VERIFY end-to-end: a real refresh-token grant must succeed, or we roll the flag back and surface it.
  try {
    await accessToken();
  } catch (e) {
    F().refreshToken = ''; recomputeEnabled(); await persistSecret(K_REFRESH, null);
    throw faxErr('Activation verification failed — the token could not be used to reach Fax.Plus. Please re-authorize.', 'FAX_OAUTH', 502);
  }
  logger.info('Fax.Plus activated — refresh token stored (encrypted) and verified live');
  return faxStatus();
}

/** Store/replace the Fax.Plus (Svix) webhook secret used to verify inbound webhooks. Empty clears it. */
export async function setFaxWebhookSecret(secret) {
  const s = String(secret || '').trim();
  await persistSecret(K_WEBHOOK, s || null);
  F().webhookSecret = s || '';
  return faxStatus();
}

/** Deactivate live faxing: clear BOTH the refresh token and the Personal Access Token, flipping inactive. */
export async function deactivateFax() {
  await persistSecret(K_REFRESH, null);
  await persistSecret(K_PAT, null);
  F().refreshToken = '';
  F().personalAccessToken = '';
  tokenCache = { accessToken: null, exp: 0 };
  recomputeEnabled();
  logger.warn('Fax.Plus deactivated — stored credentials cleared');
  return faxStatus();
}

// Single-flight guard: a burst of concurrent calls near expiry must trigger exactly ONE refresh (a
// rotated refresh token is single-use, so parallel refreshes would invalidate each other).
let refreshInFlight = null;

async function accessToken() {
  // Personal Access Token: a long-lived Bearer used directly — no refresh, no OAuth. Takes precedence.
  if (F().personalAccessToken) return F().personalAccessToken;
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.exp > now + 30_000) return tokenCache.accessToken;
  if (refreshInFlight) return refreshInFlight; // a refresh is already running — await it
  refreshInFlight = (async () => {
    if (!F().refreshToken) throw faxErr('No Fax.Plus refresh token — complete the one-time authorization first.', 'FAX_DISABLED', 503);
    const res = await fetch(F().tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth()}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: F().refreshToken }),
      signal: AbortSignal.timeout(F().timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) { tokenCache = { accessToken: null, exp: 0 }; throw faxErr(`Fax.Plus token refresh failed (HTTP ${res.status}).`, 'FAX_OAUTH', 502); }
    tokenCache = { accessToken: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    // AUTOMATIC refresh-token ROTATION: if Fax.Plus returns a new refresh token (single-use rotation),
    // adopt it in memory AND persist it encrypted, so the integration keeps refreshing indefinitely with
    // NO re-authorization. A persist failure is logged loudly (never silent) — the in-memory token still
    // works for this process; the next successful refresh re-persists.
    if (data.refresh_token && data.refresh_token !== F().refreshToken) {
      F().refreshToken = data.refresh_token;
      recomputeEnabled();
      try { await persistSecret(K_REFRESH, data.refresh_token); logger.info('Fax.Plus refresh token rotated — new token persisted (encrypted)'); }
      catch (e) { logger.error({ err: e.message }, 'failed to persist rotated Fax.Plus refresh token — will re-persist on next refresh'); }
    }
    return tokenCache.accessToken;
  })();
  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

async function authHeaders(extra = {}) {
  const token = await accessToken();
  const h = { Authorization: `Bearer ${token}`, ...extra };
  // x-fax-clientid is an OAuth2-flow header; a Personal Access Token is self-contained (Bearer only).
  if (!F().personalAccessToken && F().clientId) h['x-fax-clientid'] = F().clientId;
  return h;
}
const acct = (path) => `${F().baseUrl}/accounts/${F().userId}${path}`;

// ---- Send ---------------------------------------------------------------------------------------
/**
 * Send a fax: upload the file(s), then submit them to the outbox FROM the sending number.
 * `from` is REQUIRED — the caller passes the facility's own configured OUTGOING number so each facility
 * faxes from its own DID. There is NO fallback to a global/default number: an unset or invalid `from`
 * fails loud, so a referral is never silently faxed from another facility's (or a shared) number.
 * @param {{ to:string, from:string, fileBuffer:Buffer, fileName:string, contentType?:string, comment?:string }} p
 * @returns {Promise<{ faxId:string|null, paths:string[], files:number, to:string, from:string }>}
 */
export async function sendFax({ to, from, fileBuffer, fileName, contentType = 'application/pdf', files, comment = '' }) {
  requireEnabled();
  const dest = String(to || '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(dest)) throw faxErr('A valid destination fax number is required.', 'FAX_BAD_NUMBER', 400);
  // Sending number: the facility's OWN configured outgoing DID — required, no global fallback.
  const src = String(from || '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(src)) throw faxErr('No valid sending fax number was provided for this facility.', 'FAX_NO_FROM', 400);
  // Accept a single file (fileBuffer/fileName) OR an ordered `files` array (cover + enclosed records).
  const list = (Array.isArray(files) && files.length ? files : (fileBuffer ? [{ fileBuffer, fileName, contentType }] : []))
    .filter((f) => Buffer.isBuffer(f.fileBuffer) && f.fileBuffer.length);
  if (!list.length) throw faxErr('Nothing to fax — the document is empty.', 'FAX_NO_FILE', 400);
  if (list.length > 10) throw faxErr('A fax can enclose at most 10 documents.', 'FAX_TOO_MANY', 400);

  // 1) Upload every document (order preserved — cover page first), collecting Fax.Plus storage paths.
  const paths = [];
  for (const f of list) {
    const fd = new FormData();
    fd.append('format', 'pdf');
    fd.append('fax_file', new Blob([f.fileBuffer], { type: f.contentType || 'application/pdf' }), f.fileName || 'document.pdf');
    const up = await fetch(acct('/files'), { method: 'POST', headers: await authHeaders(), body: fd, signal: AbortSignal.timeout(F().timeoutMs) });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok || !upData.path) {
      const why = apiReason(upData);
      logger.error({ status: up.status, reason: why }, 'Fax file upload failed');
      throw faxErr(`Fax file upload failed (HTTP ${up.status})${why ? `: ${why}` : ''}.`, 'FAX_UPLOAD', 502);
    }
    paths.push(upData.path);
  }

  // 2) Submit the whole package to the outbox from the practice's outgoing fax number.
  // Per the Fax.Plus outbox schema (PayloadOutbox) `comment` is an OBJECT { text, tags } — a plain
  // string is rejected 400 ("not of type 'object'"). So a string comment is wrapped as { text }, and a
  // caller-supplied object is passed through as-is.
  const body = { from: src.startsWith('+') ? src : `+${src}`, to: [dest.startsWith('+') ? dest : `+${dest}`], files: paths, return_ids: true };
  if (comment) body.comment = typeof comment === 'object' ? comment : { text: String(comment).slice(0, 500) };
  const send = await fetch(acct('/outbox'), { method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body), signal: AbortSignal.timeout(F().timeoutMs) });
  const sendData = await send.json().catch(() => ({}));
  if (!send.ok) {
    const why = apiReason(sendData);
    logger.error({ status: send.status, reason: why, from: body.from, to: body.to[0] }, 'Fax send (outbox) failed');
    throw faxErr(`Fax send failed (HTTP ${send.status})${why ? `: ${why}` : ''}.`, 'FAX_SEND', 502);
  }
  const faxId = sendData?.ids ? Object.values(sendData.ids)[0] || null : null;
  logger.info({ to: dest, faxId, files: paths.length }, 'Fax submitted to Fax.Plus outbox');
  return { faxId, paths, files: paths.length, to: body.to[0], from: body.from };
}

// ---- Records / inbox / download -----------------------------------------------------------------
/** One fax record (status, pages, file id) by fax id. */
export async function getFaxRecord(faxId) {
  requireEnabled();
  const res = await fetch(acct(`/faxes/${encodeURIComponent(faxId)}`), { headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw faxErr(`Fax record lookup failed (HTTP ${res.status}).`, 'FAX_RECORD', 502);
  return res.json();
}

// ---- Webhook endpoint management (Fax.Plus /v3/webhooks, Svix-backed) --------------------------
// Register/list/delete the INBOUND webhook endpoint programmatically (no dashboard needed for the
// endpoint itself). NOTE: Fax.Plus's REST API never returns the Svix SIGNING SECRET — that is revealed
// only in the dashboard (Settings → Integrations → Webhooks → Advanced), so it is still entered once via
// setFaxWebhookSecret(). Requires the PAT to carry webhook scope.
const webhooksUrl = (path = '') => `${F().baseUrl}/webhooks${path}`;
const sameUrl = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

export async function listWebhooks() {
  requireEnabled();
  const res = await fetch(webhooksUrl(), { headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw faxErr(`Fax.Plus webhook list failed (HTTP ${res.status})${apiReason(d) ? `: ${apiReason(d)}` : ''}.`, 'FAX_WEBHOOK', res.status === 403 ? 403 : 502); }
  const data = await res.json().catch(() => ({}));
  const list = data?.data?.records || (Array.isArray(data?.data) ? data.data : null) || data?.records || (Array.isArray(data) ? data : null) || [];
  return Array.isArray(list) ? list : [];
}

/** Register the inbound webhook endpoint. HTTPS + publicly reachable required. Idempotent by URL (returns
 *  the existing endpoint instead of creating a duplicate). Fails loud on any API error. */
export async function registerWebhook(url, filterTypes = ['fax_received', 'fax_sent']) {
  requireEnabled();
  const target = String(url || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(target)) throw faxErr('The webhook URL must be a public HTTPS URL (e.g. https://your-host/api/fax/webhook).', 'FAX_WEBHOOK_URL', 400);
  const existing = await listWebhooks();
  const dup = existing.find((e) => sameUrl(e.url, target));
  if (dup) return { created: false, endpoint: dup, endpoints: existing };
  const res = await fetch(webhooksUrl(), {
    method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ url: target, filter_types: filterTypes }), signal: AbortSignal.timeout(F().timeoutMs),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw faxErr(`Fax.Plus webhook registration failed (HTTP ${res.status})${apiReason(d) ? `: ${apiReason(d)}` : ''}.`, 'FAX_WEBHOOK', 502); }
  const endpoints = await listWebhooks(); // POST returns 201 empty → re-list to read the ep_… id
  const endpoint = endpoints.find((e) => sameUrl(e.url, target)) || null;
  logger.info({ url: target, filterTypes }, 'Fax.Plus inbound webhook endpoint registered');
  return { created: true, endpoint, endpoints };
}

export async function deleteWebhook(id) {
  requireEnabled();
  if (!id) throw faxErr('Webhook endpoint id required.', 'FAX_WEBHOOK', 400);
  const res = await fetch(webhooksUrl(`/${encodeURIComponent(id)}`), { method: 'DELETE', headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
  if (!res.ok && res.status !== 404) throw faxErr(`Fax.Plus webhook delete failed (HTTP ${res.status}).`, 'FAX_WEBHOOK', 502);
  return { ok: true, endpoints: await listWebhooks() };
}

/** Inbox (received) fax records — newest first. */
export async function listInbox() {
  requireEnabled();
  const res = await fetch(acct('/faxes?category=inbox'), { headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
  if (!res.ok) throw faxErr(`Fax inbox lookup failed (HTTP ${res.status}).`, 'FAX_INBOX', 502);
  const data = await res.json().catch(() => ({}));
  // Real Fax.Plus shape is { data: { records: [...] } }. Also tolerate a few other shapes defensively.
  const records = data?.data?.records
    || (Array.isArray(data?.data) ? data.data : null)
    || data?.records
    || (Array.isArray(data) ? data : null)
    || [];
  return Array.isArray(records) ? records : [];
}

/**
 * Download a sent/received fax's document as bytes. Per Fax.Plus docs the endpoint is
 * `GET /v3/accounts/{user_id}/files/{fax_id}` — the path key is the FAX ID (not a separate file token),
 * and the format is selected by the Accept header (the `format` query param is deprecated). PDF by default.
 */
export async function downloadFaxFile(faxId, { accept = 'application/pdf' } = {}) {
  requireEnabled();
  const res = await fetch(acct(`/files/${encodeURIComponent(faxId)}`), { headers: await authHeaders({ Accept: accept }), signal: AbortSignal.timeout(F().timeoutMs) });
  if (!res.ok) throw faxErr(`Fax file download failed (HTTP ${res.status}).`, 'FAX_DOWNLOAD', 502);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || accept };
}

// ---- Webhook verification (Svix) ----------------------------------------------------------------
/**
 * Verify an inbound Fax.Plus webhook. Fax.Plus delivers via Svix, which signs each request:
 *   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the endpoint secret
 *   (the base64 payload after the `whsec_` prefix), base64-encoded, matched against any `v1,<sig>` in
 *   the space-separated `svix-signature` header. Also rejects timestamps outside a 5-minute window
 *   (replay protection). Returns true only on a verified, fresh signature. NEVER trust an unsigned body.
 */
export function verifyFaxWebhook({ id, timestamp, signature, rawBody }) {
  const secret = F().webhookSecret;
  if (!secret || !id || !timestamp || !signature || rawBody == null) return false;
  const tsSec = Number(timestamp);
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) return false; // ±5 min
  const keyB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key; try { key = Buffer.from(keyB64, 'base64'); } catch { return false; }
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const expBuf = Buffer.from(expected);
  // svix-signature is a space-separated list of `v1,<base64sig>` — accept if any matches (constant-time).
  return String(signature).split(' ').some((part) => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    const sigBuf = Buffer.from(sig || '');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

/**
 * ON-DEMAND Fax.Plus AI on a received fax — invoked only when a provider clicks the AI button, never
 * automatically (keeps AI-credit usage minimal; Fax.Plus also caches results per fax so re-opening is
 * free). `mode` is 'transcript' (full searchable text / OCR) or 'extract' (structured key-value data).
 * The exact AI route is configurable (FAXPLUS_AI_PATH) because Fax.Plus's AI endpoints are newer than
 * the core v3 set; it throws clearly if AI is not configured — no fabricated output.
 */
// ---- Fax.Plus AI: OCR (text) + field extraction — /v3/fax-ai/* (Bearer PAT; costs AI credits) ----
const aiUrl = (p) => `${F().baseUrl}/fax-ai${p}`;
const AI_DONE = /done|complete|success|processed|finished|ready|extracted/i;
const AI_FAIL = /fail|error/i;

/** Remaining Fax.Plus AI credit summary (free GET). Lets the UI/ingest know if AI is usable. */
export async function faxAiCredits() {
  requireEnabled();
  const res = await fetch(aiUrl('/credits'), { headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
  if (res.status === 403 || res.status === 404) return { available: false, remaining: 0 };
  if (!res.ok) throw faxErr(`Fax.Plus AI credits check failed (HTTP ${res.status}).`, 'FAX_AI', 502);
  const d = await res.json().catch(() => ({}));
  const remaining = Number(d.remaining ?? d.remaining_credits ?? d.credits ?? d?.data?.remaining ?? 0);
  return { available: remaining > 0 || d.enabled === true, remaining, raw: d };
}

// Cached AI-availability (credits) flag so we don't probe Fax.Plus on every inbound fax. 10-min TTL.
let aiAvailCache = { at: 0, available: false };
export async function faxAiAvailable() {
  if (!F().enabled) return false;
  const now = Date.now();
  if (now - aiAvailCache.at < 600_000) return aiAvailCache.available;
  try { const c = await faxAiCredits(); aiAvailCache = { at: now, available: !!c.available }; }
  catch { aiAvailCache = { at: now, available: false }; }
  return aiAvailCache.available;
}

/**
 * Run Fax.Plus AI on a fax. `mode` = 'transcript' → OCR (`/fax-ai/ocr/{id}`); 'extract' → field extraction
 * (`/fax-ai/field-extraction/{id}`). Processing is asynchronous: POST triggers, GET polls the result. We
 * trigger then poll briefly and normalize to `{ text, fields, status }`. Fails loud + typed when AI is not
 * on the account (404/403 → FAX_AI_UNAVAILABLE) or out of credits (402 → FAX_AI_CREDITS) — never mock output.
 */
export async function faxAi(faxId, mode = 'transcript') {
  requireEnabled();
  const kind = mode === 'extract' ? 'field-extraction' : 'ocr';
  const base = `/${kind}/${encodeURIComponent(faxId)}`;
  // Trigger processing (idempotent: 409 = already triggered/processed).
  const trig = await fetch(aiUrl(base), { method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }), body: '{}', signal: AbortSignal.timeout(F().timeoutMs) });
  if (trig.status === 404 || trig.status === 403 || trig.status === 501) throw faxErr('Fax.Plus AI is not enabled on this account.', 'FAX_AI_UNAVAILABLE', 501);
  if (trig.status === 402) throw faxErr('No Fax.Plus AI credits remaining.', 'FAX_AI_CREDITS', 402);
  if (!trig.ok && trig.status !== 409) { const d = await trig.json().catch(() => ({})); throw faxErr(`Fax.Plus AI trigger failed (HTTP ${trig.status})${apiReason(d) ? `: ${apiReason(d)}` : ''}.`, 'FAX_AI', 502); }
  // Poll the GET for the finished result (async, bounded).
  let out = null;
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(aiUrl(base), { headers: await authHeaders(), signal: AbortSignal.timeout(F().timeoutMs) });
    if (res.status === 404 || res.status === 403) throw faxErr('Fax.Plus AI is not enabled on this account.', 'FAX_AI_UNAVAILABLE', 501);
    if (!res.ok) throw faxErr(`Fax.Plus AI fetch failed (HTTP ${res.status}).`, 'FAX_AI', 502);
    out = await res.json().catch(() => ({}));
    const d = out?.data || out || {};
    const status = String(d.status || out?.status || '');
    if (AI_FAIL.test(status)) throw faxErr(`Fax.Plus AI processing failed (${status}).`, 'FAX_AI', 502);
    if (AI_DONE.test(status) || d.text || d.ocr_text || d.fields || d.extracted || d.extracted_fields) break;
    if (i < 5) await new Promise((r) => setTimeout(r, 2500));
  }
  const d = out?.data || out || {};
  const fields = d.fields || d.extracted || d.extracted_fields || (kind === 'field-extraction' ? d.data : null) || null;
  return { mode: kind, text: d.text || d.ocr_text || d.content || null, fields, status: d.status || out?.status || 'processing', raw: out };
}

/** Public, non-secret status for the UI / Super Admin (never exposes the secret or tokens). */
export function faxStatus() {
  const f = F();
  return {
    configured: f.configured, enabled: f.enabled,
    hasRefreshToken: !!f.refreshToken, hasWebhookSecret: !!f.webhookSecret,
    hasPersonalAccessToken: !!f.personalAccessToken,
    authMode: f.personalAccessToken ? 'personal_access_token' : (f.refreshToken ? 'oauth' : null),
    incomingNumber: f.incomingNumber || null, outgoingNumber: f.outgoingNumber || null,
  };
}
