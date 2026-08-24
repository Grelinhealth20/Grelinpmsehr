import {
  listAppointments,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getRawByUuid,
} from '../services/appointmentService.js';
import { getRawByUuid as getPatientRawByUuid } from '../services/patientService.js';
import { findProviderIdByUuid } from '../services/userService.js';
import { ensureEncounter } from '../services/encounterService.js';
import { schedulingScope } from '../services/accessScope.js';
import { isProviderInUserFacilities, isPatientInUserFacilities } from '../services/facilityService.js';
import { recordAudit } from '../services/auditService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * May the caller manage this appointment? The rendering provider whose schedule
 * it is (provider_id), the front-desk user who booked it (created_by), OR a
 * facility-wide MD/billing user whose facility the linked patient belongs to.
 */
async function assertCanManage(req, row) {
  if (!row) { const e = new Error('Appointment not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const uid = Number(req.authUserId);
  if (Number(row.provider_id) === uid || Number(row.created_by) === uid) return;
  const scope = await schedulingScope(req.authUserId);
  if (scope.facilityWide && row.patient_uuid && (await isPatientInUserFacilities(row.patient_uuid, req.authUserId))) return;
  const e = new Error('You do not have access to this appointment.'); e.status = 403; e.code = 'FORBIDDEN'; throw e;
}

/**
 * A linked patient must be schedulable by the caller: their own patient (provider),
 * or a patient at the caller's facility (facility-wide MD / front-desk billing).
 */
async function assertSchedulablePatient(req, patientUuid) {
  if (!patientUuid) return;
  const p = await getPatientRawByUuid(patientUuid);
  if (p && Number(p.provider_id) === Number(req.authUserId)) return;
  const scope = await schedulingScope(req.authUserId);
  if (p && scope.facilityWide && (await isPatientInUserFacilities(patientUuid, req.authUserId))) return;
  const e = new Error('Linked patient not found.'); e.status = 400; e.code = 'BAD_PATIENT_LINK'; throw e;
}

/** Resolve a selected rendering-provider uuid to an internal id (active providers only). */
async function resolveRenderingProvider(uuid) {
  if (!uuid) return null;
  const id = await findProviderIdByUuid(uuid);
  if (!id) { const e = new Error('Selected provider not found.'); e.status = 400; e.code = 'BAD_PROVIDER'; throw e; }
  return id;
}

export async function list(req, res, next) {
  try {
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;
    const appointments = await listAppointments({ providerId: req.authUserId, from, to });
    res.json({ appointments });
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const { title, patient, patientUuid, renderingProviderUuid, type, date, startMin, durationMin } = req.body;
    const scope = await schedulingScope(req.authUserId);
    const renderingProviderId = await resolveRenderingProvider(renderingProviderUuid);

    // Determine whose schedule this appointment lands on (the owner). A front-desk
    // billing user MUST pick a rendering provider WITHIN their facility.
    let ownerId = req.authUserId;
    if (scope.isBilling) {
      if (!renderingProviderUuid) {
        const e = new Error('Select a rendering provider to schedule this appointment.'); e.status = 400; e.code = 'PROVIDER_REQUIRED'; throw e;
      }
      const provId = await isProviderInUserFacilities(renderingProviderUuid, req.authUserId);
      if (!provId) {
        const e = new Error('The selected rendering provider is not assigned to your facility.'); e.status = 403; e.code = 'PROVIDER_OUT_OF_FACILITY'; throw e;
      }
      ownerId = provId; // the appointment belongs to that provider's facility schedule
    }

    await assertSchedulablePatient(req, patientUuid);
    const appt = await createAppointment({
      providerId: ownerId,
      renderingProviderId: renderingProviderId || (scope.isBilling ? ownerId : null),
      title,
      patient: patient || '',
      patientUuid: patientUuid || null,
      type,
      date,
      startMin,
      durationMin,
      createdBy: req.authUserId,
    });
    // Auto-create a numbered encounter (wired to MRN + DOS) for patient bookings —
    // on the rendering provider's schedule.
    if (patientUuid) {
      const p = await getPatientRawByUuid(patientUuid);
      const apptRaw = await getRawByUuid(appt.uuid);
      if (p && apptRaw) {
        await ensureEncounter({
          appointmentId: apptRaw.id, patientId: p.id, providerId: ownerId,
          apptDate: appt.date, mrn: p.mrn, createdBy: req.authUserId,
        });
      }
    }
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'appointment.create',
      entityType: 'appointment',
      entityId: appt.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { type, date },
    });
    res.status(201).json({ appointment: appt });
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const row = await getRawByUuid(req.params.uuid);
    await assertCanManage(req, row);
    if (req.body.patientUuid) await assertSchedulablePatient(req, req.body.patientUuid);

    const b = { ...req.body };
    if (b.renderingProviderUuid !== undefined) {
      b.renderingProviderId = await resolveRenderingProvider(b.renderingProviderUuid);
      delete b.renderingProviderUuid;
    }
    // Choose the most meaningful audit action for the change.
    let action = 'appointment.update';
    if (b.status === 'cancelled') action = 'appointment.cancel';
    else if (b.status === 'completed') action = 'appointment.complete';
    else if (b.status === 'checked_in') action = 'appointment.check_in';
    else if (b.status === 'checked_out') action = 'appointment.check_out';
    else if ((b.date !== undefined || b.startMin !== undefined) && b.title === undefined) action = 'appointment.reschedule';

    const appt = await updateAppointment(req.params.uuid, b);
    await recordAudit({
      actorUserId: req.authUserId,
      action,
      entityType: 'appointment',
      entityId: appt.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { fields: Object.keys(b) },
    });
    res.json({ appointment: appt });
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const row = await getRawByUuid(req.params.uuid);
    await assertCanManage(req, row);
    await deleteAppointment(req.params.uuid);
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'appointment.delete',
      entityType: 'appointment',
      entityId: req.params.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
}
