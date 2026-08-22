import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt, blindIndex } from '../utils/crypto.js';

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT p.id, p.uuid, p.provider_id, p.mrn, p.demographics_enc, p.insurance_enc, p.facility_enc, p.emergency_enc,
  p.created_at, p.updated_at,
  (SELECT COUNT(*) FROM patient_documents d WHERE d.patient_id = p.id) AS document_count
  FROM patients p`;

export async function listPatients(providerId) {
  const [rows] = await execute(`${SELECT} WHERE p.provider_id = :pid ORDER BY p.created_at DESC`, { pid: providerId });
  return rows.map(toPublicPatient);
}

export async function getRawByUuid(uuid) {
  const [rows] = await execute(`${SELECT} WHERE p.uuid = :uuid LIMIT 1`, { uuid });
  return rows[0] || null;
}

async function generateMrn() {
  for (let i = 0; i < 6; i++) {
    const mrn = `GRH${crypto.randomInt(10_000_000, 99_999_999)}`;
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

export async function createPatient({ providerId, demographics, insurance, facility, emergencyContact, emergencyContacts, createdBy }) {
  const uuid = uuidv4();
  const mrn = await generateMrn();
  const nameKey = `${demographics.lastName || ''} ${demographics.firstName || ''}`.trim().toLowerCase();
  const emg = emgValue(emergencyContacts, emergencyContact);
  await execute(
    `INSERT INTO patients (uuid, provider_id, mrn, name_bidx, demographics_enc, insurance_enc, facility_enc, emergency_enc, created_by)
     VALUES (:uuid, :pid, :mrn, :nameBidx, :demoEnc, :insEnc, :facEnc, :emgEnc, :createdBy)`,
    {
      uuid,
      pid: providerId,
      mrn,
      nameBidx: nameKey ? blindIndex(nameKey) : null,
      demoEnc: encrypt(JSON.stringify(demographics)),
      insEnc: hasItems(insurance) ? encrypt(JSON.stringify(insurance)) : null,
      facEnc: facility ? encrypt(JSON.stringify(facility)) : null,
      emgEnc: emg ?? null,
      createdBy,
    },
  );
  return toPublicPatient(await getRawByUuid(uuid));
}

export async function updatePatient(uuid, { demographics, insurance, facility, emergencyContact, emergencyContacts }) {
  const sets = [];
  const params = { uuid };
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
  if (sets.length) await execute(`UPDATE patients SET ${sets.join(', ')} WHERE uuid = :uuid`, params);
  return toPublicPatient(await getRawByUuid(uuid));
}

export async function deletePatient(uuid) {
  const [res] = await execute(`DELETE FROM patients WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
}
