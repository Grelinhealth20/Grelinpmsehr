import { v4 as uuidv4 } from 'uuid';
import { execute, pool } from '../db/pool.js';
import { scrubClaim } from './codingService.js';
import { predictEncounterCoding } from './codePredictionService.js';
import { calcRaf, deriveSegment } from './hccRafService.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { getOwnedEncounterId, getAccessibleEncounterId } from './encounterService.js';
import { viewerScope, isFacilityWide, noteServiceLineWhere } from './accessScope.js';
import { storeSignedNoteDoc } from './noteDocumentService.js';

// Build the READ-access SQL condition for a note by the viewer's scope: own note, OR a
// facility-wide MD whose facilities include the patient's facility AND whose SERVICE
// LINE matches the note (a Pain MD never sees SNF notes and vice versa). Own notes are
// always the viewer's own service line, so they are unaffected.
function noteAccess(scope, userId, params) {
  params.pid = userId;
  if (!isFacilityWide(scope)) return 'e.provider_id = :pid';
  const ph = scope.facilityIds.map((id, i) => { params[`nf${i}`] = id; return `:nf${i}`; }).join(',');
  return `(e.provider_id = :pid OR (p.facility_id IN (${ph}) AND ${noteServiceLineWhere(scope, 'n')}))`;
}

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
/** Signer identity for the electronic signature: full name + credentials + NPI
 *  (e.g. "Jane Doe, MD · NPI 1234567893"). NPI is appended only when it is a valid 10-digit number. */
function signerDisplayName(fullNameEnc, credentials, npi) {
  const name = fullNameEnc ? decrypt(fullNameEnc) : null;
  if (!name) return null;
  const creds = credsOf(credentials).map((c) => String(c).toUpperCase().trim()).filter(Boolean);
  let out = creds.length ? `${name}, ${creds.join(', ')}` : name;
  if (npi && /^\d{10}$/.test(String(npi).trim())) out += ` · NPI ${String(npi).trim()}`;
  return out;
}

export async function listNotes(encounterUuid, providerId) {
  // Read access: own encounter, or a facility-wide MD's facility encounter.
  const scope = await viewerScope(providerId);
  const encId = await getAccessibleEncounterId(encounterUuid, providerId, scope);
  if (!encId) return null;
  // A facility-wide MD viewing an encounter they DON'T own sees only notes of their own
  // service line (no cross-specialty note content). Own encounters are unrestricted.
  let slFilter = '';
  if (isFacilityWide(scope)) {
    const [own] = await execute('SELECT 1 FROM encounters WHERE id = :e AND provider_id = :pid LIMIT 1', { e: encId, pid: providerId });
    if (!own.length) slFilter = `AND ${noteServiceLineWhere(scope, 'encounter_notes')}`;
  }
  const [rows] = await execute(
    `SELECT uuid, note_type, reason, status, billing_ready, signed_by_name,
        DATE_FORMAT(signed_at, '%Y-%m-%dT%H:%i:%sZ') AS signed_at,
        DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updated_at
      FROM encounter_notes WHERE encounter_id = :e ${slFilter} ORDER BY created_at DESC`,
    { e: encId },
  );
  return rows.map((r) => ({
    uuid: r.uuid, noteType: r.note_type, reason: r.reason,
    status: r.status, billingReady: !!r.billing_ready,
    signedByName: r.signed_by_name, signedAt: r.signed_at, updatedAt: r.updated_at,
  }));
}

export async function getNote(noteUuid, providerId) {
  // Read access by scope: own note, or a facility-wide MD's facility note.
  const scope = await viewerScope(providerId);
  const params = { u: noteUuid };
  const access = noteAccess(scope, providerId, params);
  const [rows] = await execute(
    `SELECT n.uuid, n.note_type, n.reason, n.content_enc, n.status, n.billing_ready, n.signed_by_name,
        DATE_FORMAT(n.signed_at, '%Y-%m-%dT%H:%i:%sZ') AS signed_at,
        (e.provider_id = :pid) AS is_owner
      FROM encounter_notes n
      JOIN encounters e ON e.id = n.encounter_id
      LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`,
    params,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    uuid: r.uuid, noteType: r.note_type, reason: r.reason,
    content: r.content_enc ? (safeParse(r.content_enc) || {}) : {},
    status: r.status, billingReady: !!r.billing_ready,
    signedByName: r.signed_by_name, signedAt: r.signed_at,
    isOwner: !!Number(r.is_owner),
  };
}

// ---- Billable codes captured on a note (diagnoses + procedures) --------------------------------
// Diagnoses are captured SNOMED-first and carry the mapped billable ICD-10-CM; procedures are CPT.
// Stored structured in encounter_note_codes (queryable for claims), replaced wholesale on save.
const mapDxRow = (r) => ({ icd: r.code, description: r.description, snomedCode: r.snomed_code, snomedTerm: r.snomed_term, primary: !!r.is_primary });
const mapProcRow = (r) => ({ cpt: r.code, description: r.description, modifiers: r.modifiers, units: r.units });

export async function getNoteCodes(noteUuid, providerId) {
  const scope = await viewerScope(providerId);
  const params = { u: noteUuid };
  const access = noteAccess(scope, providerId, params);
  const [rows] = await execute(
    `SELECT n.id FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id WHERE n.uuid = :u AND ${access} LIMIT 1`, params);
  if (!rows[0]) return null;
  const [codes] = await execute(
    `SELECT kind, code, description, snomed_code, snomed_term, modifiers, units, is_primary, seq
       FROM encounter_note_codes WHERE note_id = :id ORDER BY kind, seq, id`, { id: rows[0].id });
  return {
    diagnoses: codes.filter((c) => c.kind === 'dx').map(mapDxRow),
    procedures: codes.filter((c) => c.kind === 'proc').map(mapProcRow),
  };
}

export async function saveNoteCodes(noteUuid, providerId, { diagnoses = [], procedures = [] } = {}) {
  const r = await findDraft(noteUuid, providerId);
  if (!r) return null;
  if (r.status === 'signed') return { locked: true }; // signed notes are immutable
  await execute('DELETE FROM encounter_note_codes WHERE note_id = :id', { id: r.id });
  const rows = [];
  (Array.isArray(diagnoses) ? diagnoses : []).forEach((d, i) => {
    if (d && d.icd) rows.push([r.id, 'dx', 'ICD10CM', String(d.icd).slice(0, 20), (d.description || '').slice(0, 512) || null,
      d.snomedCode ? String(d.snomedCode).slice(0, 20) : null, (d.snomedTerm || '').slice(0, 512) || null, null, null,
      d.primary ? 1 : 0, i]);
  });
  (Array.isArray(procedures) ? procedures : []).forEach((p, i) => {
    if (p && p.cpt) rows.push([r.id, 'proc', 'CPT', String(p.cpt).slice(0, 20), (p.description || '').slice(0, 512) || null,
      null, null, (p.modifiers || '').slice(0, 20) || null, p.units != null ? Number(p.units) : null, 0, i]);
  });
  if (rows.length) {
    await pool.query(
      `INSERT INTO encounter_note_codes (note_id, kind, code_system, code, description, snomed_code, snomed_term, modifiers, units, is_primary, seq)
       VALUES ?`, [rows]);
  }
  return { saved: rows.length };
}

// Server-authoritative patient context for RAF/edits: age at DOS, sex, insurance (dual), SNF facility.
function ageAt(dob, asOf) {
  if (!dob) return null;
  const b = new Date(dob); const d = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime())) return null;
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a -= 1;
  return a >= 0 && a < 130 ? a : null;
}
async function noteRafPatient(noteUuid, providerId) {
  const scope = await viewerScope(providerId);
  const params = { u: noteUuid };
  const access = noteAccess(scope, providerId, params);
  const [rows] = await execute(
    `SELECT p.demographics_enc, p.insurance_enc, p.facility_enc,
        DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos
       FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN appointments a ON a.id = e.appointment_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`, params);
  const r = rows[0]; if (!r) return null;
  const demo = safeParse(r.demographics_enc) || {};
  const insRaw = r.insurance_enc ? safeParse(r.insurance_enc) : null;
  const insurance = Array.isArray(insRaw) ? insRaw : insRaw ? [insRaw] : [];
  const facility = r.facility_enc ? safeParse(r.facility_enc) : null;
  return { age: ageAt(demo.dob, r.dos), sex: demo.gender || demo.sex || null, insurance, facility, dos: r.dos };
}

/** Scrub the note's captured codes — Medicare Part B, Central FL (First Coast). No PDPM (Part A). */
export async function scrubNoteCodes(noteUuid, providerId, patientOverride) {
  const codes = await getNoteCodes(noteUuid, providerId);
  if (!codes) return null;
  const lines = codes.procedures.map((p) => ({ cpt: p.cpt, units: p.units || 1, modifiers: p.modifiers }));
  const diagnoses = codes.diagnoses.map((d) => d.icd).filter(Boolean);
  // Prefer server-authoritative patient context (age at DOS, dual/institutional status) over the
  // caller-supplied age/sex, so the RAF segment is derived from real data — not defaulted.
  const pctx = (await noteRafPatient(noteUuid, providerId)) || {};
  const age = pctx.age ?? patientOverride?.age;
  const sex = pctx.sex ?? patientOverride?.sex;
  const result = await scrubClaim({ lines, diagnoses, patient: { age, sex }, jurisdiction: 'FL' });
  // CMS-HCC V28 risk score from the captured diagnoses, with the segment derived from patient data.
  let raf = null;
  if (diagnoses.length) {
    const seg = deriveSegment({ age, insurance: pctx.insurance, facility: pctx.facility, dos: pctx.dos });
    raf = await calcRaf(diagnoses, { age, sex, segment: seg.segment, segmentBasis: seg.basis });
  }
  return { ...result, raf, codeCounts: { diagnoses: codes.diagnoses.length, procedures: codes.procedures.length } };
}

/**
 * DETERMINISTIC code prediction for the coding panel: read the note (scoped), then derive billable
 * diagnoses and the visit charge from what was written. Suggestions only — the coder confirms and
 * the live scrub re-validates before signing. Returns null if the note is out of the caller's scope.
 */
export async function predictCodes(noteUuid, providerId) {
  const note = await getNote(noteUuid, providerId);
  if (!note) return null;
  return predictEncounterCoding(note.content || {}, { noteType: note.noteType });
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
  const sets = [];
  const params = { id: r.id };
  // Only overwrite content when the caller actually sends it — a metadata-only
  // PATCH (e.g. reason/noteType) must NOT wipe the existing draft body (PHI loss).
  if (content !== undefined) { sets.push('content_enc = :content'); params.content = content ? encrypt(JSON.stringify(content)) : null; }
  if (reason !== undefined) { sets.push('reason = :reason'); params.reason = reason || null; }
  if (noteType !== undefined) { sets.push('note_type = :type'); params.type = noteType; }
  if (!sets.length) return getNote(noteUuid, providerId); // nothing to change
  // `AND status = 'draft'` makes the DB the arbiter: if a concurrent sign/amend
  // flipped this note to signed between our read and write, this update no-ops.
  const [res] = await execute(`UPDATE encounter_notes SET ${sets.join(', ')} WHERE id = :id AND status = 'draft'`, params);
  if (res.affectedRows === 0) return { locked: true }; // raced into signed — immutable
  return getNote(noteUuid, providerId);
}

/**
 * Sign-off: MD-only. An MD may sign their own notes AND any note for a patient at
 * a facility they are assigned to (e.g. approving another provider's note). Persists
 * final edits, locks the note, and marks it billing-ready.
 */
export async function signNote(noteUuid, providerId, { content, reason } = {}) {
  const [urows] = await execute(`SELECT full_name_enc, credentials, npi FROM users WHERE id = :id LIMIT 1`, { id: providerId });
  const u = urows[0];
  if (!u || !canSign(u.credentials)) return { forbidden: true };

  // Resolve the note within the signer's scope (own OR facility-wide MD).
  const scope = await viewerScope(providerId);
  const sp = { u: noteUuid };
  const access = noteAccess(scope, providerId, sp);
  const [srows] = await execute(
    `SELECT n.id, n.status FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`,
    sp,
  );
  const r = srows[0];
  if (!r) return null;
  if (r.status === 'signed') return { locked: true };
  const signerName = signerDisplayName(u.full_name_enc, u.credentials, u.npi);
  const sets = ['status = \'signed\'', 'billing_ready = 1', 'signed_by = :pid', 'signed_by_name = :name', 'signed_at = NOW()'];
  const params = { id: r.id, pid: providerId, name: signerName };
  if (content !== undefined) { sets.push('content_enc = :content'); params.content = content ? encrypt(JSON.stringify(content)) : null; }
  if (reason !== undefined) { sets.push('reason = :reason'); params.reason = reason || null; }
  // Guard against a double-sign race: only a still-draft row transitions to signed.
  const [res] = await execute(`UPDATE encounter_notes SET ${sets.join(', ')} WHERE id = :id AND status = 'draft'`, params);
  if (res.affectedRows === 0) return { locked: true }; // already signed by a concurrent request
  const signed = await getNote(noteUuid, providerId);
  await generateSignedDoc(r.id, signed, signerName);
  return signed;
}

/** (Re)generate the finalized Word document for a signed note into the patient's folder. */
async function generateSignedDoc(noteId, note, signerName) {
  const [meta] = await execute(
    `SELECT p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc, e.encounter_no,
        pu.uuid AS provider_uuid, pu.full_name_enc AS provider_name_enc,
        f.uuid AS facility_uuid, f.name AS facility_name,
        DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos
      FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
      LEFT JOIN appointments a ON a.id = e.appointment_id
      LEFT JOIN patients p ON p.id = e.patient_id
      LEFT JOIN users pu ON pu.id = p.provider_id
      LEFT JOIN facilities f ON f.id = p.facility_id
      WHERE n.id = :id LIMIT 1`,
    { id: noteId },
  );
  const m = meta[0];
  if (!m || !m.patient_uuid) return;
  const demo = safeParse(m.demographics_enc) || {};
  const fac = safeParse(m.facility_enc) || {};
  const patientName = `${demo.firstName || ''} ${demo.lastName || ''}`.trim() || 'Patient';
  let providerName = '';
  try { providerName = m.provider_name_enc ? decrypt(m.provider_name_enc) : ''; } catch { providerName = ''; }
  // Captured billable codes (by note id — we are the signer, already authorized) for the record.
  const [codeRows] = await execute(
    `SELECT kind, code, description, snomed_code, snomed_term, modifiers, units, is_primary, seq
       FROM encounter_note_codes WHERE note_id = :id ORDER BY kind, seq, id`, { id: noteId });
  const codes = {
    diagnoses: codeRows.filter((c) => c.kind === 'dx').map(mapDxRow),
    procedures: codeRows.filter((c) => c.kind === 'proc').map(mapProcRow),
  };
  await storeSignedNoteDoc({
    patientUuid: m.patient_uuid, patientName, encounterDate: m.dos || '',
    note, codes, signerName, signedAt: note.signedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
    patient: { mrn: m.mrn, dob: demo.dob, facilityName: fac.facilityName, encounterNo: m.encounter_no },
    // Patient's OWN provider + facility drive the S3 folder (not the signer's) — by
    // NAME with a unique id suffix so the folder path reads facility → provider → patient.
    s3ctx: {
      patientUuid: m.patient_uuid, patientName,
      providerUuid: m.provider_uuid, providerName,
      facilityUuid: m.facility_uuid, facilityName: m.facility_name || '',
    },
  });
}

/**
 * AMEND a SIGNED note — MD-only. A signed note is otherwise immutable; an MD may
 * correct/addend it, but MUST provide a reason (captured in the audit log by the
 * caller). The note stays signed & billing-ready, re-signed by the amending MD, and
 * its Word document is regenerated. Any provider without an MD credential is refused.
 */
export async function amendSignedNote(noteUuid, providerId, { content, reason } = {}) {
  const [urows] = await execute(`SELECT full_name_enc, credentials, npi FROM users WHERE id = :id LIMIT 1`, { id: providerId });
  const u = urows[0];
  if (!u || !canSign(u.credentials)) return { forbidden: true }; // MD only
  const scope = await viewerScope(providerId);
  const sp = { u: noteUuid };
  const access = noteAccess(scope, providerId, sp);
  const [srows] = await execute(
    `SELECT n.id, n.status FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`,
    sp,
  );
  const r = srows[0];
  if (!r) return null;
  if (r.status !== 'signed') return { notSigned: true }; // only signed notes are "amended"
  const signerName = signerDisplayName(u.full_name_enc, u.credentials, u.npi);
  const sets = ['signed_by = :pid', 'signed_by_name = :name', 'signed_at = NOW()'];
  const params = { pid: providerId, name: signerName, id: r.id };
  // Never null the clinical content on a metadata-only amendment — that would
  // destroy a finalized, billing-ready medical record. Only replace it when sent.
  if (content !== undefined) { sets.push('content_enc = :content'); params.content = content ? encrypt(JSON.stringify(content)) : null; }
  const [res] = await execute(`UPDATE encounter_notes SET ${sets.join(', ')} WHERE id = :id AND status = 'signed'`, params);
  if (res.affectedRows === 0) return null;
  const amended = await getNote(noteUuid, providerId);
  await generateSignedDoc(r.id, amended, signerName);
  return amended;
}
