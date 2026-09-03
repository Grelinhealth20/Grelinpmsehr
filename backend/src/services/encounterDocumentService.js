import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { getAccessibleEncounterId } from './encounterService.js';
import { getPatientS3Ctx } from './patientService.js';
import {
  s3Enabled, ensureEncounterFolder, uploadPatientObject, signedGetUrl, deleteObject,
} from './s3Service.js';
import {
  createDocumentRecord, listEncounterDocuments, getRawDocByUuid, deleteDocumentRecord,
} from './patientDocumentService.js';

/**
 * Encounter-scoped LAB / IMAGING document attachments. Files live in S3 UNDER the patient's own
 * folder, in a per-encounter sub-folder that is created automatically:
 *   facilities/<facility>/providers/<provider>/patients/<patient>/encounters/<no>/{labs,imaging}/…
 * Every operation is access-controlled through getAccessibleEncounterId, so a provider can only
 * attach to / read / delete documents on encounters they can access — never another patient's.
 */

const KINDS = { lab: 'labs', imaging: 'imaging' };
export const DOC_KINDS = new Set(Object.keys(KINDS)); // 'lab' | 'imaging'

const MIME_EXT = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/tiff': '.tif', 'application/dicom': '.dcm',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
export const ALLOWED_DOC_MIME = new Set(Object.keys(MIME_EXT));
export const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25 MB (imaging can be large)

/**
 * Content sniffing (defense in depth): the client-declared MIME is untrusted,
 * so verify the actual file bytes (magic numbers) before storing. Returns the
 * canonical MIME inferred from the header, or null if the signature is unknown.
 */
function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';        // \x89PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';                        // JPEG
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';      // RIFF….WEBP
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return 'image/tiff';       // TIFF II*/MM*
  // DICOM: "DICM" magic at byte 128 (128-byte preamble)
  if (b.length >= 132 && b[128] === 0x44 && b[129] === 0x49 && b[130] === 0x43 && b[131] === 0x4d) return 'application/dicom';
  // ZIP container → Office Open XML (.docx)
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // OLE compound file → legacy .doc
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/msword';
  return null;
}

/** Resolve an accessible encounter to the context needed for storage. Null if no access. */
async function resolveEncounter(encounterUuid, userId) {
  const encId = await getAccessibleEncounterId(encounterUuid, userId);
  if (!encId) return null;
  const [rows] = await execute(
    `SELECT e.id AS encounter_id, e.encounter_no, p.id AS patient_id, p.uuid AS patient_uuid
       FROM encounters e JOIN patients p ON p.id = e.patient_id WHERE e.id = :id LIMIT 1`,
    { id: encId },
  );
  return rows[0] || null;
}

/** Upload one lab/imaging file to an encounter → { document } or { forbidden } / { error }. */
export async function addEncounterDocument({ encounterUuid, userId, kind, file }) {
  if (!s3Enabled()) return { error: 'Document storage is not configured.', code: 'S3_DISABLED', status: 503 };
  if (!DOC_KINDS.has(kind)) return { error: 'Invalid document kind.', code: 'BAD_KIND', status: 400 };
  if (!file) return { error: 'No file uploaded.', code: 'NO_FILE', status: 400 };
  const ext = MIME_EXT[file.mimetype];
  if (!ext) return { error: 'Unsupported file type. Use PDF, JPG, PNG, WEBP, TIFF, DICOM, or Word.', code: 'BAD_MIME', status: 400 };
  // Verify the actual bytes match the declared, allowed type (MIME can be spoofed).
  const sniffed = sniffMime(file.buffer);
  if (!sniffed || !ALLOWED_DOC_MIME.has(sniffed) || sniffed !== file.mimetype) {
    return { error: 'File contents do not match the declared type.', code: 'BAD_CONTENT', status: 400 };
  }
  if (file.size > MAX_DOC_BYTES) return { error: 'File exceeds the 25 MB limit.', code: 'TOO_LARGE', status: 400 };

  const enc = await resolveEncounter(encounterUuid, userId);
  if (!enc) return { forbidden: true };
  const s3ctx = await getPatientS3Ctx(enc.patient_uuid);
  if (!s3ctx) return { error: 'Patient folder unavailable.', code: 'NO_PATIENT', status: 404 };
  try { await ensureEncounterFolder(s3ctx, enc.encounter_no); } catch { /* best-effort marker */ }

  const key = `encounters/${String(enc.encounter_no).replace(/[^A-Za-z0-9._-]/g, '')}/${KINDS[kind]}/${uuidv4()}${ext}`;
  const s3Key = await uploadPatientObject(s3ctx, key, file.buffer, file.mimetype);
  const doc = await createDocumentRecord({
    patientId: enc.patient_id, encounterId: enc.encounter_id, docType: kind, s3Key,
    fileName: file.originalname, contentType: file.mimetype, size: file.size, uploadedBy: userId,
  });
  return { document: doc };
}

/** List an encounter's lab or imaging documents. */
export async function getEncounterDocuments({ encounterUuid, userId, kind }) {
  if (!DOC_KINDS.has(kind)) return { error: 'Invalid document kind.', code: 'BAD_KIND', status: 400 };
  const enc = await resolveEncounter(encounterUuid, userId);
  if (!enc) return { forbidden: true };
  return { documents: await listEncounterDocuments(enc.encounter_id, kind) };
}

/** A short-lived signed URL to view/download one document — access-checked via its encounter. */
export async function encounterDocumentUrl({ docUuid, userId }) {
  const doc = await getRawDocByUuid(docUuid);
  if (!doc || !doc.encounter_id) return { notFound: true };
  const [rows] = await execute('SELECT uuid FROM encounters WHERE id = :id LIMIT 1', { id: doc.encounter_id });
  const encUuid = rows[0]?.uuid;
  if (!encUuid || !(await getAccessibleEncounterId(encUuid, userId))) return { forbidden: true };
  return { url: await signedGetUrl(doc.s3_key, 300), fileName: doc.file_name_enc ? undefined : null, docType: doc.doc_type };
}

/** Delete one lab/imaging document (S3 object + DB row) — access-checked via its encounter. */
export async function removeEncounterDocument({ docUuid, userId }) {
  const doc = await getRawDocByUuid(docUuid);
  if (!doc || !doc.encounter_id) return { notFound: true };
  const [rows] = await execute('SELECT uuid FROM encounters WHERE id = :id LIMIT 1', { id: doc.encounter_id });
  const encUuid = rows[0]?.uuid;
  if (!encUuid || !(await getAccessibleEncounterId(encUuid, userId))) return { forbidden: true };
  try { await deleteObject(doc.s3_key); } catch { /* object may already be gone */ }
  await deleteDocumentRecord(doc.uuid);
  return { ok: true };
}
