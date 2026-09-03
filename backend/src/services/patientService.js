import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { execute, withTransaction } from '../db/pool.js';
import { encrypt, decrypt, blindIndex } from '../utils/crypto.js';
import { providerFacilityIds } from './facilityService.js';

/**
 * Patient records for the EHR face sheet. ALL demographics and insurance data is
 * PHI and is stored ENCRYPTED (AES-256-GCM) as JSON blobs. Records are owned by
 * a provider; the controllers enforce that no provider can read another's
 * patients (no cross-patient / cross-provider access).
 */

function safeParse(buf) {
  try { return JSON.parse(decrypt(buf)); } catch { return null; }
}

export function toPublicPatient(row) {
  if (!row) return null;
  const demographics = safeParse(row.demographics_enc) || {};
  // Insurance may be a single object (legacy) or an array — normalize to an array.
  const insRaw = row.insurance_enc ? safeParse(row.insurance_enc) : null;
  const insurance = Array.isArray(insRaw) ? insRaw : insRaw ? [insRaw] : [];
  const facility = row.facility_enc ? safeParse(row.facility_enc) : null;
  // Emergency contact may be a single object (legacy) or an array — normalize.
  const emgRaw = row.emergency_enc ? safeParse(row.emergency_enc) : null;
  const emergencyContacts = Array.isArray(emgRaw) ? emgRaw : emgRaw ? [emgRaw] : [];
  return {
    uuid: row.uuid,
    mrn: row.mrn,
    demographics,
    insurance,
    facility,
    emergencyContacts,
    emergencyContact: emergencyContacts[0] || null, // back-compat for any old callers
    documentCount: row.document_count ?? undefined,
    // Per-facility feature switches (default ON when the patient has no linked facility).
    codingEnabled: row.coding_enabled == null ? true : !!Number(row.coding_enabled),
    eligibilityEnabled: row.eligibility_enabled == null ? true : !!Number(row.eligibility_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT p.id, p.uuid, p.provider_id, p.mrn, p.demographics_enc, p.insurance_enc, p.facility_enc, p.emergency_enc,
  p.created_at, p.updated_at, fac.coding_enabled, fac.eligibility_enabled,
  (SELECT COUNT(*) FROM patient_documents d WHERE d.patient_id = p.id) AS document_count
  FROM patients p LEFT JOIN facilities fac ON fac.id = p.facility_id`;

export async function listPatients(providerId) {
  const [rows] = await execute(`${SELECT} WHERE p.provider_id = :pid ORDER BY p.created_at DESC`, { pid: providerId });
  return rows.map(toPublicPatient);
}

export async function getRawByUuid(uuid) {
  const [rows] = await execute(`${SELECT} WHERE p.uuid = :uuid LIMIT 1`, { uuid });
  return rows[0] || null;
}

/**
 * Resolve a patient's S3 storage context: the uuids of the patient, their owning
 * provider, and their (billing) facility. Drives the hierarchical S3 key space
 * facilities/{facility}/providers/{provider}/patients/{patient}/.
 */
export async function getPatientS3Ctx(uuid) {
  const [rows] = await execute(
    `SELECT p.uuid AS patient_uuid, p.demographics_enc,
        u.uuid AS provider_uuid, u.full_name_enc AS provider_name_enc,
        f.uuid AS facility_uuid, f.name AS facility_name
       FROM patients p
       LEFT JOIN users u ON u.id = p.provider_id
       LEFT JOIN facilities f ON f.id = p.facility_id
      WHERE p.uuid = :uuid LIMIT 1`,
    { uuid },
  );
  const r = rows[0];
  if (!r) return null;
  // Resolve the REAL names so the S3 folders are facility → provider → patient by
  // name (with a unique id suffix). Names are decrypted server-side in memory only.
  const demo = safeParse(r.demographics_enc) || {};
  const patientName = `${demo.firstName || ''} ${demo.lastName || ''}`.trim();
  let providerName = '';
  try { providerName = r.provider_name_enc ? decrypt(r.provider_name_enc) : ''; } catch { providerName = ''; }
  return {
    patientUuid: r.patient_uuid, patientName,
    providerUuid: r.provider_uuid, providerName,
    facilityUuid: r.facility_uuid, facilityName: r.facility_name || '',
  };
}

// Luhn (mod-10) check digit for a numeric string — the same transcription-error-detecting
// scheme CMS uses for the NPI. Catches every single-digit error and most adjacent
// transpositions, so a mistyped MRN is far more likely to be rejected than to hit another
// patient's chart.
export function luhnCheckDigit(digits) {
  let sum = 0; let dbl = true;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}
export function isValidMrn(mrn) {
  const s = String(mrn || '');
  if (!/^\d{8}$/.test(s)) return false;
  return luhnCheckDigit(s.slice(0, 7)) === s[7];
}

// MRN format: 8-digit numeric = 7 random base digits + 1 Luhn check digit. Unique and
// never reused. (MRN is a LOCAL identifier — no CMS/SNOMED format governs it; the check
// digit is the real medical-records-grade integrity control, mirroring the NPI scheme.)
async function generateMrn() {
  for (let i = 0; i < 40; i += 1) {
    const base = String(crypto.randomInt(1_000_000, 9_999_999)); // 7 digits, no leading zero
    const mrn = base + luhnCheckDigit(base);
    const [rows] = await execute(`SELECT id FROM patients WHERE mrn = :mrn LIMIT 1`, { mrn });
    if (rows.length === 0) return mrn;
  }
  throw new Error('Could not allocate a unique MRN.');
}

const hasItems = (v) => (Array.isArray(v) ? v.length > 0 : !!v);

// Accept either an array of contacts (new) or a single object (legacy) → store as given.
const emgValue = (emergencyContacts, emergencyContact) => {
  if (emergencyContacts !== undefined) return hasItems(emergencyContacts) ? encrypt(JSON.stringify(emergencyContacts)) : null;
  if (emergencyContact !== undefined) return emergencyContact ? encrypt(JSON.stringify(emergencyContact)) : null;
  return undefined;
};

/**
 * Prefix search tokens for a patient's name — the enabler for flexible, still-encrypted
 * search (by last name, first name, first initial, or any prefix) WITHOUT ever storing the
 * plaintext name. For each name word we emit the blind index (keyed HMAC — irreversible
 * without the server key) of every prefix (length 1..12). A query word matches a patient iff
 * its blind index equals one of these, i.e. a name STARTS WITH the typed text. Compound names
 * (spaces/hyphens) are split so each part is independently searchable. The names themselves
 * stay AES-GCM encrypted in `demographics_enc`; this table holds only opaque hashes.
 */
const MAX_PREFIX = 12;
function namePrefixStrings(demographics) {
  const set = new Set();
  for (const field of [demographics?.firstName, demographics?.middleName, demographics?.lastName]) {
    for (const part of String(field || '').toLowerCase().split(/[\s\-]+/)) {
      const w = part.replace(/[^a-z0-9]/g, '');
      if (!w) continue;
      for (let n = 1; n <= Math.min(w.length, MAX_PREFIX); n++) set.add(w.slice(0, n));
    }
  }
  return [...set];
}
export function nameSearchTokens(demographics) {
  return namePrefixStrings(demographics).map((t) => blindIndex(t));
}

/** Replace a patient's name-search tokens (delete + bulk insert). Idempotent. */
export async function syncPatientNameTokens(patientId, demographics) {
  const tokens = nameSearchTokens(demographics);
  await execute('DELETE FROM patient_name_tokens WHERE patient_id = :pid', { pid: patientId });
  if (!tokens.length) return;
  const params = { pid: patientId };
  const values = tokens.map((t, i) => { params[`t${i}`] = t; return `(:pid, :t${i})`; }).join(', ');
  await execute(`INSERT IGNORE INTO patient_name_tokens (patient_id, token_bidx) VALUES ${values}`, params);
}

/** Backfill helper (migration): decrypt the stored demographics blob, then re-index tokens. */
export async function syncPatientNameTokensFromEnc(patientId, demographicsEnc) {
  const demo = safeParse(demographicsEnc);
  if (demo) await syncPatientNameTokens(patientId, demo);
}

export async function createPatient({ providerId, demographics, insurance, facility, emergencyContact, emergencyContacts, createdBy }) {
  const uuid = uuidv4();
  const mrn = await generateMrn();
  const nameKey = `${demographics.lastName || ''} ${demographics.firstName || ''}`.trim().toLowerCase();
  const emg = emgValue(emergencyContacts, emergencyContact);
  // Billing facility is derived automatically (background) from the rendering
  // provider's assigned facility — never entered on the UI. This links the
  // patient to a facility for billing and cross-facility isolation.
  const facIds = await providerFacilityIds(providerId);
  const facilityId = facIds.length ? facIds[0] : null;
  const [ins] = await execute(
    `INSERT INTO patients (uuid, provider_id, facility_id, mrn, name_bidx, demographics_enc, insurance_enc, facility_enc, emergency_enc, created_by)
     VALUES (:uuid, :pid, :facilityId, :mrn, :nameBidx, :demoEnc, :insEnc, :facEnc, :emgEnc, :createdBy)`,
    {
      uuid,
      pid: providerId,
      facilityId,
      mrn,
      nameBidx: nameKey ? blindIndex(nameKey) : null,
      demoEnc: encrypt(JSON.stringify(demographics)),
      insEnc: hasItems(insurance) ? encrypt(JSON.stringify(insurance)) : null,
      facEnc: facility ? encrypt(JSON.stringify(facility)) : null,
      emgEnc: emg ?? null,
      createdBy,
    },
  );
  // Index the name for prefix search (last name / first name / initial / partial).
  if (ins?.insertId) await syncPatientNameTokens(ins.insertId, demographics);
  return toPublicPatient(await getRawByUuid(uuid));
}

/** Encode a partial patient patch into SQL SET fragments + bound params. */
function buildPatientSets({ demographics, insurance, facility, emergencyContact, emergencyContacts }) {
  const sets = [];
  const params = {};
  if (demographics !== undefined) {
    sets.push('demographics_enc = :demoEnc', 'name_bidx = :nameBidx');
    params.demoEnc = encrypt(JSON.stringify(demographics));
    const nameKey = `${demographics.lastName || ''} ${demographics.firstName || ''}`.trim().toLowerCase();
    params.nameBidx = nameKey ? blindIndex(nameKey) : null;
  }
  if (insurance !== undefined) {
    sets.push('insurance_enc = :insEnc');
    params.insEnc = hasItems(insurance) ? encrypt(JSON.stringify(insurance)) : null;
  }
  if (facility !== undefined) {
    sets.push('facility_enc = :facEnc');
    params.facEnc = facility ? encrypt(JSON.stringify(facility)) : null;
  }
  const emg = emgValue(emergencyContacts, emergencyContact);
  if (emg !== undefined) {
    sets.push('emergency_enc = :emgEnc');
    params.emgEnc = emg;
  }
  return { sets, params };
}

export async function updatePatient(uuid, fields) {
  const { sets, params } = buildPatientSets(fields);
  if (sets.length) await execute(`UPDATE patients SET ${sets.join(', ')} WHERE uuid = :uuid`, { ...params, uuid });
  const raw = await getRawByUuid(uuid);
  // Re-index name tokens whenever demographics changed (name may have been edited).
  if (fields.demographics !== undefined && raw?.id) await syncPatientNameTokens(raw.id, fields.demographics);
  return toPublicPatient(raw);
}

/**
 * Serialized read-modify-write for the eligibility merge. Locks the patient row
 * (SELECT … FOR UPDATE), rebuilds the patch from the FRESHEST data via `mergeFn`,
 * applies it, and commits — so a background/async verify can never clobber a
 * concurrent user edit with a stale in-memory snapshot (lost-update fix).
 */
export async function applyPatientUpdateLocked(uuid, mergeFn) {
  return withTransaction(async (exec) => {
    const [rows] = await exec('SELECT * FROM patients WHERE uuid = :uuid FOR UPDATE', { uuid });
    if (!rows[0]) return null;
    // Read-modify-write guard: NEVER merge onto a silently-blanked snapshot. demographics_enc is
    // NOT NULL, so if it fails to decrypt the row is corrupt — abort loudly rather than risk
    // overwriting real PHI (name/insurance) with an empty merge. (A null column is impossible here.)
    if (rows[0].demographics_enc) {
      try { JSON.parse(decrypt(rows[0].demographics_enc)); }
      catch { const e = new Error('Patient record could not be decrypted — update aborted to protect the record.'); e.status = 422; e.code = 'PATIENT_UNREADABLE'; throw e; }
    }
    const patch = mergeFn(toPublicPatient(rows[0])) || {};
    const { sets, params } = buildPatientSets(patch);
    if (sets.length) await exec(`UPDATE patients SET ${sets.join(', ')} WHERE uuid = :uuid`, { ...params, uuid });
    // Keep name-search tokens consistent in-transaction if the name changed in the merge.
    if (patch.demographics !== undefined) {
      const tokens = nameSearchTokens(patch.demographics);
      await exec('DELETE FROM patient_name_tokens WHERE patient_id = :pid', { pid: rows[0].id });
      if (tokens.length) {
        const p = { pid: rows[0].id };
        const vals = tokens.map((t, i) => { p[`t${i}`] = t; return `(:pid, :t${i})`; }).join(', ');
        await exec(`INSERT IGNORE INTO patient_name_tokens (patient_id, token_bidx) VALUES ${vals}`, p);
      }
    }
    const [after] = await exec(`${SELECT} WHERE p.uuid = :uuid LIMIT 1`, { uuid });
    return toPublicPatient(after[0]);
  });
}

export async function deletePatient(uuid) {
  // Remove the patient's clinical footprint first: encounters (which cascade to
  // their notes) — so deletion never leaves orphaned encounters/notes behind.
  const [pr] = await execute(`SELECT id FROM patients WHERE uuid = :u LIMIT 1`, { u: uuid });
  const pid = pr[0]?.id;
  if (pid) await execute(`DELETE FROM encounters WHERE patient_id = :pid`, { pid });
  const [res] = await execute(`DELETE FROM patients WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
}
