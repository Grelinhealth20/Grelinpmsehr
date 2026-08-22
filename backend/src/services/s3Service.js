import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
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

/** All objects for a patient live under this prefix — the patient's "folder". */
export function patientPrefix(patientUuid) {
  return `patients/${patientUuid}/`;
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
