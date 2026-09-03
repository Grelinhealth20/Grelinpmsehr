import { v4 as uuidv4 } from 'uuid';
import { execute, pool } from '../db/pool.js';
import { scrubClaim } from './codingService.js';
import { predictEncounterCoding } from './codePredictionService.js';
import { calcRaf, deriveSegment } from './hccRafService.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { getOwnedEncounterId, getAccessibleEncounterId } from './encounterService.js';
import { viewerScope, isFacilityWide, noteServiceLineWhere } from './accessScope.js';
import { storeSignedNoteDoc } from './noteDocumentService.js';
import { logger } from '../config/logger.js';

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
 * SIGN-OFF AUTHORITY: only a PHYSICIAN (MD or DO) may approve/finalize a note for
 * billing. NPPs (NP / APRN / PA) draft and route to a physician for the final signature.
 * Enforced server-side — the UI gate is advisory only.
 */
export const SIGNER_CREDENTIALS = ['MD', 'DO'];

function safeParse(buf) { try { return JSON.parse(decrypt(buf)); } catch { return null; } }
/**
 * Parse a NOTE BODY (encrypted clinical content). Unlike safeParse, a present-but-undecryptable
 * body is NOT silently treated as empty — that would let the editor load a blank note and let
 * autosave overwrite the real record with nothing. A null column is a legitimately empty note ({});
 * a decrypt/parse failure is corruption and is raised loudly so the record is never silently lost.
 */
function parseNoteBody(buf) {
  if (!buf) return {};
  try { return JSON.parse(decrypt(buf)); }
  catch {
    const err = new Error('This note could not be opened — its saved content failed to decrypt (possible data corruption). It was NOT modified.');
    err.status = 422; err.code = 'NOTE_CONTENT_UNREADABLE';
    throw err;
  }
}
/**
 * Decrypt patient IDENTITY (demographics) for a generated record or coding. A null column is a
 * legitimately empty value ({}); a present-but-undecryptable blob is corruption and is raised loudly
 * rather than silently yielding a blank-identity billing/medical record. (safeParse||{} is retained
 * only for SECONDARY context — insurance/facility — where a blank degrades gracefully.)
 */
function strictIdentity(buf, label = 'Patient demographics') {
  if (!buf) return {};
  try { return JSON.parse(decrypt(buf)); }
  catch {
    const err = new Error(`${label} could not be decrypted (possible data corruption) — the record cannot be generated.`);
    err.status = 422; err.code = 'PATIENT_IDENTITY_UNREADABLE';
    throw err;
  }
}
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
const isPhysicianCreds = (credentials) =>
  credsOf(credentials).map((c) => String(c).toUpperCase().trim()).some((c) => SIGNER_CREDENTIALS.includes(c));

/**
 * AUTOMATIC, compliance-proof attestation composed by the SYSTEM on sign-off — never hand-typed, so
 * every finalized record carries the correct CMS attestation language for its note type plus the
 * physician's identity. When a non-physician practitioner (NP/APRN/PA) performed the visit and a
 * physician finalizes it, the NPP is named as the rendering practitioner and the physician as the
 * attesting/finalizing physician (split/shared or collaborative service). The initial SNF visit (H&P)
 * is a physician service and is never framed as split/shared.
 */
const ATTESTATION_STATEMENTS = {
  hp: 'I personally performed this initial comprehensive visit in its entirety on the date of service. The initial SNF visit is a physician service and was not furnished as a split/shared visit.',
  soap: 'I personally performed the substantive portion of this evaluation and management service on the date of service.',
  progress: 'I personally performed the substantive portion of this evaluation and management service on the date of service.',
  discharge: 'I personally performed this discharge-day evaluation and management service on the date of service.',
  acuteChange: 'I personally performed this medically necessary unscheduled evaluation and management service on the date of service.',
  acp: 'I personally performed this advance care planning discussion on the date of service.',
  hospice: 'I am the patient’s designated attending physician (not employed by the hospice) and personally performed this visit on the date of service.',
  telehealth: 'This evaluation and management service was furnished via telehealth as attested; the billing team applies the telehealth modifier and place of service.',
  custom: 'I personally performed and reviewed this service on the date of service.',
};
// The initial comprehensive visit (H&P) must be physician-performed — never framed as split/shared.
const SPLIT_SHARED_TYPES = new Set(['soap', 'progress', 'discharge', 'acuteChange', 'acp', 'hospice', 'telehealth', 'custom']);

export function buildSignedAttestation({ noteType, signerName, signerCreds, rendering }) {
  const base = ATTESTATION_STATEMENTS[noteType] || ATTESTATION_STATEMENTS.custom;
  const parts = [base];
  if (rendering && SPLIT_SHARED_TYPES.has(noteType)) {
    const rc = rendering.creds?.length ? `, ${rendering.creds.join(', ')}` : '';
    const rn = rendering.npi ? ` (NPI ${rendering.npi})` : '';
    parts.push(`This visit was furnished as a split/shared or collaborative service: ${rendering.name}${rc}${rn} served as the rendering practitioner, and I, as the attending physician, personally performed the substantive portion and take responsibility for the care documented.`);
  }
  return {
    statement: parts.join(' '),
    signer: signerName || 'Provider',
    signerCredentials: (signerCreds || []).map((c) => String(c).toUpperCase().trim()).filter(Boolean),
    rendering: rendering || null,
    // signedAt / signedBy come from the note's signed_at / signed_by_name columns (authoritative).
  };
}

/** Resolve the rendering NON-PHYSICIAN practitioner (the note's author) when a physician finalizes
 *  a note someone else drafted. Returns null when the author is the signer or is themselves a physician. */
async function renderingNppFor(createdBy, signerId) {
  if (!createdBy || createdBy === signerId) return null;
  const [rows] = await execute('SELECT full_name_enc, credentials, npi FROM users WHERE id = :id LIMIT 1', { id: createdBy });
  const a = rows[0];
  if (!a || !a.full_name_enc || isPhysicianCreds(a.credentials)) return null;
  let name; try { name = decrypt(a.full_name_enc); } catch { return null; }
  if (!name) return null;
  return {
    name,
    creds: credsOf(a.credentials).map((c) => String(c).toUpperCase().trim()).filter(Boolean),
    npi: a.npi && /^\d{10}$/.test(String(a.npi).trim()) ? String(a.npi).trim() : '',
  };
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
    content: parseNoteBody(r.content_enc),
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
  const demo = strictIdentity(r.demographics_enc);
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
    `SELECT n.id, n.status, n.note_type, n.created_by, n.content_enc FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`,
    sp,
  );
  const r = srows[0];
  if (!r) return null;
  if (r.status === 'signed') return { locked: true };
  const signerName = signerDisplayName(u.full_name_enc, u.credentials, u.npi);
  // AUTO-ATTESTATION: compose the compliance attestation server-side and ALWAYS persist it with the
  // body, so every signed record carries it — independent of the client. Base is the client's final
  // edits when sent, otherwise the current stored body (never wiping content on sign).
  const base = content !== undefined ? (content || {}) : parseNoteBody(r.content_enc);
  const rendering = await renderingNppFor(r.created_by, providerId);
  const signedAttestation = buildSignedAttestation({ noteType: r.note_type, signerName, signerCreds: credsOf(u.credentials), rendering });
  const finalContent = { ...base, signedAttestation };
  const sets = ['status = \'signed\'', 'billing_ready = 1', 'signed_by = :pid', 'signed_by_name = :name', 'signed_at = NOW()',
    'content_enc = :content'];
  const params = { id: r.id, pid: providerId, name: signerName, content: encrypt(JSON.stringify(finalContent)) };
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
  // The note is already signed & committed at this point; document generation is best-effort and must
  // never break that. But it must also never emit a blank-IDENTITY legal record — if the patient
  // demographics can't be decrypted, log loudly and skip generation rather than produce a wrong doc.
  let demo;
  try { demo = m.demographics_enc ? JSON.parse(decrypt(m.demographics_enc)) : {}; }
  catch {
    logger.error({ noteId }, 'Signed-note document NOT generated: patient demographics failed to decrypt (possible corruption)');
    return;
  }
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
    `SELECT n.id, n.status, n.note_type, n.created_by, n.content_enc FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`,
    sp,
  );
  const r = srows[0];
  if (!r) return null;
  if (r.status !== 'signed') return { notSigned: true }; // only signed notes are "amended"
  const signerName = signerDisplayName(u.full_name_enc, u.credentials, u.npi);
  // Re-compose the attestation for the AMENDING physician (the record is now attested by them).
  const base = content !== undefined ? (content || {}) : parseNoteBody(r.content_enc);
  const rendering = await renderingNppFor(r.created_by, providerId);
  const signedAttestation = buildSignedAttestation({ noteType: r.note_type, signerName, signerCreds: credsOf(u.credentials), rendering });
  const finalContent = { ...base, signedAttestation };
  const sets = ['signed_by = :pid', 'signed_by_name = :name', 'signed_at = NOW()', 'content_enc = :content'];
  const params = { pid: providerId, name: signerName, id: r.id, content: encrypt(JSON.stringify(finalContent)) };
  const [res] = await execute(`UPDATE encounter_notes SET ${sets.join(', ')} WHERE id = :id AND status = 'signed'`, params);
  if (res.affectedRows === 0) return null;
  const amended = await getNote(noteUuid, providerId);
  await generateSignedDoc(r.id, amended, signerName);
  return amended;
}
