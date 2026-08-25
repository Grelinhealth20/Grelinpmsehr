import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';
import { s3Enabled, getObjectBytes } from './s3Service.js';
import { toPublicPatient } from './patientService.js';
import { getNote, canSign } from './encounterNoteService.js';
import { listChecks } from './eligibilityService.js';
import { buildNotePdf, buildFaceSheetPdf, buildBenefitsPdf } from './pdfService.js';

/**
 * Gathers the data for each downloadable document, resolves the facility brand
 * (logo + address) once, and returns a finished PDF buffer + filename. Fast:
 * pdfkit generation is in-memory and the facility logo is cached briefly so repeat
 * downloads never re-hit S3.
 */

const safeParse = (buf) => { try { return JSON.parse(decrypt(buf)); } catch { return null; } };
const slug = (s) => String(s || 'patient').trim().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'patient';

// Brief in-memory cache of facility logo bytes, keyed by the S3 object key.
const LOGO_TTL_MS = 5 * 60 * 1000;
const logoCache = new Map();
async function loadLogo(key) {
  if (!key || !s3Enabled()) return null;
  const hit = logoCache.get(key);
  if (hit && Date.now() - hit.ts < LOGO_TTL_MS) return hit.buf;
  try { const buf = await getObjectBytes(key); logoCache.set(key, { buf, ts: Date.now() }); return buf; }
  catch { return null; }
}

/**
 * The RENDERING PROVIDER'S assigned facility brand (name, address, NPI, phone) + its
 * logo bytes — the same facility identity eligibility uses. Falls back to the
 * patient's linked billing facility if the provider has no active assignment.
 */
async function facilityBrand(patientId) {
  const COLS = 'f.name, f.npi, f.phone, f.address, f.city, f.state, f.zip, f.logo';
  let [rows] = await execute(
    `SELECT ${COLS}
       FROM patients p
       JOIN provider_facilities pf ON pf.provider_id = p.provider_id
       JOIN facilities f ON f.id = pf.facility_id AND f.status = 'active'
      WHERE p.id = :id
      ORDER BY f.name ASC LIMIT 1`,
    { id: patientId },
  );
  if (!rows[0]) {
    [rows] = await execute(
      `SELECT ${COLS} FROM patients p JOIN facilities f ON f.id = p.facility_id WHERE p.id = :id LIMIT 1`,
      { id: patientId },
    );
  }
  const f = rows[0];
  if (!f) return { facility: {}, logoBuffer: null };
  const logoBuffer = await loadLogo(f.logo);
  return {
    facility: { name: f.name, npi: f.npi, phone: f.phone, address: f.address, city: f.city, state: f.state, zip: f.zip },
    logoBuffer,
  };
}

/**
 * Clinical note → medical-record PDF.
 *  - Access is scoped via getNote (own note, or a facility-wide MD's facility note),
 *    so a provider can never download another facility's/patient's record.
 *  - Only SIGNED records may be downloaded; an unsigned (draft) record is downloadable
 *    ONLY by an MD.
 */
export async function notePdf(noteUuid, providerId) {
  const note = await getNote(noteUuid, providerId);
  if (!note) return { notFound: true };
  if (note.status !== 'signed') {
    const [urows] = await execute('SELECT credentials FROM users WHERE id = :id LIMIT 1', { id: providerId });
    if (!canSign(urows[0]?.credentials)) return { forbidden: true };
  }
  const [meta] = await execute(
    `SELECT p.id AS patient_id, p.mrn, p.demographics_enc, e.encounter_no,
        DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos
      FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id
      LEFT JOIN appointments a ON a.id = e.appointment_id
      LEFT JOIN patients p ON p.id = e.patient_id
      WHERE n.uuid = :u LIMIT 1`,
    { u: noteUuid },
  );
  const m = meta[0] || {};
  const demo = m.demographics_enc ? (safeParse(m.demographics_enc) || {}) : {};
  const patient = {
    name: `${demo.firstName || ''} ${demo.lastName || ''}`.trim() || 'Patient',
    mrn: m.mrn, dob: demo.dob, encounterNo: m.encounter_no, encounterDate: m.dos,
  };
  const brand = m.patient_id ? await facilityBrand(m.patient_id) : { facility: {}, logoBuffer: null };
  const buffer = await buildNotePdf({ ...brand, patient, note, signerName: note.signedByName, signedAt: note.signedAt });
  return { buffer, filename: `medical-record-${slug(patient.name)}-${(m.dos || '').replace(/-/g, '') || 'record'}.pdf` };
}

/** Patient Face Sheet PDF. `row` is the access-checked patient row. */
export async function faceSheetPdf(row) {
  const patient = toPublicPatient(row);
  const brand = await facilityBrand(row.id);
  const name = `${patient.demographics?.firstName || ''} ${patient.demographics?.lastName || ''}`.trim() || 'patient';
  const buffer = await buildFaceSheetPdf({ ...brand, patient });
  return { buffer, filename: `face-sheet-${slug(name)}.pdf` };
}

/** Benefits / eligibility PDF for a policy. `row` is the access-checked patient row. */
export async function benefitsPdf(row, policyIndex = 0) {
  const checks = await listChecks(row.id);
  const check = checks.find((c) => c.policyIndex === Number(policyIndex)) || checks[0];
  if (!check || !check.summary) return null;
  const patient = toPublicPatient(row);
  const brand = await facilityBrand(row.id);
  const name = `${patient.demographics?.firstName || ''} ${patient.demographics?.lastName || ''}`.trim() || 'patient';
  const buffer = await buildBenefitsPdf({ ...brand, patient: { name }, summary: check.summary, verifiedAt: check.verifiedAt });
  return { buffer, filename: `benefits-${slug(name)}.pdf` };
}
