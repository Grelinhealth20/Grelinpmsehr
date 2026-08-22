import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';

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
const accountNumber = (mrn) => (mrn ? `A${mrn.replace(/^GRH/, '')}` : null);

const CHART_FROM_APPT = { completed: 'charts_completed', cancelled: 'cancelled', scheduled: 'not_seen' };

const LIST = `SELECT
    a.uuid AS appt_uuid, a.patient_uuid, a.status AS appt_status,
    DATE_FORMAT(a.appt_date, '%Y-%m-%d') AS appt_date, a.start_min, a.duration_min,
    a.patient_name_enc,
    p.id AS patient_id, p.mrn, p.demographics_enc, p.facility_enc,
    u.full_name_enc AS provider_name_enc,
    e.uuid AS enc_uuid, e.eligibility_status, e.chart_status
  FROM appointments a
  LEFT JOIN patients p ON p.uuid = a.patient_uuid AND p.provider_id = a.provider_id
  LEFT JOIN users u ON u.id = a.provider_id
  LEFT JOIN encounters e ON e.appointment_id = a.id
  WHERE a.provider_id = :pid
  ORDER BY a.appt_date DESC, a.start_min DESC`;

export async function listEncounters(providerId) {
  const [rows] = await execute(LIST, { pid: providerId });
  return rows.map((r) => {
    const demo = jsonFromEnc(r.demographics_enc);
    const fac = jsonFromEnc(r.facility_enc);
    const linkedName = demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : '';
    return {
      appointmentUuid: r.appt_uuid,
      patientUuid: r.patient_uuid || null,
      accountNumber: accountNumber(r.mrn),
      mrn: r.mrn || null,
      date: r.appt_date,
      startMin: r.start_min,
      durationMin: r.duration_min,
      patientName: linkedName || (r.patient_name_enc ? decrypt(r.patient_name_enc) : '') || null,
      facilityName: fac?.facilityName || null,
      renderingProvider: r.provider_name_enc ? decrypt(r.provider_name_enc) : null,
      eligibilityStatus: r.eligibility_status || 'not_verified',
      chartStatus: r.chart_status || CHART_FROM_APPT[r.appt_status] || 'not_seen',
      appointmentStatus: r.appt_status,
    };
  });
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
