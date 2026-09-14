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
  // Bound the fetch (every other FHIR query is capped) so a provider with a very large panel can't load
  // an unbounded result set into memory. 5000 comfortably covers real panels; page beyond it if ever needed.
  const [rows] = await execute(`${PT_SELECT} WHERE p.provider_id = :pid ORDER BY p.created_at DESC LIMIT 5000`, { pid: providerId });
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

/** Practitioners (provider directory — name/NPI, not PHI). Read by uuid or list active providers.
 *  A by-id read is restricted to the SAME set as the list — active PROVIDERS only — so the FHIR
 *  Practitioner directory can never disclose billing / super-admin / disabled user accounts. */
export async function fhirPractitioners({ uuid = null } = {}) {
  const where = uuid
    ? "WHERE u.uuid = :u AND u.role = 'provider' AND u.status = 'active'"
    : "WHERE u.role = 'provider' AND u.status = 'active'";
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

/** Encounter-diagnosis Conditions for the caller's patients. SIGNED notes only: a draft note's codes are
 *  non-final engine predictions (persisted by the real-time PUT /codes path, then REPLACED at sign) — the
 *  FHIR coded-data export must reflect the attested legal record, the same signed basis as Provenance.
 *  Exporting draft codes would assert them as verificationStatus=confirmed with no Provenance to attribute. */
export async function fhirConditions(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `SELECT c.code, c.description, c.snomed_code, c.snomed_term, c.seq,
        n.uuid AS note_uuid, n.created_at,
        e.uuid AS encounter_uuid, p.uuid AS patient_uuid
      FROM encounter_note_codes c
      JOIN encounter_notes n ON n.id = c.note_id
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
     WHERE c.kind = 'dx' AND n.status = 'signed' AND p.provider_id = :pid`;
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

/** Procedures (CPT) for the caller's patients. SIGNED notes only: a draft note's codes are non-final engine
 *  predictions (persisted by the real-time PUT /codes path, then REPLACED at sign) — exporting them would
 *  assert an unsigned procedure as status=completed with no Provenance. Mirror the attested legal record. */
export async function fhirProcedures(providerId, { patientUuid = null, encounterUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `SELECT c.code, c.description, c.seq, n.uuid AS note_uuid, n.created_at,
        e.uuid AS encounter_uuid, p.uuid AS patient_uuid
      FROM encounter_note_codes c
      JOIN encounter_notes n ON n.id = c.note_id
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
     WHERE c.kind = 'proc' AND n.status = 'signed' AND p.provider_id = :pid`;
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

/* ============================ Claim / ClaimResponse (coded billing data) ============================ */
import { medicareAllowedForLines } from '../services/reportsService.js';
import { scrubClaim } from '../services/snomedctservices.js';
import { posInfoLabel } from '../services/reportsService.js';

/** Decrypt patients.insurance_enc → real policy objects. `undecryptable` distinguishes a corrupt/rotated
 *  ciphertext (skip + log, never blank-substitute) from a patient who simply has no coverage on file. */
export function normalizeInsurance(insuranceEnc) {
  const raw = decJson(insuranceEnc);
  if (raw === undefined) return { policies: [], undecryptable: true };
  if (raw === null) return { policies: [], undecryptable: false };
  const arr = Array.isArray(raw) ? raw : [raw];
  return { policies: arr.filter((x) => x && typeof x === 'object'), undecryptable: false };
}
const payerOf = (pol) => { const v = pol && (pol.payer || pol.payerName); return v ? String(v).trim() || null : null; };
/** Index of the primary policy (explicit primary flag / order 1, else the first); -1 when none. */
function primaryPolicyIndex(policies) {
  if (!policies.length) return -1;
  const i = policies.findIndex((x) => x && (x.primary || x.isPrimary || Number(x.order) === 1 || Number(x.rank) === 1));
  return i >= 0 ? i : 0;
}

/** FHIR Coverage resources ← the caller's patients' REAL on-file insurance policies (decrypted). One
 *  Coverage per policy. Undecryptable insurance is skipped+logged; a patient with no coverage yields none —
 *  never a fabricated policy. */
export async function fhirCoverage(providerId, { patientUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = 'SELECT p.uuid AS patient_uuid, p.insurance_enc, p.created_at FROM patients p WHERE p.provider_id = :pid AND p.insurance_enc IS NOT NULL';
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  sql += ' ORDER BY p.created_at DESC LIMIT 5000';
  const [rows] = await execute(sql, params);
  const out = [];
  for (const r of rows) {
    const { policies, undecryptable } = normalizeInsurance(r.insurance_enc);
    if (undecryptable) { logger.warn({ patient: r.patient_uuid }, 'FHIR: skipping patient with undecryptable insurance'); continue; }
    policies.forEach((pol, seq) => {
      const payer = payerOf(pol);
      const plan = pol.plan || pol.planName || null;
      // Nothing real to represent (empty policy slot) → skip; do not emit a hollow Coverage.
      if (!payer && !plan && !pol.memberId && !pol.mbi) return;
      out.push({
        patient_uuid: r.patient_uuid, seq,
        payer, payerId: pol.payerId || null, memberId: pol.memberId || null, mbi: pol.mbi || null,
        group: pol.group || pol.groupNumber || null, plan,
        relationship: pol.relationship || null,
        order: Number(pol.order) || Number(pol.rank) || (seq === 0 ? 1 : seq + 1),
        status: pol.status || null,
      });
    });
  }
  return out;
}

/** SIGNED notes (with ≥1 procedure code) for the caller's patients, plus each note's dx + proc code rows.
 *  Signed-only, exactly like the coded-data export and Provenance: a Claim/ClaimResponse is built only from
 *  the attested legal record, never a draft's non-final engine predictions. */
async function claimNotes(providerId, { patientUuid = null, encounterUuid = null, noteUuid = null } = {}) {
  const params = { pid: providerId };
  let sql = `SELECT n.id AS note_id, n.uuid AS note_uuid, n.pos_code, n.note_type, n.signed_at, n.created_at,
        e.uuid AS encounter_uuid, p.uuid AS patient_uuid, p.insurance_enc,
        u.uuid AS provider_uuid, u.credentials AS provider_credentials
      FROM encounter_notes n
      JOIN encounters e ON e.id = n.encounter_id
      JOIN patients p ON p.id = e.patient_id
      LEFT JOIN users u ON u.id = n.provider_id
     WHERE n.status = 'signed' AND p.provider_id = :pid
       AND EXISTS (SELECT 1 FROM encounter_note_codes c WHERE c.note_id = n.id AND c.kind = 'proc')`;
  if (patientUuid) { sql += ' AND p.uuid = :pu'; params.pu = patientUuid; }
  if (encounterUuid) { sql += ' AND e.uuid = :eu'; params.eu = encounterUuid; }
  if (noteUuid) { sql += ' AND n.uuid = :nu'; params.nu = noteUuid; }
  sql += ' ORDER BY n.signed_at DESC, n.id DESC LIMIT 500';
  const [notes] = await execute(sql, params);
  if (!notes.length) return [];
  const ids = notes.map((n) => n.note_id);
  const inList = ids.map((_, i) => `:n${i}`).join(',');
  const cp = {}; ids.forEach((id, i) => { cp[`n${i}`] = id; });
  const [codes] = await execute(
    `SELECT note_id, kind, code, description, snomed_code, snomed_term, modifiers, units, is_primary, seq
       FROM encounter_note_codes WHERE note_id IN (${inList}) ORDER BY note_id, kind, is_primary DESC, seq`, cp);
  const byNote = new Map();
  for (const c of codes) {
    if (!byNote.has(c.note_id)) byNote.set(c.note_id, { dx: [], proc: [] });
    byNote.get(c.note_id)[c.kind === 'dx' ? 'dx' : 'proc'].push(c);
  }
  return notes.map((n) => {
    const { policies } = normalizeInsurance(n.insurance_enc);
    const pi = primaryPolicyIndex(policies);
    const payer = pi >= 0 ? payerOf(policies[pi]) : null;
    // Reference the patient's real primary Coverage resource when a policy is on file (ties Claim↔Coverage).
    const coverageRef = pi >= 0 ? `${n.patient_uuid}-coverage-${pi}` : null;
    return { ...n, payer, coverageRef, codes: byNote.get(n.note_id) || { dx: [], proc: [] } };
  });
}

function parseCreds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } }
  return [];
}

/** Per-note priced claim objects (real coded data + real MPFS pricing) — the single source shared by the
 *  Claim and ExplanationOfBenefit exports so they can never diverge on lines, diagnoses, POS, or amounts. */
async function pricedNotes(providerId, opts) {
  const notes = await claimNotes(providerId, opts);
  const out = [];
  for (const n of notes) {
    const credentials = parseCreds(n.provider_credentials);
    const procRows = n.codes.proc;
    const priced = await medicareAllowedForLines(
      procRows.map((c) => ({ code: c.code, units: c.units || 1, posCode: n.pos_code, noteType: n.note_type, modifiers: c.modifiers })),
      { credentials });
    const items = procRows.map((c, i) => ({
      code: c.code, description: c.description, modifiers: c.modifiers, units: c.units || 1,
      posCode: n.pos_code || null, posLabel: posInfoLabel(n.pos_code, n.note_type),
      allowedAmount: priced[i] ? priced[i].allowedAmount : null, priced: priced[i] ? priced[i].priced : false,
    }));
    out.push({
      note_uuid: n.note_uuid, patient_uuid: n.patient_uuid, provider_uuid: n.provider_uuid,
      encounter_uuid: n.encounter_uuid, created: n.signed_at || n.created_at, payer: n.payer, coverageRef: n.coverageRef,
      diagnoses: n.codes.dx, items,
    });
  }
  return out;
}

/** FHIR professional Claims (one per signed, procedure-bearing note) — real coded data + real MPFS pricing. */
export async function fhirClaims(providerId, { patientUuid = null, encounterUuid = null, noteUuid = null } = {}) {
  return pricedNotes(providerId, { patientUuid, encounterUuid, noteUuid });
}

/** FHIR ClaimResponses (pre-submission predetermination) — the REAL scrubClaim result per signed note. */
export async function fhirClaimResponses(providerId, { patientUuid = null, encounterUuid = null, noteUuid = null } = {}) {
  const notes = await claimNotes(providerId, { patientUuid, encounterUuid, noteUuid });
  const out = [];
  for (const n of notes) {
    const lines = n.codes.proc.map((c) => ({ cpt: c.code, modifiers: c.modifiers, units: c.units || 1 }));
    const diagnoses = n.codes.dx.map((c) => c.code).filter(Boolean);
    const scrub = await scrubClaim({ lines, diagnoses, jurisdiction: 'FL' }); // real CMS-table scrub, Part B
    out.push({
      note_uuid: n.note_uuid, patient_uuid: n.patient_uuid, provider_uuid: n.provider_uuid,
      created: n.signed_at || n.created_at, findings: scrub.findings, summary: scrub.summary,
    });
  }
  return out;
}

/** FHIR ExplanationOfBenefit (pre-adjudication estimate) — the shared priced claim + the REAL scrub outcome.
 *  Same signed-only, provider-scoped basis; the only money is the CMS MPFS allowed amount (no payer payment). */
export async function fhirEobs(providerId, { patientUuid = null, encounterUuid = null, noteUuid = null } = {}) {
  const priced = await pricedNotes(providerId, { patientUuid, encounterUuid, noteUuid });
  const out = [];
  for (const p of priced) {
    const lines = p.items.map((it) => ({ cpt: it.code, modifiers: it.modifiers, units: it.units }));
    const diagnoses = p.diagnoses.map((d) => d.code).filter(Boolean);
    const scrub = await scrubClaim({ lines, diagnoses, jurisdiction: 'FL' });
    out.push({ ...p, scrub: { findings: scrub.findings, summary: scrub.summary } });
  }
  return out;
}

export { ownedPatientIds };
