/**
 * SMART-on-FHIR / OAuth 2.0 authorization server (foundation) for the FHIR R4 API (ONC (g)(10)).
 *
 * Implements the standalone authorization-code flow WITH PKCE (S256): discovery, /authorize, /token,
 * scoped Bearer access tokens (signed JWT via the app's rotating key ring), and Bearer verification +
 * scope enforcement for the FHIR resource endpoints. Codes are single-use, short-lived, hashed at rest,
 * and bound to client + redirect_uri + PKCE challenge. Redirect URIs must exactly match a registered
 * client (no open redirects). Confidential clients authenticate with a hashed secret; public clients use
 * PKCE alone. (User-facing consent screen + EHR-launch context are the next refinements.)
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { execute } from '../db/pool.js';
import { sha256Hex, safeEqual } from '../utils/crypto.js';
import { findRawByUuid } from '../services/userService.js';
import { activeAccessSecret, accessSecrets } from '../services/keyRotationService.js';

const ISSUER = 'grelin-pms';
const FHIR_AUD = 'grelin-fhir';
const ACCESS_TTL = 3600; // seconds
const CODE_TTL_SEC = 60;

export function smartConfiguration(baseUrl) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${baseUrl}/oauth2/authorize`,
    token_endpoint: `${baseUrl}/oauth2/token`,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    registration_endpoint: `${baseUrl}/oauth2/register`,
    scopes_supported: ['openid', 'fhirUser', 'launch', 'launch/patient', 'patient/*.read', 'user/*.read', 'offline_access'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    capabilities: ['launch-standalone', 'client-public', 'client-confidential-symmetric', 'context-standalone-patient', 'permission-patient', 'permission-user'],
  };
}

async function getClient(clientId) {
  const [rows] = await execute('SELECT * FROM oauth_clients WHERE client_id = :c LIMIT 1', { c: clientId });
  return rows[0] || null;
}

/** Register a SMART client (super-admin). Public (PKCE) by default; confidential returns a one-time secret. */
export async function registerClient({ name, redirectUris, scopes, confidential = false, createdBy = null }) {
  if (!name || !Array.isArray(redirectUris) || !redirectUris.length) {
    const e = new Error('name and at least one redirectUri are required.'); e.status = 400; e.code = 'BAD_REQUEST'; throw e;
  }
  for (const u of redirectUris) {
    if (!/^https:\/\/|^http:\/\/localhost|^http:\/\/127\.0\.0\.1/.test(u)) {
      const e = new Error('redirectUris must be https (localhost may be http).'); e.status = 400; e.code = 'BAD_REDIRECT'; throw e;
    }
  }
  const clientId = crypto.randomUUID();
  let secret = null; let secretHash = null;
  if (confidential) { secret = crypto.randomBytes(32).toString('base64url'); secretHash = sha256Hex(secret); }
  await execute(
    `INSERT INTO oauth_clients (client_id, name, redirect_uris, confidential, client_secret_hash, scopes, created_by)
     VALUES (:clientId, :name, :uris, :conf, :hash, :scopes, :createdBy)`,
    {
      clientId, name: String(name).slice(0, 160), uris: JSON.stringify(redirectUris), conf: confidential ? 1 : 0,
      hash: secretHash, scopes: (scopes || 'openid fhirUser launch/patient patient/*.read offline_access').slice(0, 500), createdBy,
    },
  );
  return { clientId, clientSecret: secret }; // secret shown ONCE
}

/**
 * Authorization endpoint. The caller must already have an authenticated app session (req.authUserId);
 * on success a single-use code is issued and the browser is redirected to the client's redirect_uri.
 * Returns { redirect } (a URL) or throws an AuthorizeError with a status for direct errors.
 */
export async function authorize({ query, userId }) {
  const { response_type: responseType, client_id: clientId, redirect_uri: redirectUri, scope, state, code_challenge: codeChallenge, code_challenge_method: ccm, aud } = query;
  const fail = (msg, code = 'invalid_request') => { const e = new Error(msg); e.status = 400; e.oauthError = code; throw e; };
  if (responseType !== 'code') fail('response_type must be "code"', 'unsupported_response_type');
  if (!clientId) fail('client_id is required');
  const client = await getClient(clientId);
  if (!client) fail('unknown client_id', 'unauthorized_client');
  const allowed = JSON.parse(client.redirect_uris || '[]');
  if (!redirectUri || !allowed.includes(redirectUri)) fail('redirect_uri does not match a registered value', 'invalid_request');
  // PKCE required (public clients) — S256 only.
  if (!codeChallenge || ccm !== 'S256') fail('PKCE code_challenge with method S256 is required');
  // Narrow requested scope to what the client is allowed — wildcard-aware, so a client granted
  // `patient/*.read` also covers a request for the narrower `patient/Patient.read`.
  const clientScopes = (client.scopes || '').split(/\s+/).filter(Boolean);
  const granted = String(scope || '').split(/\s+/).filter(Boolean).filter((rs) => clientScopes.some((cs) => scopeCovers(cs, rs)));
  // launch/patient: bind the code (and the resulting token) to ONE patient the authorizing user owns.
  // A patient-scoped token can then ONLY ever see that patient — no cross-patient data access.
  let patientId = null;
  if (granted.includes('launch/patient') || query.patient) {
    const pu = String(query.patient || '').replace(/^Patient\//, '');
    if (!pu) fail('launch/patient requires a ?patient= context', 'invalid_request');
    const [prows] = await execute('SELECT id FROM patients WHERE uuid = :u AND provider_id = :pid LIMIT 1', { u: pu, pid: userId });
    if (!prows[0]) fail('patient not found or not permitted for this user', 'invalid_request');
    patientId = prows[0].id;
  }
  const code = crypto.randomBytes(32).toString('base64url');
  await execute(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, patient_id, expires_at)
     VALUES (:h, :clientId, :userId, :redirectUri, :scope, :cc, 'S256', :patientId, DATE_ADD(NOW(), INTERVAL ${CODE_TTL_SEC} SECOND))`,
    { h: sha256Hex(code), clientId, userId, redirectUri, scope: granted.join(' '), cc: codeChallenge, patientId },
  );
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state != null) url.searchParams.set('state', String(state));
  return { redirect: url.toString() };
}

/** Token endpoint — authorization_code grant with PKCE. Returns the SMART token response object. */
export async function token({ body, authHeader }) {
  const fail = (msg, code = 'invalid_grant', status = 400) => { const e = new Error(msg); e.status = status; e.oauthError = code; throw e; };
  if (body.grant_type !== 'authorization_code') fail('unsupported grant_type', 'unsupported_grant_type');
  const { code, redirect_uri: redirectUri, client_id: bodyClientId, code_verifier: verifier } = body;
  if (!code) fail('code is required');

  const [rows] = await execute('SELECT * FROM oauth_codes WHERE code_hash = :h LIMIT 1', { h: sha256Hex(code) });
  const rec = rows[0];
  if (!rec) fail('invalid code');
  // Single-use + expiry (fail closed; a re-used code is a theft signal — burn any siblings for the client).
  if (rec.used_at) { await execute('UPDATE oauth_codes SET used_at = NOW() WHERE client_id = :c AND used_at IS NULL', { c: rec.client_id }); fail('code already used'); }
  if (new Date(rec.expires_at) < new Date()) fail('code expired');
  await execute('UPDATE oauth_codes SET used_at = NOW() WHERE id = :id', { id: rec.id });

  const client = await getClient(rec.client_id);
  if (!client) fail('unknown client', 'invalid_client', 401);
  // Client authentication: confidential → secret (Basic header); public → PKCE only.
  if (client.confidential) {
    const [, b64] = (authHeader || '').split(' ');
    const [cid, secret] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (cid !== client.client_id || !secret || sha256Hex(secret) !== client.client_secret_hash) fail('client authentication failed', 'invalid_client', 401);
  } else if (bodyClientId && bodyClientId !== rec.client_id) {
    fail('client_id mismatch', 'invalid_client', 401);
  }
  if (redirectUri !== rec.redirect_uri) fail('redirect_uri mismatch');
  // PKCE verify (S256).
  const challenge = crypto.createHash('sha256').update(String(verifier || '')).digest('base64url');
  if (!verifier || !safeEqual(challenge, rec.code_challenge)) fail('PKCE verification failed');

  const user = await findRawByUuid((await execute('SELECT uuid FROM users WHERE id = :id', { id: rec.user_id }))[0][0]?.uuid);
  if (!user) fail('user no longer valid', 'invalid_grant', 401);

  const scope = rec.scope || '';
  // Patient launch context (if the code was bound to a patient) → embedded in the token AND returned as
  // the SMART `patient` launch parameter. The FHIR layer confines a patient-context token to this patient.
  let patientUuid = null;
  if (rec.patient_id) {
    const [prows] = await execute('SELECT uuid FROM patients WHERE id = :id LIMIT 1', { id: rec.patient_id });
    patientUuid = prows[0]?.uuid || null;
  }
  const accessToken = jwt.sign(
    { sub: user.uuid, type: 'smart_access', scope, client_id: rec.client_id, patient: patientUuid || undefined },
    activeAccessSecret(),
    { expiresIn: ACCESS_TTL, issuer: ISSUER, audience: FHIR_AUD },
  );
  const resp = { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL, scope };
  if (patientUuid) resp.patient = patientUuid;
  if (scope.split(/\s+/).includes('openid')) {
    resp.id_token = jwt.sign({ sub: user.uuid, fhirUser: `Practitioner/${user.uuid}` }, activeAccessSecret(), { expiresIn: ACCESS_TTL, issuer: ISSUER, audience: rec.client_id });
  }
  return resp;
}

/** Verify a SMART Bearer access token. Returns claims { sub, scope, client_id } or null. */
export function verifySmartToken(tok) {
  for (const secret of accessSecrets()) {
    try {
      const c = jwt.verify(tok, secret, { issuer: ISSUER, audience: FHIR_AUD, algorithms: ['HS256'] });
      if (c.type === 'smart_access') return c;
    } catch { /* try next */ }
  }
  return null;
}

/** Does a client scope `cs` cover a requested scope `rs`? FHIR scopes match wildcard-aware
 *  (patient/*.read covers patient/Patient.read); non-FHIR scopes (openid, launch, …) match exactly. */
function scopeCovers(cs, rs) {
  if (cs === rs) return true;
  const parse = (s) => { const m = s.match(/^(patient|user)\/(\*|[A-Za-z]+)\.(read|write|\*)$/); return m ? { actor: m[1], res: m[2], act: m[3] } : null; };
  const a = parse(cs); const b = parse(rs);
  if (!a || !b) return false;
  return a.actor === b.actor && (a.res === '*' || a.res === b.res) && (a.act === '*' || a.act === b.act);
}

/** Does the granted scope permit READ of this resource type? (patient/user . <Type|*> .read) */
export function scopeAllowsRead(scope, resourceType) {
  const scopes = String(scope || '').split(/\s+/).filter(Boolean);
  return scopes.some((s) => {
    const m = s.match(/^(patient|user)\/(\*|[A-Za-z]+)\.(read|\*)$/);
    return m && (m[2] === '*' || m[2] === resourceType) && (m[3] === 'read' || m[3] === '*');
  });
}
