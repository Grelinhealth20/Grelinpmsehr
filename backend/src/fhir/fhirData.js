/**
 * FHIR data layer — pulls REAL EHR rows and decrypts them for the mappers. Every query is scoped to the
 * CALLING provider's own patients (provider_id = caller), so the FHIR API inherits the same access
 * control as the rest of the app — no cross-provider exposure. (A patient-facing SMART-on-FHIR app would
 * layer OAuth 2.0 patient-scoped tokens on top; this foundation is provider-session scoped.)
 *
 * Records whose PHI cannot be decrypted are LOGGED and SKIPPED — never fabricated or blank-substituted.
 */
import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';
import { logger } from '../config/logger.js';

function decJson(buf) { try { return buf ? JSON.parse(decrypt(buf)) : null; } catch { return undefined; } }

const PT_SELECT = `SELECT p.id, p.uuid, p.mrn, p.demographics_enc, p.created_at, p.updated_at
  FROM patients p`;

/** All of the caller's patients, decrypted (unreadable demographics → skipped). */
export async function fhirPatients(providerId) {
  const [rows] = await execute(`${PT_SELECT} WHERE p.provider_id = :pid ORDER BY p.created_at DESC`, { pid: providerId });
  const out = [];
  for (const r of rows) {
    const demographics = decJson(r.demographics_enc);
    if (demographics === undefined) { logger.warn({ patient: r.uuid }, 'FHIR: skipping patient with undecryptable demographics'); continue; }
    out.push({ ...r, demographics: demographics || {} });
  }
  return out;
}

/** One patient by uuid, owned by the caller. */
export async function fhirPatientById(providerId, uuid) {
  const [rows] = await execute(`${PT_SELECT} WHERE p.uuid = :u AND p.provider_id = :pid LIMIT 1`, { u: uuid, pid: providerId });
  if (!rows[0]) return null;
  const demographics = decJson(rows[0].demographics_enc);
  if (demographics === undefined) return null;
  return { ...rows[0], demographics: demographics || {} };
}

/** Resolve the set of patient ids the caller owns (for scoping sub-resources). */
async function ownedPatientIds(providerId) {
  const [rows] = await execute('SELECT id FROM patients WHERE provider_id = :pid', { pid: providerId });
  return rows.map((r) => r.id);
}

/** Practitioners (provider directory — name/NPI, not PHI). Read by uuid or list active providers. */
export async function fhirPractitioners({ uuid = null } = {}) {
  const where = uuid ? 'WHERE u.uuid = :u' : "WHERE u.role = 'provider' AND u.status = 'active'";
  const [rows] = await execute(
    `SELECT u.uuid, u.full_name_enc, u.npi, u.taxonomy, u.taxonomy_code, u.credentials, u.role, u.status, u.updated_at
       FROM users u ${where} ORDER BY u.id LIMIT 500`,
    uuid ? { u: uuid } : {},
  );
  return rows.map((r) => ({ ...r, full_name: (() => { try { return r.full_name_enc ? decrypt(r.full_name_enc) : ''; } catch { return ''; } })() }));
}

const ENC_SELECT = `SELECT e.uuid, e.chart_status, e.created_at, e.updated_at,
    p.uuid AS patient_uuid, u.uuid AS provider_uuid
  FROM encounters e
  JOIN patients p ON p.id = e.patient_id
  LEFT JOIN users u ON u.id = e.provider_id`;

/** Encounters for the caller's patients (optionally one patient). */
export async function fhirEncounters(providerId, { patientUuid = null, uuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `${ENC_SELECT} WHERE p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (uuid) { sql += ' AND e.uuid = :eu'; params.eu = uuid; }
  sql += ' ORDER BY e.created_at DESC LIMIT 500';
  const [rows] = await execute(sql, params);
  return rows;
}

/** Encounter-diagnosis Conditions for the caller's patients. */
export async function fhirConditions(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `SELECT c.code, c.description, c.snomed_code, c.snomed_term, c.seq,
        n.uuid AS note_uuid, n.created_at,
        e.uuid AS encounter_uuid, p.uuid AS patient_uuid
      FROM encounter_note_codes c
      JOIN encounter_notes n ON n.id = c.note_id
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
     WHERE c.kind = 'dx' AND p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (encounterUuid) { sql += ' AND e.uuid = :eu'; params.eu = encounterUuid; }
  sql += ' ORDER BY n.created_at DESC, c.seq LIMIT 1000';
  const [rows] = await execute(sql, params);
  return rows;
}

const NOTE_CONTENT_SELECT = `SELECT n.uuid AS note_uuid, n.content_enc, n.status, n.signed_at, n.created_at,
    e.uuid AS encounter_uuid, p.uuid AS patient_uuid, u.uuid AS provider_uuid
  FROM encounter_notes n
  JOIN encounters e ON e.id = n.encounter_id
  JOIN patients p ON p.id = e.patient_id
  LEFT JOIN users u ON u.id = n.provider_id`;

/** MedicationRequests derived from each note's structured prescription list. */
export async function fhirMedications(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `${NOTE_CONTENT_SELECT} WHERE p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (encounterUuid) { sql += ' AND e.uuid = :eu'; params.eu = encounterUuid; }
  sql += ' ORDER BY n.created_at DESC LIMIT 500';
  const [rows] = await execute(sql, params);
  const out = [];
  for (const n of rows) {
    const content = decJson(n.content_enc);
    if (content === undefined) { logger.warn({ note: n.note_uuid }, 'FHIR: skipping note with undecryptable content (meds)'); continue; }
    const rx = Array.isArray(content?.prescriptions) ? content.prescriptions : [];
    rx.forEach((m, idx) => {
      if (!m || (!m.drug && !m.rxcui)) return;
      out.push({
        note_uuid: n.note_uuid, idx, patient_uuid: n.patient_uuid, encounter_uuid: n.encounter_uuid,
        provider_uuid: n.provider_uuid, authored_on: n.signed_at || n.created_at, signed: n.status === 'signed',
        drug: m.drug, dose: m.dose, route: m.route, frequency: m.frequency, sig: m.sig, rxcui: m.rxcui,
      });
    });
  }
  return out;
}

/** AllergyIntolerances derived from each note's documented allergies (free text → one entry per line). */
export async function fhirAllergies(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `${NOTE_CONTENT_SELECT} WHERE p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (encounterUuid) { sql += ' AND e.uuid = :eu'; params.eu = encounterUuid; }
  sql += ' ORDER BY n.created_at DESC LIMIT 500';
  const [rows] = await execute(sql, params);
  const NONE = /^(nkda|no known (drug )?allergies|none|n\/a|denies)/i;
  const seen = new Set();
  const out = [];
  for (const n of rows) {
    const content = decJson(n.content_enc);
    if (content === undefined) { logger.warn({ note: n.note_uuid }, 'FHIR: skipping note with undecryptable content (allergies)'); continue; }
    const raw = content?.sections?.allergies;
    if (!raw || typeof raw !== 'string') continue;
    // One AllergyIntolerance per distinct documented line (skip "NKDA"/"none" placeholders).
    const lines = raw.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean).filter((s) => !NONE.test(s));
    lines.forEach((text, idx) => {
      const key = `${n.patient_uuid}|${text.toLowerCase()}`;
      if (seen.has(key)) return; seen.add(key);
      out.push({ note_uuid: n.note_uuid, idx, patient_uuid: n.patient_uuid, text: text.slice(0, 300), recorded_date: n.created_at });
    });
  }
  return out;
}

/** Vital-sign Observations expanded from each note's captured `content.vitals` object. */
export async function fhirObservations(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `${NOTE_CONTENT_SELECT} WHERE p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (encounterUuid) { sql += ' AND e.uuid = :eu'; params.eu = encounterUuid; }
  sql += ' ORDER BY n.created_at DESC LIMIT 500';
  const [rows] = await execute(sql, params);
  const { VITAL_KEYS } = await import('./mappers.js');
  const out = [];
  for (const n of rows) {
    const content = decJson(n.content_enc);
    if (content === undefined) { logger.warn({ note: n.note_uuid }, 'FHIR: skipping note with undecryptable content (vitals)'); continue; }
    const vitals = content?.vitals;
    if (!vitals || typeof vitals !== 'object') continue;
    for (const key of VITAL_KEYS) {
      const value = vitals[key];
      if (value == null || String(value).trim() === '') continue;
      out.push({ key, value, note_uuid: n.note_uuid, patient_uuid: n.patient_uuid, encounter_uuid: n.encounter_uuid, effective: n.signed_at || n.created_at });
    }
  }
  return out;
}

/** Procedures (CPT) for the caller's patients. */
export async function fhirProcedures(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `SELECT c.code, c.description, c.seq, n.uuid AS note_uuid, n.created_at,
        e.uuid AS encounter_uuid, p.uuid AS patient_uuid
      FROM encounter_note_codes c
      JOIN encounter_notes n ON n.id = c.note_id
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
     WHERE c.kind = 'proc' AND p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (encounterUuid) { sql += ' AND e.uuid = :eu'; params.eu = encounterUuid; }
  sql += ' ORDER BY n.created_at DESC, c.seq LIMIT 1000';
  const [rows] = await execute(sql, params);
  return rows;
}

/** DocumentReferences for the caller's patients — signed clinical notes + stored patient documents. */
export async function fhirDocumentReferences(providerId, { patientUuid = null } = {}) {
  const params = { pid: providerId };
  // (a) clinical notes
  let noteSql = `SELECT n.uuid, n.note_type, n.status, n.signed_at, n.created_at,
        e.uuid AS encounter_uuid, p.uuid AS patient_uuid, u.uuid AS author_uuid
      FROM encounter_notes n
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
      LEFT JOIN users u ON u.id = n.provider_id
     WHERE p.provider_id = :pid`;
  if (patientUuid) { noteSql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  noteSql += ' ORDER BY n.created_at DESC LIMIT 500';
  const [notes] = await execute(noteSql, params);
  const out = notes.map((n) => ({
    kind: 'note', uuid: n.uuid, doc_type: 'clinical_note', title: `${n.note_type} note`, content_type: 'text/plain',
    patient_uuid: n.patient_uuid, encounter_uuid: n.encounter_uuid, author_uuid: n.author_uuid,
    signed: n.status === 'signed', created_at: n.signed_at || n.created_at,
  }));
  // (b) stored documents (license / insurance images)
  const dparams = { pid: providerId };
  let docSql = `SELECT d.uuid, d.doc_type, d.file_name_enc, d.content_type, d.size_bytes, d.created_at, p.uuid AS patient_uuid, u.uuid AS author_uuid
      FROM patient_documents d JOIN patients p ON p.id = d.patient_id LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE p.provider_id = :pid`;
  if (patientUuid) { docSql += ' AND p.uuid = :pu'; dparams.pu = patientUuid; }
  docSql += ' ORDER BY d.created_at DESC LIMIT 500';
  const [docs] = await execute(docSql, dparams);
  for (const d of docs) {
    let title = d.doc_type;
    try { if (d.file_name_enc) title = decrypt(d.file_name_enc); } catch { /* keep doc_type */ }
    out.push({ kind: 'doc', uuid: d.uuid, doc_type: d.doc_type, title, content_type: d.content_type, size_bytes: d.size_bytes, patient_uuid: d.patient_uuid, author_uuid: d.author_uuid, created_at: d.created_at });
  }
  return out;
}

/** Provenance for the caller's patients — one per SIGNED note (attestation record). */
export async function fhirProvenance(providerId, { patientUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `SELECT n.uuid AS note_uuid, n.signed_at, n.signed_by_name, su.uuid AS signer_uuid, p.uuid AS patient_uuid
      FROM encounter_notes n
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
      LEFT JOIN users su ON su.id = n.signed_by
     WHERE n.status = 'signed' AND p.provider_id = :pid`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  sql += ' ORDER BY n.signed_at DESC LIMIT 500';
  const [rows] = await execute(sql, params);
  return rows;
}

export { ownedPatientIds };
