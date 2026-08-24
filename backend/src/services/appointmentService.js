import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { schedulingScope } from './accessScope.js';

/**
 * Appointment persistence for the EHR scheduler. Patient-identifying fields are
 * stored ENCRYPTED (AES-256-GCM) exactly like other PHI. Dates are returned as
 * plain 'YYYY-MM-DD' strings (no timezone drift) and times as minutes-from-
 * midnight so the grid renders deterministically.
 */

const SELECT = `SELECT a.id, a.uuid, a.provider_id, a.rendering_provider_id, a.created_by, a.title_enc, a.patient_name_enc, a.patient_uuid,
  a.appt_type, DATE_FORMAT(a.appt_date, '%Y-%m-%d') AS appt_date,
  a.start_min, a.duration_min, a.status, a.created_at, a.updated_at,
  rp.uuid AS rendering_provider_uuid, rp.full_name_enc AS rendering_provider_name_enc,
  op.full_name_enc AS owner_name_enc
  FROM appointments a
  LEFT JOIN users rp ON rp.id = a.rendering_provider_id
  LEFT JOIN users op ON op.id = a.provider_id`;

export function toPublicAppointment(row) {
  if (!row) return null;
  return {
    uuid: row.uuid,
    title: decrypt(row.title_enc),
    patient: row.patient_name_enc ? decrypt(row.patient_name_enc) : '',
    patientUuid: row.patient_uuid || null,
    renderingProviderUuid: row.rendering_provider_uuid || null,
    renderingProvider: row.rendering_provider_name_enc ? decrypt(row.rendering_provider_name_enc)
      : (row.owner_name_enc ? decrypt(row.owner_name_enc) : null),
    type: row.appt_type,
    date: row.appt_date,
    startMin: row.start_min,
    durationMin: row.duration_min,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The schedule for a viewer. Front-desk billing users and MDs see every
 * appointment for their assigned facilities (own book + any appointment whose
 * linked patient is at their facility); other providers see only their own book.
 * Strictly facility-bounded — no cross-facility leakage.
 */
export async function listAppointments({ providerId, from = null, to = null }) {
  const scope = await schedulingScope(providerId);
  const params = { pid: providerId };
  let scopeSql;
  if (scope.facilityWide) {
    const ph = scope.facilityIds.map((id, i) => { params[`sf${i}`] = id; return `:sf${i}`; }).join(',');
    scopeSql = `(a.provider_id = :pid OR a.created_by = :pid OR EXISTS (
        SELECT 1 FROM patients pp WHERE pp.uuid = a.patient_uuid AND pp.facility_id IN (${ph})))`;
  } else {
    scopeSql = 'a.provider_id = :pid';
  }
  const clauses = [scopeSql];
  if (from) { clauses.push('a.appt_date >= :from'); params.from = from; }
  if (to) { clauses.push('a.appt_date <= :to'); params.to = to; }
  const [rows] = await execute(
    `${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY a.appt_date ASC, a.start_min ASC`,
    params,
  );
  return rows.map(toPublicAppointment);
}

export async function getRawByUuid(uuid) {
  const [rows] = await execute(`${SELECT} WHERE a.uuid = :uuid LIMIT 1`, { uuid });
  return rows[0] || null;
}

export async function createAppointment({ providerId, renderingProviderId, title, patient, patientUuid, type, date, startMin, durationMin, createdBy }) {
  const uuid = uuidv4();
  await execute(
    `INSERT INTO appointments
       (uuid, provider_id, rendering_provider_id, title_enc, patient_name_enc, patient_uuid, appt_type, appt_date, start_min, duration_min, status, created_by)
     VALUES
       (:uuid, :pid, :rpid, :titleEnc, :patientEnc, :patientUuid, :type, :date, :startMin, :durationMin, 'scheduled', :createdBy)`,
    {
      uuid,
      pid: providerId,
      rpid: renderingProviderId || null,
      titleEnc: encrypt(title),
      patientEnc: patient ? encrypt(patient) : null,
      patientUuid: patientUuid || null,
      type,
      date,
      startMin,
      durationMin,
      createdBy,
    },
  );
  return toPublicAppointment(await getRawByUuid(uuid));
}

export async function updateAppointment(uuid, fields) {
  const sets = [];
  const params = { uuid };
  if (fields.title !== undefined) { sets.push('title_enc = :titleEnc'); params.titleEnc = encrypt(fields.title); }
  if (fields.patient !== undefined) { sets.push('patient_name_enc = :patientEnc'); params.patientEnc = fields.patient ? encrypt(fields.patient) : null; }
  if (fields.patientUuid !== undefined) { sets.push('patient_uuid = :patientUuid'); params.patientUuid = fields.patientUuid || null; }
  if (fields.renderingProviderId !== undefined) { sets.push('rendering_provider_id = :rpid'); params.rpid = fields.renderingProviderId || null; }
  if (fields.type !== undefined) { sets.push('appt_type = :type'); params.type = fields.type; }
  if (fields.date !== undefined) { sets.push('appt_date = :date'); params.date = fields.date; }
  if (fields.startMin !== undefined) { sets.push('start_min = :startMin'); params.startMin = fields.startMin; }
  if (fields.durationMin !== undefined) { sets.push('duration_min = :durationMin'); params.durationMin = fields.durationMin; }
  if (fields.status !== undefined) { sets.push('status = :status'); params.status = fields.status; }
  if (sets.length) {
    await execute(`UPDATE appointments SET ${sets.join(', ')} WHERE uuid = :uuid`, params);
  }
  return toPublicAppointment(await getRawByUuid(uuid));
}

export async function deleteAppointment(uuid) {
  const [res] = await execute(`DELETE FROM appointments WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
}
