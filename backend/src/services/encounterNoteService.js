import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { getOwnedEncounterId } from './encounterService.js';
import { storeSignedNoteDoc } from './noteDocumentService.js';

/**
 * Clinical notes for an encounter. Body is encrypted PHI (structured JSON).
 * A note is DRAFT until signed; once signed it is immutable and billing-ready.
 *
 * SIGN-OFF AUTHORITY: only a provider holding one of SIGNER_CREDENTIALS (MD)
 * may approve/sign a note. Enforced server-side — the UI gate is advisory only.
 */
export const SIGNER_CREDENTIALS = ['MD'];

function safeParse(buf) { try { return JSON.parse(decrypt(buf)); } catch { return null; } }
function credsOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}
export function canSign(credentials) {
  return credsOf(credentials).map((c) => String(c).toUpperCase().trim()).some((c) => SIGNER_CREDENTIALS.includes(c));
}

export async function listNotes(encounterUuid, providerId) {
  const encId = await getOwnedEncounterId(encounterUuid, providerId);
  if (!encId) return null;
  const [rows] = await execute(
    `SELECT uuid, note_type, reason, status, billing_ready, signed_by_name,
        DATE_FORMAT(signed_at, '%Y-%m-%dT%H:%i:%sZ') AS signed_at,
        DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_at
      FROM encounter_notes WHERE encounter_id = :e ORDER BY created_at DESC`,
    { e: encId },
  );
  return rows.map((r) => ({
    uuid: r.uuid, noteType: r.note_type, reason: r.reason,
    status: r.status, billingReady: !!r.billing_ready,
    signedByName: r.signed_by_name, signedAt: r.signed_at, updatedAt: r.updated_at,
  }));
}

export async function getNote(noteUuid, providerId) {
  const [rows] = await execute(
    `SELECT n.uuid, n.note_type, n.reason, n.content_enc, n.status, n.billing_ready, n.signed_by_name,
        DATE_FORMAT(n.signed_at, '%Y-%m-%dT%H:%i:%sZ') AS signed_at
      FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
      WHERE n.uuid = :u AND e.provider_id = :pid LIMIT 1`,
    { u: noteUuid, pid: providerId },
  );
  const r = rows[0];
  if (!r) return null;
  return {
    uuid: r.uuid, noteType: r.note_type, reason: r.reason,
    content: r.content_enc ? (safeParse(r.content_enc) || {}) : {},
    status: r.status, billingReady: !!r.billing_ready,
    signedByName: r.signed_by_name, signedAt: r.signed_at,
  };
}

export async function createNote({ encounterUuid, providerId, noteType, reason, content, createdBy }) {
  const encId = await getOwnedEncounterId(encounterUuid, providerId);
  if (!encId) return null;
  const uuid = uuidv4();
  await execute(
    `INSERT INTO encounter_notes (uuid, encounter_id, provider_id, note_type, reason, content_enc, status, created_by)
     VALUES (:uuid, :e, :pid, :type, :reason, :content, 'draft', :createdBy)`,
    { uuid, e: encId, pid: providerId, type: noteType, reason: reason || null,
      content: content ? encrypt(JSON.stringify(content)) : null, createdBy },
  );
  return getNote(uuid, providerId);
}

async function findDraft(noteUuid, providerId) {
  const [rows] = await execute(
    `SELECT n.id, n.status FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
      WHERE n.uuid = :u AND e.provider_id = :pid LIMIT 1`,
    { u: noteUuid, pid: providerId },
  );
  return rows[0] || null;
}

export async function updateNote(noteUuid, providerId, { content, reason, noteType }) {
  const r = await findDraft(noteUuid, providerId);
  if (!r) return null;
  if (r.status === 'signed') return { locked: true }; // signed notes are immutable
  const sets = ['content_enc = :content'];
  const params = { id: r.id, content: content ? encrypt(JSON.stringify(content)) : null };
  if (reason !== undefined) { sets.push('reason = :reason'); params.reason = reason || null; }
  if (noteType !== undefined) { sets.push('note_type = :type'); params.type = noteType; }
  await execute(`UPDATE encounter_notes SET ${sets.join(', ')} WHERE id = :id`, params);
  return getNote(noteUuid, providerId);
}

/** Sign-off: MD-only. Persists final edits, locks the note, marks billing-ready. */
export async function signNote(noteUuid, providerId, { content, reason } = {}) {
  const [urows] = await execute(`SELECT full_name_enc, credentials FROM users WHERE id = :id LIMIT 1`, { id: providerId });
  const u = urows[0];
  if (!u || !canSign(u.credentials)) return { forbidden: true };

  const r = await findDraft(noteUuid, providerId);
  if (!r) return null;
  if (r.status === 'signed') return { locked: true };
  const signerName = u.full_name_enc ? decrypt(u.full_name_enc) : null;
  const sets = ['status = \'signed\'', 'billing_ready = 1', 'signed_by = :pid', 'signed_by_name = :name', 'signed_at = NOW()'];
  const params = { id: r.id, pid: providerId, name: signerName };
  if (content !== undefined) { sets.push('content_enc = :content'); params.content = content ? encrypt(JSON.stringify(content)) : null; }
  if (reason !== undefined) { sets.push('reason = :reason'); params.reason = reason || null; }
  await execute(`UPDATE encounter_notes SET ${sets.join(', ')} WHERE id = :id`, params);
  const signed = await getNote(noteUuid, providerId);

  // Auto-generate the Word document of the finalized note into the patient folder.
  const [meta] = await execute(
    `SELECT p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc, e.encounter_no,
        DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos
      FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
      LEFT JOIN appointments a ON a.id = e.appointment_id
      LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.id = :id LIMIT 1`,
    { id: r.id },
  );
  const m = meta[0];
  if (m && m.patient_uuid) {
    const demo = safeParse(m.demographics_enc) || {};
    const fac = safeParse(m.facility_enc) || {};
    const patientName = `${demo.firstName || ''} ${demo.lastName || ''}`.trim() || 'Patient';
    await storeSignedNoteDoc({
      patientUuid: m.patient_uuid, patientName, encounterDate: m.dos || '',
      note: signed, signerName, signedAt: signed.signedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
      patient: { mrn: m.mrn, dob: demo.dob, facilityName: fac.facilityName, encounterNo: m.encounter_no },
    });
  }
  return signed;
}
