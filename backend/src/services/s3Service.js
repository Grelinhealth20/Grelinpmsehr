import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * S3 access for patient documents. Credentials live only on the server; the
 * browser never sees them. Every object is stored server-side-encrypted (SSE)
 * under a strict HIERARCHICAL key prefix:
 *
 *     facilities/{facilityUuid}/providers/{providerUuid}/patients/{patientUuid}/
 *
 * so isolation is enforced by the key space (facility → provider → patient) as
 * well as by DB scoping in the controllers. A patient's records can never sit
 * outside their provider's folder, which can never sit outside their facility's
 * folder — preventing cross-facility / cross-provider leakage at the storage tier.
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

/** The facility folder prefix. */
export function facilityPrefix(facilityUuid) {
  return `${MASTER_PREFIX}${seg(facilityUuid, 'unassigned')}/`;
}
/** The provider folder prefix inside a facility. */
export function providerPrefix({ facilityUuid, providerUuid }) {
  return `${facilityPrefix(facilityUuid)}providers/${seg(providerUuid, 'unknown')}/`;
}
/**
 * All objects for a patient live under this prefix — the patient's "folder",
 * nested under their provider, nested under their facility.
 * Accepts a context object { patientUuid, providerUuid, facilityUuid }.
 */
export function patientPrefix(ctx) {
  const c = typeof ctx === 'string' ? { patientUuid: ctx } : (ctx || {});
  return `${providerPrefix(c)}patients/${seg(c.patientUuid, 'unknown')}/`;
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
