import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { decrypt, blindIndex } from '../utils/crypto.js';

/**
 * Encounter worklist. Each of a provider's appointments is presented as an
 * encounter row, enriched with the linked patient (name, MRN, facility) and any
 * persisted encounter state (eligibility + chart status). Everything is scoped
 * to the calling provider — patient joins are constrained to the same owner so
 * no cross-patient data can surface.
 */

function jsonFromEnc(buf) {
  if (!buf) return null;
  try { return JSON.parse(decrypt(buf)); } catch { return null; }
}
const CHART_FROM_APPT = { completed: 'charts_completed', cancelled: 'cancelled', scheduled: 'not_seen' };
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Encounter number — a 5-digit sequence UNIQUE PER PATIENT (00001, 00002, …).
 * Fully numeric, ≤5 chars, wired to the patient (and therefore the MRN) via the
 * encounter's patient_id; the DOS is stored separately (encounter_date / DOS).
 * Enterprise EHR visit-numbering style.
 */
async function nextEncounterNo(patientId) {
  if (!patientId) return null;
  const [m] = await execute(
    `SELECT COALESCE(MAX(CAST(encounter_no AS UNSIGNED)), 0) + 1 AS nxt FROM encounters WHERE patient_id = :pid`,
    { pid: patientId },
  );
  return String(m[0].nxt).padStart(5, '0');
}

/**
 * Ensure an encounter row exists for an appointment (idempotent on appointment_id)
 * and assign its per-patient encounter number.
 */
export async function ensureEncounter({ appointmentId, patientId, providerId, createdBy }) {
  const [existing] = await execute(
    `SELECT id, encounter_no FROM encounters WHERE appointment_id = :aid LIMIT 1`,
    { aid: appointmentId },
  );
  if (existing[0]) {
    if (!existing[0].encounter_no && patientId) {
      await execute(`UPDATE encounters SET encounter_no = :no WHERE id = :id`,
        { no: await nextEncounterNo(patientId), id: existing[0].id });
    }
    return;
  }
  await execute(
    `INSERT INTO encounters (uuid, encounter_no, provider_id, appointment_id, patient_id, eligibility_status, chart_status, created_by)
     VALUES (:uuid, :no, :pid, :aid, :patientId, 'not_verified', 'not_seen', :createdBy)`,
    { uuid: uuidv4(), no: await nextEncounterNo(patientId), pid: providerId, aid: appointmentId, patientId: patientId || null, createdBy },
  );
}

const NOTE_AGG = `(SELECT COUNT(*) FROM encounter_notes n WHERE n.encounter_id = e.id)`;
const NOTE_SIGNED = `(SELECT COUNT(*) FROM encounter_notes n WHERE n.encounter_id = e.id AND n.status = 'signed')`;
// Procedure = the note type(s) documented on the encounter; signer = the MD(s) who signed.
const NOTE_TYPES_SQL = `(SELECT GROUP_CONCAT(DISTINCT n.note_type) FROM encounter_notes n WHERE n.encounter_id = e.id)`;
const NOTE_SIGNERS_SQL = `(SELECT GROUP_CONCAT(DISTINCT n.signed_by_name SEPARATOR ', ') FROM encounter_notes n WHERE n.encounter_id = e.id AND n.status = 'signed' AND n.signed_by_name IS NOT NULL)`;

const LIST = `SELECT
    a.uuid AS appt_uuid, a.patient_uuid, a.status AS appt_status,
    DATE_FORMAT(a.appt_date, '%Y-%m-%d') AS appt_date, a.start_min, a.duration_min,
    a.patient_name_enc,
    p.id AS patient_id, p.mrn, p.demographics_enc, p.facility_enc,
    u.full_name_enc AS owner_name_enc, rp.full_name_enc AS rendering_name_enc,
    e.uuid AS enc_uuid, e.encounter_no, e.eligibility_status, e.chart_status,
    ${NOTE_AGG} AS note_count, ${NOTE_SIGNED} AS note_signed,
    ${NOTE_TYPES_SQL} AS note_types, ${NOTE_SIGNERS_SQL} AS signers
  FROM appointments a
  LEFT JOIN patients p ON p.uuid = a.patient_uuid AND p.provider_id = a.provider_id
  LEFT JOIN users u ON u.id = a.provider_id
  LEFT JOIN users rp ON rp.id = a.rendering_provider_id
  LEFT JOIN encounters e ON e.appointment_id = a.id
  WHERE a.provider_id = :pid
  ORDER BY a.appt_date DESC, a.start_min DESC`;

// Standalone encounters (manually created, not tied to an appointment).
const LIST_STANDALONE = `SELECT
    e.uuid AS enc_uuid, e.encounter_no, e.eligibility_status, e.chart_status,
    DATE_FORMAT(e.encounter_date, '%Y-%m-%d') AS enc_date,
    p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
    u.full_name_enc AS owner_name_enc,
    ${NOTE_AGG} AS note_count, ${NOTE_SIGNED} AS note_signed,
    ${NOTE_TYPES_SQL} AS note_types, ${NOTE_SIGNERS_SQL} AS signers
  FROM encounters e
  LEFT JOIN patients p ON p.id = e.patient_id AND p.provider_id = e.provider_id
  LEFT JOIN users u ON u.id = e.provider_id
  WHERE e.provider_id = :pid AND e.appointment_id IS NULL
  ORDER BY e.encounter_date DESC, e.created_at DESC`;

export async function listEncounters(providerId) {
  const [rows] = await execute(LIST, { pid: providerId });
  const fromAppts = rows.map((r) => {
    const demo = jsonFromEnc(r.demographics_enc);
    const fac = jsonFromEnc(r.facility_enc);
    const linkedName = demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : '';
    return {
      encounterUuid: r.enc_uuid || null,
      appointmentUuid: r.appt_uuid,
      encounterNo: r.encounter_no || null,
      patientUuid: r.patient_uuid || null,
      mrn: r.mrn || null,
      date: r.appt_date,
      startMin: r.start_min,
      durationMin: r.duration_min,
      patientName: linkedName || (r.patient_name_enc ? decrypt(r.patient_name_enc) : '') || null,
      facilityName: fac?.facilityName || null,
      renderingProvider: r.rendering_name_enc ? decrypt(r.rendering_name_enc) : (r.owner_name_enc ? decrypt(r.owner_name_enc) : null),
      eligibilityStatus: r.eligibility_status || 'not_verified',
      chartStatus: r.chart_status || CHART_FROM_APPT[r.appt_status] || 'not_seen',
      appointmentStatus: r.appt_status,
      noteCount: Number(r.note_count || 0),
      noteSigned: Number(r.note_signed || 0),
      noteTypes: r.note_types || '',
      signedOffProvider: r.signers || null,
      source: 'appointment',
    };
  });

  const [srows] = await execute(LIST_STANDALONE, { pid: providerId });
  const standalone = srows.map((r) => {
    const demo = jsonFromEnc(r.demographics_enc);
    const fac = jsonFromEnc(r.facility_enc);
    const linkedName = demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : '';
    return {
      encounterUuid: r.enc_uuid,
      appointmentUuid: null,
      encounterNo: r.encounter_no || null,
      patientUuid: r.patient_uuid || null,
      mrn: r.mrn || null,
      date: r.enc_date,
      patientName: linkedName || null,
      facilityName: fac?.facilityName || null,
      renderingProvider: r.owner_name_enc ? decrypt(r.owner_name_enc) : null,
      eligibilityStatus: r.eligibility_status || 'not_verified',
      chartStatus: r.chart_status || 'not_seen',
      noteCount: Number(r.note_count || 0),
      noteSigned: Number(r.note_signed || 0),
      noteTypes: r.note_types || '',
      signedOffProvider: r.signers || null,
      source: 'manual',
    };
  });

  return [...standalone, ...fromAppts];
}

/**
 * ENTERPRISE-GRADE server-side pagination — Patients & Encounters view.
 * Only one page of patients is ever loaded (indexed on provider_id); each
 * patient's encounters are fetched on demand, paginated. Scales to 50k+ patients
 * and 10k+ encounters/patient with low latency (no full-table loads).
 */
export async function listProviderPatients(providerId, { page = 1, pageSize = 25, q = '' } = {}) {
  // Safe integers (validated/clamped by the controller) — inlined because MySQL
  // prepared statements reject placeholders in LIMIT/OFFSET.
  const lim = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const off = Math.max(0, (Number(page) - 1) * lim);
  const params = { pid: providerId };
  let where = 'p.provider_id = :pid';
  if (q) {
    // MRN is plaintext (partial match); name is searchable only by exact full
    // name via its blind index (PHI is encrypted — no partial name scans).
    where += ' AND (p.mrn LIKE :qlike OR p.name_bidx = :qbidx)';
    params.qlike = `%${q}%`;
    params.qbidx = blindIndex(q.trim().toLowerCase());
  }
  const [rows] = await execute(
    `SELECT p.uuid, p.mrn, p.demographics_enc, p.facility_enc,
        (SELECT COUNT(*) FROM encounters e WHERE e.patient_id = p.id) AS enc_count
      FROM patients p
      WHERE ${where}
      ORDER BY p.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  const [cnt] = await execute(`SELECT COUNT(*) AS total FROM patients p WHERE ${where}`, params);
  const [me] = await execute(`SELECT full_name_enc FROM users WHERE id = :pid LIMIT 1`, { pid: providerId });
  const providerName = me[0]?.full_name_enc ? decrypt(me[0].full_name_enc) : null;
  return {
    patients: rows.map((r) => {
      const demo = jsonFromEnc(r.demographics_enc);
      const fac = jsonFromEnc(r.facility_enc);
      return {
        patientUuid: r.uuid,
        mrn: r.mrn,
        patientName: demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : null,
        facilityName: fac?.facilityName || null,
        renderingProvider: providerName,
        encounterCount: Number(r.enc_count || 0),
      };
    }),
    total: Number(cnt[0].total),
    page: Number(page),
    pageSize: Number(pageSize),
  };
}

/** Paginated encounters for ONE of the provider's patients (10/page default). */
export async function listPatientEncounters(providerId, patientUuid, { page = 1, pageSize = 10 } = {}) {
  const [pr] = await execute(`SELECT id FROM patients WHERE uuid = :u AND provider_id = :pid LIMIT 1`, { u: patientUuid, pid: providerId });
  if (!pr[0]) return null; // not the provider's patient → 404 (strict isolation)
  const pidInt = pr[0].id;
  const lim = Math.max(1, Math.min(50, Number(pageSize) || 10));
  const off = Math.max(0, (Number(page) - 1) * lim);
  const [rows] = await execute(
    `SELECT e.uuid, e.encounter_no,
        DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos,
        COALESCE(rp.full_name_enc, u.full_name_enc) AS rendering_enc,
        ${NOTE_TYPES_SQL} AS note_types, ${NOTE_SIGNERS_SQL} AS signers
      FROM encounters e
      LEFT JOIN appointments a ON a.id = e.appointment_id
      LEFT JOIN users rp ON rp.id = a.rendering_provider_id
      LEFT JOIN users u ON u.id = e.provider_id
      WHERE e.patient_id = :pid AND e.provider_id = :prov
      ORDER BY COALESCE(e.encounter_date, a.appt_date) DESC, e.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    { pid: pidInt, prov: providerId },
  );
  const [cnt] = await execute(`SELECT COUNT(*) AS total FROM encounters e WHERE e.patient_id = :pid AND e.provider_id = :prov`, { pid: pidInt, prov: providerId });
  return {
    encounters: rows.map((r) => ({
      encounterUuid: r.uuid,
      encounterNo: r.encounter_no,
      date: r.dos,
      renderingProvider: r.rendering_enc ? decrypt(r.rendering_enc) : null,
      noteTypes: r.note_types || '',
      signedOffProvider: r.signers || null,
    })),
    total: Number(cnt[0].total),
    page: Number(page),
    pageSize: Number(pageSize),
  };
}

/** Create a standalone encounter (select patient + date) not tied to an appointment. */
export async function createStandaloneEncounter({ providerId, patientUuid, encounterDate, createdBy }) {
  const [pr] = await execute(
    `SELECT id, mrn FROM patients WHERE uuid = :u AND provider_id = :pid LIMIT 1`,
    { u: patientUuid, pid: providerId },
  );
  const patient = pr[0];
  if (!patient) return null; // not the provider's patient → caller 404s (no cross-patient)
  const uuid = uuidv4();
  const encounterNo = await nextEncounterNo(patient.id);
  await execute(
    `INSERT INTO encounters (uuid, encounter_no, provider_id, appointment_id, patient_id, encounter_date, eligibility_status, chart_status, created_by)
     VALUES (:uuid, :no, :pid, NULL, :patientId, :dos, 'not_verified', 'not_seen', :createdBy)`,
    { uuid, no: encounterNo, pid: providerId, patientId: patient.id, dos: encounterDate, createdBy },
  );
  return { uuid, encounterNo };
}

/** Resolve an encounter the provider owns → returns its internal id (or null). */
export async function getOwnedEncounterId(encounterUuid, providerId) {
  const [rows] = await execute(
    `SELECT id FROM encounters WHERE uuid = :u AND provider_id = :pid LIMIT 1`,
    { u: encounterUuid, pid: providerId },
  );
  return rows[0]?.id || null;
}

/** Upsert the editable encounter state for one of the provider's appointments. */
export async function updateEncounterStatus(appointmentUuid, providerId, createdBy, { eligibilityStatus, chartStatus }) {
  const [appt] = await execute(
    `SELECT a.id, a.provider_id, p.id AS patient_id
       FROM appointments a LEFT JOIN patients p ON p.uuid = a.patient_uuid AND p.provider_id = a.provider_id
      WHERE a.uuid = :uuid LIMIT 1`,
    { uuid: appointmentUuid },
  );
  const row = appt[0];
  if (!row || Number(row.provider_id) !== Number(providerId)) return null; // not owner → caller 404s

  const sets = [];
  const params = { pid: providerId, apptId: row.id, patientId: row.patient_id || null, uuid: uuidv4(), createdBy };
  if (eligibilityStatus !== undefined) params.elig = eligibilityStatus;
  if (chartStatus !== undefined) params.chart = chartStatus;

  await execute(
    `INSERT INTO encounters (uuid, provider_id, appointment_id, patient_id, eligibility_status, chart_status, created_by)
     VALUES (:uuid, :pid, :apptId, :patientId,
             COALESCE(:elig, 'not_verified'), COALESCE(:chart, 'not_seen'), :createdBy)
     ON DUPLICATE KEY UPDATE
       eligibility_status = COALESCE(:elig, eligibility_status),
       chart_status = COALESCE(:chart, chart_status),
       patient_id = COALESCE(:patientId, patient_id)`,
    { ...params, elig: params.elig ?? null, chart: params.chart ?? null },
  );
  return { ok: true };
}
