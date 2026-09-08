import {
  listReferrals, getReferral, createReferral, updateReferral, deleteReferral,
  generateReferralLetter, referralStats, sendReferralFax, ingestIncomingFax, updateFaxStatus,
  listAllReferrals, allReferralStats, referralPdfBuffer, receivedDocumentBuffer, restoreInboundDocument,
  reconcileFaxStatus, syncInbox, reconcileAllFaxes,
  addReferralAttachment, listReferralAttachments, deleteReferralAttachment,
  SPECIALTIES, DIRECTIONS, PRIORITIES, STATUSES,
} from '../services/referralService.js';
import { listProviderFacilities } from '../services/facilityService.js';
import { searchProviders, searchFacilities, nppesEnabled } from '../services/nppesService.js';
import { recordAudit } from '../services/auditService.js';
import { faxStatus as faxStatusInfo, getAuthorizeUrl, exchangeCode, verifyFaxWebhook, faxAi, faxAiCredits, activateFax, setFaxWebhookSecret, deactivateFax, setFaxPersonalAccessToken, registerWebhook, listWebhooks, deleteWebhook } from '../services/faxService.js';
import { startFaxReconciler, stopFaxReconciler, faxReconcilerStatus, runFaxReconcileOnce } from '../services/faxReconciler.js';
import { logger } from '../config/logger.js';

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const referralError = (err, res, next) => {
  if (err.code && /^REFERRAL_/.test(err.code)) return res.status(err.status || 400).json({ error: err.message, code: err.code });
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message, code: 'NOT_FOUND' });
  return next(err);
};

/**
 * Option lists for the referral form. Includes the provider's OWN assigned facilities (real data from
 * provider_facilities) so the UI can offer a "Referring facility" picker and default to the primary one
 * — the same facility auto-captured server-side. The first entry (facilities are ordered active-by-name)
 * is the primary; exposed as `primaryFacilityUuid`.
 */
export async function referralOptions(req, res, next) {
  try {
    const facs = await listProviderFacilities(req.authUserId);
    const facilities = facs.map((f) => ({ uuid: f.uuid, name: f.name, npi: f.npi || null, state: f.state || null }));
    res.json({
      specialties: SPECIALTIES, directions: DIRECTIONS, priorities: PRIORITIES, statuses: STATUSES,
      facilities, primaryFacilityUuid: facilities[0]?.uuid || null,
    });
  } catch (err) { next(err); }
}

/**
 * NPPES NPI Registry lookup for the referral form — find the REFERRED-TO consultant (an individual
 * provider, NPI-1) or clinic/facility (organization, NPI-2) by NPI or name, so the counterparty's real
 * name, organization, fax, and taxonomy auto-fill accurately from the federal registry (no hand-typing,
 * no guessing). Provider-accessible (any referral author), unlike the admin-only /users|/facilities/nppes.
 * `type` = 'provider' | 'facility' | 'both' (default both). Returns a unified candidate list.
 */
export async function nppesLookup(req, res, next) {
  try {
    if (!nppesEnabled()) return res.status(503).json({ error: 'NPPES registry lookup is not available.', code: 'NPPES_DISABLED' });
    const { q = '', npi = '', state = '', city = '', type = 'both' } = req.query;
    const wantProv = type === 'provider' || type === 'both';
    const wantFac = type === 'facility' || type === 'both';
    const [provs, facs] = await Promise.all([
      wantProv ? searchProviders({ q, npi, state }).catch(() => []) : Promise.resolve([]),
      wantFac ? searchFacilities({ q, npi, state, city }).catch(() => []) : Promise.resolve([]),
    ]);
    // Unify into referral-counterparty candidates the form can apply directly.
    const candidates = [
      ...provs.map((p) => ({ kind: 'provider', npi: p.npi, name: p.fullName, org: '', fax: '', taxonomy: p.taxonomy, city: p.city, state: p.state, credentials: p.credentials })),
      ...facs.map((f) => ({ kind: 'facility', npi: f.npi, name: f.name, org: f.name, fax: f.fax || '', taxonomy: f.taxonomy, city: f.city, state: f.state })),
    ];
    res.json({ candidates });
  } catch (err) { referralError(err, res, next); }
}

export async function list(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    res.json(await listReferrals(req.authUserId, {
      direction: String(req.query.direction || ''), status: String(req.query.status || ''),
      q: String(req.query.q || ''), page, pageSize,
    }));
  } catch (err) { referralError(err, res, next); }
}

export async function stats(req, res, next) {
  try { res.json(await referralStats(req.authUserId)); } catch (err) { next(err); }
}

/**
 * Provider-facing "fetch incoming now" — forces one real reconcile pass (pull the Fax.Plus inbox, ingest
 * any new received fax, self-heal documents, settle outbound status). Idempotent + single-in-flight (a
 * concurrent click returns 'already-running'), and a no-op when fax isn't live — so it is safe to expose
 * to any referral user. The UI calls this on the manual Refresh button; the periodic auto-refresh just
 * re-reads the list (cheap) since the server reconciler + webhook already fetch on their own.
 */
export async function refreshInbox(req, res, next) {
  try { res.json({ ok: true, result: await runFaxReconcileOnce('provider-refresh') }); }
  catch (err) { faxError2(err, res, next); }
}

export async function getOne(req, res, next) {
  try {
    const r = await getReferral(req.authUserId, req.params.uuid);
    if (!r) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    res.json({ referral: r });
  } catch (err) { referralError(err, res, next); }
}

export async function create(req, res, next) {
  try {
    const referral = await createReferral(req.authUserId, req.body || {});
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.create', entityType: 'referral', entityId: referral.uuid, ...ctx(req), metadata: { direction: referral.direction, specialty: referral.specialty } });
    res.status(201).json({ referral });
  } catch (err) { referralError(err, res, next); }
}

export async function update(req, res, next) {
  try {
    const referral = await updateReferral(req.authUserId, req.params.uuid, req.body || {});
    if (!referral) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.update', entityType: 'referral', entityId: referral.uuid, ...ctx(req), metadata: { fields: Object.keys(req.body || {}) } });
    res.json({ referral });
  } catch (err) { referralError(err, res, next); }
}

export async function remove(req, res, next) {
  try {
    const ok = await deleteReferral(req.authUserId, req.params.uuid);
    if (!ok) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.delete', entityType: 'referral', entityId: req.params.uuid, ...ctx(req) });
    res.json({ ok: true });
  } catch (err) { referralError(err, res, next); }
}

export async function generate(req, res, next) {
  try {
    const out = await generateReferralLetter(req.authUserId, req.params.uuid);
    if (!out) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.generate', entityType: 'referral', entityId: req.params.uuid, ...ctx(req) });
    res.json({ letter: out.letter, referral: out.referral });
  } catch (err) { referralError(err, res, next); }
}

/** Enterprise referral PDF (facility letterhead) — for the on-screen preview panel + download. */
export async function pdf(req, res, next) {
  try {
    const out = await referralPdfBuffer(req.authUserId, req.params.uuid);
    if (!out) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
    res.send(out.buffer);
  } catch (err) { referralError(err, res, next); }
}

/** Stream an incoming referral's RECEIVED document (inbound fax PDF) for in-app viewing. Read-scoped. */
export async function receivedDocument(req, res, next) {
  try {
    const out = await receivedDocumentBuffer(req.authUserId, req.params.uuid);
    if (!out) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
    res.send(out.buffer);
  } catch (err) { referralError(err, res, next); }
}

// ---- Fax (Fax.Plus) ----------------------------------------------------------------------------
const faxError2 = (err, res, next) => {
  if (err.code && /^(FAX_|REFERRAL_)/.test(err.code)) return res.status(err.status || 502).json({ error: err.message, code: err.code });
  return next(err);
};

/** Send a referral out by fax (owner-scoped). */
export async function sendFax(req, res, next) {
  try {
    const r = await sendReferralFax(req.authUserId, req.params.uuid);
    if (!r) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.fax.send', entityType: 'referral', entityId: req.params.uuid, ...ctx(req), metadata: { faxId: r.fax?.id || null } });
    res.json({ referral: r });
  } catch (err) { faxError2(err, res, next); }
}

/** Re-fetch + store an inbound fax's received document into S3 if it is missing (self-heal, no data loss). */
export async function restoreDocument(req, res, next) {
  try {
    const key = await restoreInboundDocument(req.authUserId, req.params.uuid);
    if (key === null) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.fax.restore', entityType: 'referral', entityId: req.params.uuid, ...ctx(req) });
    const referral = await getReferral(req.authUserId, req.params.uuid);
    res.json({ referral });
  } catch (err) { faxError2(err, res, next); }
}

/** On-demand Fax.Plus AI (transcript / extract) for a referral's fax — only when the provider clicks it. */
export async function faxAiRun(req, res, next) {
  try {
    const r = await getReferral(req.authUserId, req.params.uuid); // scope check
    if (!r) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    if (!r.fax?.id) return res.status(400).json({ error: 'This referral has no fax to analyze.', code: 'FAX_NONE' });
    const mode = req.query.mode === 'extract' ? 'extract' : 'transcript';
    const result = await faxAi(r.fax.id, mode);
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.fax.ai', entityType: 'referral', entityId: req.params.uuid, ...ctx(req), metadata: { mode } });
    res.json({ mode, result });
  } catch (err) { faxError2(err, res, next); }
}

/** Reconcile ONE referral's fax status directly from the Fax.Plus API (real-time authoritative sync). */
export async function reconcileFax(req, res, next) {
  try {
    const referral = await reconcileFaxStatus(req.authUserId, req.params.uuid);
    if (!referral) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    res.json({ referral });
  } catch (err) { faxError2(err, res, next); }
}

/** SUPER ADMIN: sync the Fax.Plus inbox directly (catch any received fax a webhook missed). */
export async function adminSyncInbox(req, res, next) {
  try {
    // FULL reconcile on demand: inbox catch-up + received-document self-heal + outbound status settle.
    const full = await reconcileAllFaxes();
    const inbox = full.inbox && !full.inbox.error ? full.inbox : { total: 0, ingested: 0, existing: 0 };
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.fax.inbox_sync', entityType: 'referral', entityId: 'inbox', ...ctx(req), metadata: full });
    // Keep ingested/existing at top level for the existing UI toast; include the full breakdown too.
    res.json({ ...inbox, reconcile: full });
  } catch (err) { faxError2(err, res, next); }
}

/** Fax integration status (non-secret) — for the UI + Super Admin. */
export function faxStatus(req, res) { res.json(faxStatusInfo()); }

/** One-time OAuth consent URL (admin only). */
export function faxAuthorizeUrl(req, res, next) {
  try { res.json({ url: getAuthorizeUrl(String(req.query.state || '')) }); } catch (err) { faxError2(err, res, next); }
}

/** Exchange the OAuth `code` for tokens (admin only). Returns the refresh_token to place in .env. */
export async function faxOauthCallback(req, res, next) {
  try {
    const code = String(req.query.code || req.body?.code || '');
    if (!code) return res.status(400).json({ error: 'Missing authorization code.', code: 'FAX_OAUTH' });
    const tokens = await exchangeCode(code);
    res.json({ ok: true, note: 'Save refresh_token to FAXPLUS_REFRESH_TOKEN in the server .env, then restart the backend.', refresh_token: tokens.refresh_token || null, expires_in: tokens.expires_in || null });
  } catch (err) { faxError2(err, res, next); }
}

/**
 * ACTIVATE live faxing from the Super Admin UI: exchange the pasted one-time OAuth `code`, persist the
 * refresh token (encrypted), flip the integration live in-process, and verify. Returns the fresh status.
 */
export async function faxActivate(req, res, next) {
  try {
    const status = await activateFax(String(req.body?.code || ''));
    startFaxReconciler(); // live now → start the no-missed-faxes reconcile heartbeat + immediate catch-up
    await recordAudit({ actorUserId: req.authUserId, action: 'fax.activate', entityType: 'integration', entityId: 'faxplus', ...ctx(req), metadata: { enabled: status.enabled } });
    res.json({ ok: true, status });
  } catch (err) { faxError2(err, res, next); }
}

/**
 * ACTIVATE via a Personal Access Token (direct API) — the reliable path when the OAuth authorization-code
 * client isn't usable. Verifies the token live before storing. Starts the reconciler on success.
 */
export async function faxSetPersonalToken(req, res, next) {
  try {
    const status = await setFaxPersonalAccessToken(String(req.body?.token || ''));
    if (status.enabled) startFaxReconciler(); else stopFaxReconciler();
    await recordAudit({ actorUserId: req.authUserId, action: 'fax.pat.set', entityType: 'integration', entityId: 'faxplus', ...ctx(req), metadata: { enabled: status.enabled, hasPersonalAccessToken: status.hasPersonalAccessToken } });
    res.json({ ok: true, status });
  } catch (err) { faxError2(err, res, next); }
}

/** Register the INBOUND webhook endpoint with Fax.Plus (instant inbound). Body: { url } (public HTTPS). */
export async function faxRegisterWebhook(req, res, next) {
  try {
    const out = await registerWebhook(String(req.body?.url || ''));
    await recordAudit({ actorUserId: req.authUserId, action: 'fax.webhook.register', entityType: 'integration', entityId: 'faxplus', ...ctx(req), metadata: { url: out.endpoint?.url, created: out.created } });
    res.json({ ok: true, ...out });
  } catch (err) { faxError2(err, res, next); }
}
/** Fax.Plus AI credit/availability status (real, non-secret). */
export async function faxAiStatus(req, res, next) {
  try { res.json(await faxAiCredits()); } catch (err) { faxError2(err, res, next); }
}
/** List the Fax.Plus webhook endpoints. */
export async function faxListWebhooks(req, res, next) {
  try { res.json({ endpoints: await listWebhooks() }); } catch (err) { faxError2(err, res, next); }
}
/** Delete a Fax.Plus webhook endpoint by id. */
export async function faxDeleteWebhook(req, res, next) {
  try {
    const out = await deleteWebhook(String(req.params.id || ''));
    await recordAudit({ actorUserId: req.authUserId, action: 'fax.webhook.delete', entityType: 'integration', entityId: 'faxplus', ...ctx(req), metadata: { id: req.params.id } });
    res.json({ ok: true, ...out });
  } catch (err) { faxError2(err, res, next); }
}

/** Store/replace the Fax.Plus (Svix) webhook signing secret (whsec_…) used to verify inbound webhooks. */
export async function faxSetWebhookSecret(req, res, next) {
  try {
    const status = await setFaxWebhookSecret(String(req.body?.secret || ''));
    await recordAudit({ actorUserId: req.authUserId, action: 'fax.webhook_secret.set', entityType: 'integration', entityId: 'faxplus', ...ctx(req), metadata: { hasWebhookSecret: status.hasWebhookSecret } });
    res.json({ ok: true, status });
  } catch (err) { faxError2(err, res, next); }
}

/** Deactivate live faxing (clear the stored refresh token). Super Admin only. */
export async function faxDeactivate(req, res, next) {
  try {
    const status = await deactivateFax();
    stopFaxReconciler(); // no longer live → stop the reconcile heartbeat
    await recordAudit({ actorUserId: req.authUserId, action: 'fax.deactivate', entityType: 'integration', entityId: 'faxplus', ...ctx(req) });
    res.json({ ok: true, status });
  } catch (err) { faxError2(err, res, next); }
}

/**
 * PUBLIC Fax.Plus (Svix) webhook — real-time inbound-fax + status events. Authenticated by the Svix
 * signature over the RAW body (captured in app.js); an unsigned/invalid request is rejected 401. On a
 * received fax it ingests an incoming referral (downloads + files the document); status events update
 * the matching referral. Always answers fast so Fax.Plus does not retry a processed event.
 */
export async function faxWebhook(req, res) {
  const ok = verifyFaxWebhook({
    id: req.get('svix-id'), timestamp: req.get('svix-timestamp'), signature: req.get('svix-signature'),
    rawBody: req.rawBody || (req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0)),
  });
  if (!ok) return res.status(401).json({ error: 'invalid signature' });
  res.status(200).json({ received: true }); // ack immediately; process after
  try {
    const evt = req.body || {};
    const type = evt.type || evt.event || '';
    const data = evt.data || evt.payload || evt;
    if (/received|inbound/i.test(type) || data.direction === 'incoming') { await ingestIncomingFax(data); }
    else if (data.id && data.status) { await updateFaxStatus(data.id, { status: data.status, pages: data.pages }); }
  } catch (err) { logger.error({ err: err.message }, 'fax webhook processing failed'); }
}

// ---- Super Admin oversight (route-guarded to super/master admin) --------------------------------
export async function adminList(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    res.json(await listAllReferrals({ direction: String(req.query.direction || ''), status: String(req.query.status || ''), q: String(req.query.q || ''), page, pageSize }));
  } catch (err) { next(err); }
}
export async function adminStats(req, res, next) {
  try { res.json({ referrals: await allReferralStats(), fax: faxStatusInfo(), reconciler: faxReconcilerStatus() }); } catch (err) { next(err); }
}

// ---- Referral attachments (uploaded PDF records enclosed in the package) ------------------------
const PDF_MAGIC = Buffer.from('%PDF-');
export async function uploadAttachment(req, res, next) {
  try {
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'No file uploaded.', code: 'REFERRAL_INVALID' });
    // Accept PDF only (validated by magic bytes, not just the client-declared type) — the package is faxed.
    if (!req.file.buffer.subarray(0, 5).equals(PDF_MAGIC)) return res.status(400).json({ error: 'Only PDF records can be enclosed.', code: 'REFERRAL_NOT_PDF' });
    const att = await addReferralAttachment(req.authUserId, req.params.uuid, { fileName: req.file.originalname, buffer: req.file.buffer, contentType: 'application/pdf', size: req.file.size });
    if (!att) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.attachment.add', entityType: 'referral', entityId: req.params.uuid, ...ctx(req), metadata: { size: att.size } });
    res.status(201).json({ attachment: att });
  } catch (err) { referralError(err, res, next); }
}
export async function listAttachments(req, res, next) {
  try {
    const items = await listReferralAttachments(req.authUserId, req.params.uuid);
    if (items === null) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    res.json({ attachments: items });
  } catch (err) { referralError(err, res, next); }
}
export async function removeAttachment(req, res, next) {
  try {
    const ok = await deleteReferralAttachment(req.authUserId, req.params.uuid, req.params.attUuid);
    if (ok === null) return res.status(404).json({ error: 'Referral not found.', code: 'NOT_FOUND' });
    if (!ok) return res.status(404).json({ error: 'Attachment not found.', code: 'NOT_FOUND' });
    await recordAudit({ actorUserId: req.authUserId, action: 'referral.attachment.delete', entityType: 'referral', entityId: req.params.uuid, ...ctx(req) });
    res.json({ ok: true });
  } catch (err) { referralError(err, res, next); }
}
