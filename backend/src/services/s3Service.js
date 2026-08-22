import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * S3 access for patient documents. Credentials live only on the server; the
 * browser never sees them. Every object is stored server-side-encrypted (SSE)
 * under a strict per-patient key prefix so isolation is enforced by the key
 * space as well as by the DB scoping in the controllers.
 */
const client = config.s3.enabled
  ? new S3Client({
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    })
  : null;

export const s3Enabled = () => !!client;

/** Master folder that contains every patient's upload subfolder. */
export const MASTER_PREFIX = 'patients/';

/** All objects for a patient live under this prefix — the patient's "folder". */
export function patientPrefix(patientUuid) {
  return `${MASTER_PREFIX}${patientUuid}/`;
}

/**
 * Ensure the master upload folder exists (a zero-byte, encrypted marker). Called
 * on boot so the bucket always shows the master `patients/` folder that holds
 * every patient's documents, even before the first patient is created.
 */
export async function ensureMasterFolder() {
  if (!client) return;
  try {
    await client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: `${MASTER_PREFIX}.keep`,
      Body: '',
      ServerSideEncryption: 'AES256',
      ContentType: 'application/octet-stream',
    }));
  } catch (e) { logger.warn({ err: e.message }, 'Could not ensure S3 master folder'); }
}

/**
 * Create the patient's folder by writing a zero-byte marker. S3 has no real
 * folders, but the prefix + marker makes the per-patient namespace explicit.
 */
export async function ensurePatientFolder(patientUuid) {
  if (!client) return;
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: `${patientPrefix(patientUuid)}.keep`,
    Body: '',
    ServerSideEncryption: 'AES256',
    ContentType: 'application/octet-stream',
  }));
}

export async function uploadPatientObject(patientUuid, key, buffer, contentType) {
  if (!client) throw new Error('S3 is not configured.');
  const fullKey = `${patientPrefix(patientUuid)}${key}`;
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
 * patient's folder, so it can never see another patient's objects. */
export async function listPatientKeys(patientUuid, subPrefix = '') {
  if (!client) return [];
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: `${patientPrefix(patientUuid)}${subPrefix}`,
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
