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

/** Short-lived, read-only URL to view/download a single object. */
export async function signedGetUrl(s3Key, expiresIn = 300) {
  if (!client) throw new Error('S3 is not configured.');
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.s3.bucket, Key: s3Key }), { expiresIn });
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

if (!client) logger.warn('S3 not configured — patient document uploads are disabled.');
else ensureMasterFolder(); // create the master upload folder on boot (best-effort)
