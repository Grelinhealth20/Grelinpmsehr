import { v4 as uuidv4 } from 'uuid';
import { execute, pool, withTransaction } from '../db/pool.js';
import { scrubClaim } from './codingService.js';
import { predictEncounterCoding } from './codePredictionService.js';
import { calcRaf, deriveSegment } from './hccRafService.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { getOwnedEncounterId, getAccessibleEncounterId } from './encounterService.js';
import { viewerScope, isFacilityWide, noteServiceLineWhere, ownerServiceLineWhere } from './accessScope.js';
import { storeSignedNoteDoc } from './noteDocumentService.js';
import { isBillableIcd } from './terminologyCache.js';
import { posForNoteType } from './payscaleConfig.js';
import { logger } from '../config/logger.js';

// Build the READ-access SQL condition for a note by the viewer's scope: own note, OR a
// facility-wide MD whose facilities include the patient's facility AND whose SERVICE
// LINE matches the note's OWNING PROVIDER (a Pain MD never sees an SNF-owned patient's
// note and vice versa). Owner-based (not note-type based) so a UNIVERSAL note authored by
// another line's provider isn't reachable cross-line by UUID — matches patientScopeWhere.
// Own notes are always the viewer's own service line, so they are unaffected.
function noteAccess(scope, userId, params) {
  params.pid = userId;
  if (!isFacilityWide(scope)) return 'e.provider_id = :pid';
  const ph = scope.facilityIds.map((id, i) => { params[`nf${i}`] = id; return `:nf${i}`; }).join(',');
  return `(e.provider_id = :pid OR (p.facility_id IN (${ph}) AND ${ownerServiceLineWhere(scope, 'n')}))`;
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

  // ---- Florida Personal Injury (PIP/BI) — service-specific attestations (CMS/E-M + Fla. Stat.) ----
  pi_initial: 'I personally performed this initial evaluation of the injured patient on the date of service, and the findings, diagnoses, and causation opinion documented here are my own.',
  pi_soap: 'I personally performed the substantive portion of this evaluation and management service on the date of service.',
  pi_reexam: 'I personally performed this re-examination and reassessment on the date of service.',
  pi_emc: 'I am a provider qualified under Fla. Stat. §627.732 to render this determination, and I personally made the emergency-medical-condition determination documented here based on my evaluation and the records reviewed.',
  pi_mri: 'I personally reviewed the clinical findings and ordered the advanced imaging documented here, which I certify is medically necessary.',
  pi_narrative: 'The opinions in this narrative report are my own, held within a reasonable degree of medical probability, based on my personal evaluation of the patient and the records identified as reviewed.',
  pi_procedure: 'I personally performed the interventional procedure documented here on the date of service.',
  pi_imaging: 'I personally reviewed the imaging results and clinically correlated them to the patient’s presentation as documented on the date of service.',
  pi_workstatus: 'I personally examined the patient and certify the work status and restrictions documented here on the date of service.',
  pi_gap: 'I personally reviewed and documented the patient’s gap in care and the related counseling on the date of service.',
  pi_referral: 'I personally reviewed the clinical need for, and authorized, the referral/consultation documented here on the date of service.',
  pi_vob: 'I attest that the personal-injury benefits verification documented here was performed and recorded accurately.',

  // ---- Pain Management — service-specific attestations (CMS E/M, opioid stewardship, LCD) ----
  pain_initial: 'I personally performed this initial pain evaluation and management service on the date of service.',
  pain_followup: 'I personally performed the substantive portion of this evaluation and management service on the date of service.',
  pain_controlled: 'I personally performed this controlled-substance management service, personally reviewed the PDMP, and take full responsibility for the prescribing decisions documented here.',
  pain_procedure: 'I personally performed the interventional procedure documented here on the date of service.',
  pain_udt: 'I personally ordered and reviewed the drug testing documented here and acted on the results as medically necessary.',
  pain_reeval: 'I personally performed this periodic re-evaluation on the date of service.',
  pain_postproc: 'I personally performed this post-procedure evaluation on the date of service.',
  pain_telehealth: 'This evaluation and management service was furnished via telehealth as attested; the billing team applies the telehealth modifier and place of service.',
  pain_scs: 'I personally performed the neurostimulator trial/service documented here on the date of service.',
  pain_telephone: 'I personally conducted and documented this telephone/portal encounter with the patient on the date of service.',
  pain_replyletter: 'I personally performed the consultation and authored the findings and recommendations communicated in this letter.',
  pain_incidentto: 'This service was furnished incident-to my professional services: an established patient with an established plan of care, no new problem addressed at this visit, with me present in the office suite and immediately available throughout the service.',
  pain_abn: 'I attest that the Advance Beneficiary Notice documented here was delivered in advance and completed as recorded.',
  pain_priorauth: 'I personally reviewed the clinical record and authored the medical-necessity determination communicated in this letter.',
  pain_taper: 'I personally performed this evaluation and authored the individualized opioid taper plan documented here on the date of service.',
  pain_dme: 'I personally performed the face-to-face encounter and issued the standard written order for the item documented here, which I certify is medically necessary.',
  pain_discharge: 'I personally performed this discharge / care-transition evaluation on the date of service.',
};
// Note types eligible to be documented as split/shared or collaborative when a non-physician
// practitioner performs the service and a physician finalizes it. E/M visit types qualify; the
// initial comprehensive SNF visit (H&P), interventional PROCEDURES, and physician-only
// determinations/opinions/orders (EMC, narrative/permanency, work-status certification, imaging
// orders, prior-auth/medical-necessity, opioid taper authorship) are physician-performed and are
// NEVER framed as split/shared. `pain_incidentto` carries its own incident-to attestation.
const SPLIT_SHARED_TYPES = new Set([
  'soap', 'progress', 'discharge', 'acuteChange', 'acp', 'hospice', 'telehealth', 'custom',
  'pi_initial', 'pi_soap', 'pi_reexam', 'pi_imaging', 'pi_gap', 'pi_referral',
  'pain_initial', 'pain_followup', 'pain_controlled', 'pain_udt', 'pain_reeval',
  'pain_postproc', 'pain_telehealth', 'pain_telephone', 'pain_discharge', 'pain_abn', 'pain_dme',
]);

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

/**
 * DELETE a clinical note — gated by the Access Control "Delete Notes" permission (enforced at the route).
 * ENTERPRISE / COMPLIANCE RULE: only a DRAFT (unsigned) note may be deleted. A SIGNED or AMENDED note is
 * part of the finalized medico-legal record and can NEVER be deleted — it returns a clear error (amend
 * instead). Access is the same owner / facility-wide-MD scope as reading; a note outside scope is 404 (no
 * cross-provider deletion). The removal is audit-logged. No fallback, no soft-hide — a draft is removed
 * for real (its captured codes are removed first so nothing is orphaned).
 * @returns {{ ok:true } | { notFound:true }}  — throws NOTE_SIGNED (409) for a signed/amended note.
 */
export async function deleteNote(noteUuid, providerId) {
  const scope = await viewerScope(providerId);
  const params = { u: noteUuid };
  const access = noteAccess(scope, providerId, params);
  const [rows] = await execute(
    `SELECT n.id, n.status, n.note_type FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u AND ${access} LIMIT 1`,
    params,
  );
  const r = rows[0];
  if (!r) return { notFound: true };
  if (r.status !== 'draft') {
    const e = new Error('Signed notes cannot be deleted. Amend the note instead to correct the record.');
    e.status = 409; e.code = 'NOTE_SIGNED'; throw e;
  }
  // Remove captured codes first (no FK orphan), then the draft note itself. Re-check status = 'draft' in
  // the DELETE so a concurrent sign can never race a delete of a now-signed note. No fallback.
  await execute('DELETE FROM encounter_note_codes WHERE note_id = :id', { id: r.id });
  const [del] = await execute("DELETE FROM encounter_notes WHERE id = :id AND status = 'draft'", { id: r.id });
  if (!del.affectedRows) { const e = new Error('Signed notes cannot be deleted.'); e.status = 409; e.code = 'NOTE_SIGNED'; throw e; }
  logger.info({ noteUuid, providerId }, 'Draft clinical note deleted');
  return { ok: true, noteType: r.note_type };
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
  // VALIDATE every submitted code against the REAL CMS terminology datasets before persisting. A curated
  // code set flows verbatim into the signed claim / PDF / FHIR (persistPredictedCodes only fills an EMPTY
  // set), so an unknown or mistyped ICD/CPT/HCPCS must be rejected EXPLICITLY — never silently stored or
  // dropped. ICD via the billable set; procedures against cpt_codes UNION hcpcs_codes so legitimate
  // HCPCS Level II (J/G/…) codes are not wrongly refused. Nothing is written unless every code is real.
  const dxCodes = (Array.isArray(diagnoses) ? diagnoses : []).filter((d) => d && d.icd).map((d) => String(d.icd).trim());
  const procCodes = [...new Set((Array.isArray(procedures) ? procedures : []).filter((p) => p && p.cpt).map((p) => String(p.cpt).trim().toUpperCase()))];
  const invalidDx = [];
  for (const icd of dxCodes) { if (!(await isBillableIcd(icd))) invalidDx.push(icd); }
  let invalidProc = [];
  if (procCodes.length) {
    const params = {}; procCodes.forEach((c, i) => { params[`c${i}`] = c; });
    const inList = procCodes.map((_, i) => `:c${i}`).join(',');
    // Two separate lookups (NOT a UNION — the cpt_codes and hcpcs_codes `code` columns use different
    // collations, which makes a UNION throw). A procedure code is valid if it exists in EITHER dataset.
    const [cptRows] = await execute(`SELECT code FROM cpt_codes WHERE code IN (${inList})`, params);
    const [hcpcsRows] = await execute(`SELECT code FROM hcpcs_codes WHERE code IN (${inList})`, params);
    const knownSet = new Set([...cptRows, ...hcpcsRows].map((row) => String(row.code).toUpperCase()));
    invalidProc = procCodes.filter((c) => !knownSet.has(c));
  }
  if (invalidDx.length || invalidProc.length) {
    const e = new Error(`Unrecognized billing codes — not found in the CMS terminology datasets: ${[...invalidDx.map((c) => `ICD ${c}`), ...invalidProc.map((c) => `CPT/HCPCS ${c}`)].join(', ')}.`);
    e.status = 400; e.code = 'INVALID_CODES'; e.expose = true; e.details = { invalidDx, invalidProc };
    throw e;
  }
  // Build the replacement rows FIRST (so any bad input fails before we touch the DB), coercing units
  // safely: Number({}) / Number('x') → NaN, which must become NULL (never a NaN INSERT).
  const rows = [];
  (Array.isArray(diagnoses) ? diagnoses : []).forEach((d, i) => {
    if (d && d.icd) rows.push([r.id, 'dx', 'ICD10CM', String(d.icd).slice(0, 20), (String(d.description ?? '')).slice(0, 512) || null,
      d.snomedCode ? String(d.snomedCode).slice(0, 20) : null, (String(d.snomedTerm ?? '')).slice(0, 512) || null, null, null,
      d.primary ? 1 : 0, i]);
  });
  (Array.isArray(procedures) ? procedures : []).forEach((p, i) => {
    if (p && p.cpt) {
      const units = Number(p.units);
      rows.push([r.id, 'proc', 'CPT', String(p.cpt).slice(0, 20), (String(p.description ?? '')).slice(0, 512) || null,
        null, null, (String(p.modifiers ?? '')).slice(0, 20) || null, Number.isFinite(units) ? units : null, 0, i]);
    }
  });
  // Replace codes ATOMICALLY: the old delete-then-insert was not transactional, so an INSERT error
  // (bad row, oversized batch) left the note's codes permanently deleted while returning 500. A
  // transaction rolls back the delete on any failure, so codes are never lost.
  await withTransaction(async (exec, conn) => {
    await exec('DELETE FROM encounter_note_codes WHERE note_id = :id', { id: r.id });
    if (rows.length) {
      await conn.query(
        `INSERT INTO encounter_note_codes (note_id, kind, code_system, code, description, snomed_code, snomed_term, modifiers, units, is_primary, seq)
         VALUES ?`, [rows]);
    }
  });
  return { saved: rows.length };
}

/**
 * Persist the coding engine's DETERMINISTIC prediction as the note's structured billing codes at sign
 * time — so the finalized record, the downloaded PDF/DOCX, and the FHIR Condition/Procedure resources
 * all carry the SAME codes shown under the note's Billing heading. Called inside signNote, by note id
 * (the signer is already authorized). It NEVER overwrites codes that already exist (e.g. hand-curated in
 * the Billing Module) — the automatic prediction only fills an empty set. Best-effort: a failure here is
 * logged and must not break the (already-committed) signature. The prediction is server-recomputed on
 * the final signed content, so it is authoritative (not client-supplied) and, being deterministic,
 * matches exactly what the provider reviewed before signing.
 */
async function persistPredictedCodes(noteId, content, noteType, { replace = false } = {}) {
  if (!replace) {
    const [existing] = await execute('SELECT COUNT(*) AS n FROM encounter_note_codes WHERE note_id = :id', { id: noteId });
    if (Number(existing[0]?.n) > 0) return { skipped: 'codes already present' };
  }
  const pred = await predictEncounterCoding(content || {}, { noteType });
  const rows = [];
  (pred.diagnoses || []).forEach((d, i) => {
    if (d && d.icd) rows.push([noteId, 'dx', 'ICD10CM', String(d.icd).slice(0, 20), (String(d.description ?? '')).slice(0, 512) || null,
      d.snomedCode ? String(d.snomedCode).slice(0, 20) : null, (String(d.snomedTerm ?? '')).slice(0, 512) || null, null, null,
      d.primary ? 1 : 0, i]);
  });
  (pred.procedures || []).forEach((p, i) => {
    if (p && p.cpt) {
      const units = Number(p.units);
      const mod = Array.isArray(p.modifiers) ? p.modifiers.filter(Boolean).join(',') : String(p.modifiers ?? '');
      rows.push([noteId, 'proc', 'CPT', String(p.cpt).slice(0, 20), (String(p.description ?? '')).slice(0, 512) || null,
        null, null, mod.slice(0, 20) || null, Number.isFinite(units) ? units : null, 0, i]);
    }
  });
  // On REPLACE (amend) with an empty prediction, still clear stale codes so the record can't carry codes
  // for diagnoses the amendment removed. On fill-if-empty (sign) with nothing to save, do nothing.
  if (!rows.length) {
    if (replace) await execute('DELETE FROM encounter_note_codes WHERE note_id = :id', { id: noteId });
    return { saved: 0 };
  }
  await withTransaction(async (exec, conn) => {
    // delete-then-insert is atomic in this transaction. On sign we only reach here when the set was empty
    // (nothing curated is lost); on amend (replace) the codes are deliberately re-derived from the
    // corrected content so the downloaded record and FHIR stay in sync with the amended diagnoses.
    await exec('DELETE FROM encounter_note_codes WHERE note_id = :id', { id: noteId });
    await conn.query(
      `INSERT INTO encounter_note_codes (note_id, kind, code_system, code, description, snomed_code, snomed_term, modifiers, units, is_primary, seq)
       VALUES ?`, [rows]);
  });
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

export async function createNote({ encounterUuid, providerId, noteType, reason, content, createdBy, pos }) {
  const encId = await getOwnedEncounterId(encounterUuid, providerId);
  if (!encId) return null;
  const uuid = uuidv4();
  // Place of Service: explicit `pos` when provided, else seeded from the note type (SNF→31, office→11, …).
  const posCode = (pos != null && String(pos).replace(/\D/g, '')) ? String(pos).replace(/\D/g, '').slice(0, 4) : posForNoteType(noteType);
  await execute(
    `INSERT INTO encounter_notes (uuid, encounter_id, provider_id, note_type, pos_code, reason, content_enc, status, created_by)
     VALUES (:uuid, :e, :pid, :type, :pos, :reason, :content, 'draft', :createdBy)`,
    { uuid, e: encId, pid: providerId, type: noteType, pos: posCode, reason: reason || null,
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
  // Persist the coding-engine prediction as the note's structured billing codes (only if none exist), so
  // the downloaded PDF/DOCX and FHIR carry exactly the codes shown under the Billing heading. Best-effort
  // and BEFORE doc generation (which reads these rows); a failure here never un-signs the note.
  try { await persistPredictedCodes(r.id, finalContent, r.note_type); }
  catch (e) { logger.error({ err: e.message, noteId: r.id }, 'sign-time billing-code persistence failed (note IS signed; codes can be regenerated)'); }
  // Document generation is BEST-EFFORT: the note is already committed as signed, so a transient failure
  // here (e.g. a DB hiccup in the metadata/code fetch, or S3) must NOT 500 the sign request or skip the
  // caller's sign audit. Log loudly; the doc can be regenerated (amend re-runs this, and it is idempotent).
  try { await generateSignedDoc(r.id, signed, signerName); }
  catch (e) { logger.error({ err: e.message, noteId: r.id }, 'signed-note document generation failed (note IS signed; will regenerate)'); }
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
  // Re-derive the billing codes from the AMENDED content (replace), so the downloaded record and FHIR
  // reflect the corrected diagnoses — not the codes captured at the original signature. Best-effort.
  try { await persistPredictedCodes(r.id, finalContent, r.note_type, { replace: true }); }
  catch (e) { logger.error({ err: e.message, noteId: r.id }, 'amend-time billing-code refresh failed (amend IS saved; codes can be regenerated)'); }
  // Best-effort (see signNote): the amendment is already committed; a doc-gen failure must not 500 the
  // request or skip the amend audit.
  try { await generateSignedDoc(r.id, amended, signerName); }
  catch (e) { logger.error({ err: e.message, noteId: r.id }, 'amended-note document generation failed (amend IS saved; will regenerate)'); }
  return amended;
}
