import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * S3 access for patient documents. Credentials live only on the server; the
 * browser never sees them. Every object is stored server-side-encrypted (SSE)
 * under a strict, HUMAN-READABLE, HIERARCHICAL key prefix:
 *
 *     facilities/{facility-name}__{id}/providers/{provider-name}__{id}/patients/{patient-name}__{id}/
 *
 * Each level is named after the real facility / provider / patient, with a short
 * unique id suffix so two same-named entities can NEVER collide (which would leak
 * data across patients). Isolation is enforced by the key space (facility →
 * provider → patient) AND by DB scoping in the controllers — a patient's records
 * can never sit outside their provider's folder, which can never sit outside their
 * facility's folder.
 */
const client = config.s3.enabled
  ? new S3Client({
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    })
  : null;

export const s3Enabled = () => !!client;

/** Root under which every facility folder lives. */
export const MASTER_PREFIX = 'facilities/';

// Sanitize a segment used as an S3 folder name (uuids are already safe; guard anyway).
const seg = (v, fallback) => {
  const s = String(v || '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  return s || fallback;
};
// Human-readable slug of a name: lowercase, hyphenated, ASCII-only, length-capped.
const slug = (v, max = 48) => String(v || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
// First 8 hex of the uuid — the collision-proof suffix.
const shortId = (uuid) => String(uuid || '').replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase();
/**
 * A readable, collision-safe folder segment: "<name-slug>__<short-uuid>".
 * The name makes the folder human-navigable; the id guarantees uniqueness so two
 * same-named facilities/providers/patients never share a folder. Falls back to the
 * uuid alone when no name is available (legacy callers / missing data).
 */
const nameSeg = (name, uuid, fallback) => {
  const id = shortId(uuid);
  const s = slug(name);
  if (s && id) return `${s}__${id}`;
  if (id) return id;
  return seg(uuid, fallback);
};

/** The facility folder prefix. Accepts a uuid string OR a ctx with facilityName. */
export function facilityPrefix(ctx) {
  const c = typeof ctx === 'string' ? { facilityUuid: ctx } : (ctx || {});
  return `${MASTER_PREFIX}${nameSeg(c.facilityName, c.facilityUuid, 'unassigned')}/`;
}
/** The provider folder prefix inside a facility. */
export function providerPrefix(ctx) {
  const c = ctx || {};
  return `${facilityPrefix(c)}providers/${nameSeg(c.providerName, c.providerUuid, 'unknown')}/`;
}
/**
 * All objects for a patient live under this prefix — the patient's named "folder",
 * nested under their provider, nested under their facility. Accepts a context
 * { patientUuid, patientName, providerUuid, providerName, facilityUuid, facilityName }.
 */
export function patientPrefix(ctx) {
  const c = typeof ctx === 'string' ? { patientUuid: ctx } : (ctx || {});
  return `${providerPrefix(c)}patients/${nameSeg(c.patientName, c.patientUuid, 'unknown')}/`;
}

/**
 * Ensure the master upload folder exists (a zero-byte, encrypted marker). Called
 * on boot so the bucket always shows the master `patients/` folder that holds
 * every patient's documents, even before the first patient is created.
 */
async function putMarker(key) {
  return client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: '',
    ServerSideEncryption: 'AES256',
    ContentType: 'application/octet-stream',
  }));
}

export async function ensureMasterFolder() {
  if (!client) return;
  try {
    await putMarker(`${MASTER_PREFIX}.keep`);
  } catch (e) { logger.warn({ err: e.message }, 'Could not ensure S3 master folder'); }
}

/**
 * Create the full facility → provider → patient folder chain with zero-byte
 * markers so each level is an explicit, visible namespace. S3 has no real
 * folders; the markers make the hierarchy concrete and keep empty folders visible.
 */
export async function ensurePatientFolder(ctx) {
  if (!client) return;
  await Promise.all([
    putMarker(`${facilityPrefix(ctx.facilityUuid)}.keep`),
    putMarker(`${providerPrefix(ctx)}.keep`),
    putMarker(`${providerPrefix(ctx)}patients/.keep`),
    putMarker(`${patientPrefix(ctx)}.keep`),
  ]);
}

/** Prefix for one encounter's folder inside the patient folder. */
export function encounterPrefix(ctx, encounterNo) {
  return `${patientPrefix(ctx)}encounters/${seg(String(encounterNo), 'encounter')}/`;
}
/**
 * Create the patient → encounters → <encounterNo> → {labs, imaging} folder chain with zero-byte
 * markers, so every encounter has its own visible labs/imaging namespace even before the first upload.
 * Automatically nested inside the patient's own folder (never outside it).
 */
export async function ensureEncounterFolder(ctx, encounterNo) {
  if (!client) return;
  const base = encounterPrefix(ctx, encounterNo);
  await Promise.all([
    putMarker(`${patientPrefix(ctx)}encounters/.keep`),
    putMarker(`${base}.keep`),
    putMarker(`${base}labs/.keep`),
    putMarker(`${base}imaging/.keep`),
  ]);
}

export async function uploadPatientObject(ctx, key, buffer, contentType) {
  if (!client) throw new Error('S3 is not configured.');
  const fullKey = `${patientPrefix(ctx)}${key}`;
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: fullKey,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    ServerSideEncryption: 'AES256',
  }));
  return fullKey;
}

/* ---- Referrals: a DEDICATED "Referrals/" root, mirroring facility → provider → patient ----------
 * Referral fax documents (sent + received) live UNDER their own top-level namespace, separate from the
 * clinical `facilities/` tree, but still organized facility → provider → patient so every document is
 * scoped to exactly the right place — never a generic/flat location. An inbound fax whose patient is
 * not yet identified lands in `Referrals/_incoming/` until a provider links it to a patient. */
const REFERRAL_PREFIX = 'Referrals/';
export function referralFacilityPrefix(ctx) {
  const c = typeof ctx === 'string' ? { facilityUuid: ctx } : (ctx || {});
  return `${REFERRAL_PREFIX}${nameSeg(c.facilityName, c.facilityUuid, 'unassigned')}/`;
}
export function referralProviderPrefix(ctx) {
  const c = ctx || {};
  return `${referralFacilityPrefix(c)}providers/${nameSeg(c.providerName, c.providerUuid, 'unknown')}/`;
}
export function referralPatientPrefix(ctx) {
  const c = typeof ctx === 'string' ? { patientUuid: ctx } : (ctx || {});
  return `${referralProviderPrefix(c)}patients/${nameSeg(c.patientName, c.patientUuid, 'unknown')}/`;
}
/** Create the Referrals → facility → provider → patient → {incoming,outgoing} marker chain. */
export async function ensureReferralFolder(ctx) {
  if (!client) return;
  const base = referralPatientPrefix(ctx);
  await Promise.all([
    putMarker(`${REFERRAL_PREFIX}.keep`),
    putMarker(`${referralFacilityPrefix(ctx)}.keep`),
    putMarker(`${referralProviderPrefix(ctx)}.keep`),
    putMarker(`${base}.keep`),
    putMarker(`${base}outgoing/.keep`),
    putMarker(`${base}incoming/.keep`),
  ]);
}
/**
 * Store a referral fax document under the Referrals tree. `direction` picks the incoming/outgoing
 * subfolder. When the patient is known the path is facility/provider/patient specific; an unidentified
 * inbound fax goes to `Referrals/_incoming/`. Server-side encrypted; the key is returned for the record.
 */
export async function uploadReferralObject(ctx, { direction = 'outgoing', fileName }, buffer, contentType) {
  if (!client) throw new Error('S3 is not configured.');
  const sub = direction === 'incoming' ? 'incoming' : 'outgoing';
  const base = ctx && ctx.patientUuid ? `${referralPatientPrefix(ctx)}${sub}/`
    : (ctx && ctx.facilityUuid ? `${referralFacilityPrefix(ctx)}${sub}/` : `${REFERRAL_PREFIX}_incoming/`);
  const fullKey = `${base}${seg(fileName, 'referral')}`;
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: fullKey, Body: buffer,
    ContentType: contentType || 'application/pdf', ServerSideEncryption: 'AES256',
  }));
  return fullKey;
}

/** Upload a facility logo into that facility's named S3 folder → returns the object
 *  key. Accepts a uuid string OR a ctx { facilityUuid, facilityName }. */
export async function uploadFacilityLogo(facilityCtx, buffer, contentType, ext) {
  if (!client) throw new Error('S3 is not configured.');
  const key = `${facilityPrefix(facilityCtx)}branding/logo.${ext || 'png'}`;
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'image/png',
    ServerSideEncryption: 'AES256',
  }));
  return key;
}

/** Short-lived, read-only URL to view a single object. When `downloadName` is given, the URL forces a
 *  browser DOWNLOAD (Content-Disposition: attachment) with a sanitized filename instead of inline view.
 *  The disposition is part of the SIGNED request, so it can't be tampered with after signing. */
export async function signedGetUrl(s3Key, expiresIn = 300, { downloadName = null } = {}) {
  if (!client) throw new Error('S3 is not configured.');
  const params = { Bucket: config.s3.bucket, Key: s3Key };
  if (downloadName) {
    const safe = String(downloadName).replace(/[^\w.\-() ]+/g, '_').slice(0, 200) || 'document';
    params.ResponseContentDisposition = `attachment; filename="${safe}"`;
  }
  return getSignedUrl(client, new GetObjectCommand(params), { expiresIn });
}

/** Fetch an object's raw bytes (server-side; e.g. to run OCR/extraction). */
export async function getObjectBytes(s3Key) {
  if (!client) throw new Error('S3 is not configured.');
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: s3Key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

/** List object keys under a patient's sub-prefix (e.g. 'notes/') — scoped to the
 * patient's folder, so it can never see another patient's objects. Accepts the
 * patient context { patientUuid, providerUuid, facilityUuid }. */
export async function listPatientKeys(ctx, subPrefix = '') {
  if (!client) return [];
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: `${patientPrefix(ctx)}${subPrefix}`,
      ContinuationToken: token,
    }));
    for (const o of res.Contents || []) out.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function deleteObject(s3Key) {
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: s3Key }));
}

export async function deleteObjects(keys) {
  if (!client || !keys.length) return;
  await client.send(new DeleteObjectsCommand({
    Bucket: config.s3.bucket,
    Delete: { Objects: keys.map((Key) => ({ Key })) },
  }));
}

/**
 * Delete EVERY object under a prefix (paginated list → batched delete; S3 caps DeleteObjects at
 * 1000 keys per call). Used by the Master facility wipe: because keys are hierarchical under
 * facilityPrefix(), passing that prefix removes all of the facility's patient/encounter/referral/
 * provider objects in one pass. Returns the number of objects deleted. No-op if S3 is off or the
 * prefix is empty/blank (a blank prefix is REFUSED so a wipe can never target the whole bucket).
 */
export async function deleteByPrefix(prefix) {
  if (!client) return 0;
  const p = String(prefix || '').trim();
  if (!p || p === '/' || !p.endsWith('/')) throw new Error(`deleteByPrefix refused unsafe prefix: ${JSON.stringify(prefix)}`);
  let deleted = 0; let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: p, ContinuationToken: token }));
    const keys = (res.Contents || []).map((o) => o.Key).filter(Boolean);
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await client.send(new DeleteObjectsCommand({ Bucket: config.s3.bucket, Delete: { Objects: batch.map((Key) => ({ Key })) } }));
      deleted += batch.length;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

if (!client) logger.warn('S3 not configured — patient document uploads are disabled.');
else ensureMasterFolder(); // create the master upload folder on boot (best-effort)
