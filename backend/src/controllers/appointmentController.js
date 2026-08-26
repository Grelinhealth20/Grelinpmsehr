import {
  listAppointments,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getRawByUuid,
  toPublicAppointment,
  findOverlap,
} from '../services/appointmentService.js';
import { getRawByUuid as getPatientRawByUuid } from '../services/patientService.js';
import { findProviderIdByUuid } from '../services/userService.js';
import { ensureEncounter } from '../services/encounterService.js';
import { verifyAppointmentEligibility } from '../services/eligibilityWorkflow.js';
import { getAppointmentCheck } from '../services/eligibilityService.js';
import { isEligibilityEnabled } from '../services/settingsService.js';
import { schedulingScope } from '../services/accessScope.js';
import { isProviderInUserFacilities, isPatientInUserFacilities } from '../services/facilityService.js';
import { recordAudit } from '../services/auditService.js';

const ELIG_SKIP_MSG = {
  stedi_disabled: 'Eligibility service is not configured.',
  no_patient: 'Link a patient (with insurance) to verify eligibility.',
  no_insurance: 'The linked patient has no insurance on file.',
  no_member_id: 'The linked patient has no member ID.',
  no_payer: 'The linked patient has no payer on file.',
  no_dob: 'The linked patient has no date of birth.',
  no_name: 'The linked patient has no name.',
  no_facility_npi: 'The rendering provider has no assigned facility NPI.',
  no_facility_state: 'Medicare Part B needs the assigned facility state — set it on the facility.',
  no_dos: 'A date of service is required to verify eligibility.',
  payer_unresolved: 'Could not match this payer in the payer directory.',
};

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

/**
 * Run appointment eligibility and AUDIT the outcome — user-level, per appointment.
 * Records what triggered it (create / reschedule / patient_change / manual), the
 * resulting coverage status (or the skip/error), the payer, and the actor. A no-op
 * "already_verified" (benefits already on file, no payer call) is not logged.
 * Returns the workflow result; re-throws real payer errors (after logging them).
 */
async function auditedEligibility(req, apptRow, { trigger, manual = false, opts = {} }) {
  const actorUserId = req.authUserId;
  const ip = req.ip;
  const userAgent = req.get('user-agent');
  const entityId = apptRow.uuid;
  const base = { actorUserId, action: 'appointment.eligibility.verify', entityType: 'appointment', entityId, ip, userAgent };
  // Feature-flag gate: when a super admin has disabled eligibility EHR-wide, no
  // payer call is made on any trigger (create / update / manual). Silent no-op for
  // the automatic paths; the manual endpoint returns an explicit 403 to the caller.
  if (!(await isEligibilityEnabled())) return { skipped: 'eligibility_disabled' };
  try {
    const r = await verifyAppointmentEligibility(apptRow, opts);
    // These outcomes make NO payer call (benefits reused / once-per-patient cap) — no
    // audit noise (nothing live was triggered).
    if (['already_verified', 'insurance_reused', 'insurance_auto_cap', 'auto_once_per_patient'].includes(r.skipped)) return r;
    if (r.check) await recordAudit({ ...base, metadata: { trigger, manual, status: r.check.status, payer: r.payer?.name } });
    else await recordAudit({ ...base, outcome: 'skipped', metadata: { trigger, manual, skipped: r.skipped } });
    return r;
  } catch (err) {
    await recordAudit({ ...base, outcome: 'error', metadata: { trigger, manual, error: err.message, code: err.code } });
    throw err;
  }
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
    const { title, patient, patientUuid, renderingProviderUuid, type, procedureCode, date, startMin, durationMin } = req.body;
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
    // No double-booking: reject an overlapping visit on this provider's schedule.
    if (await findOverlap({ providerId: ownerId, date, startMin, durationMin })) {
      const e = new Error('That time slot is already booked for this provider.'); e.status = 409; e.code = 'SLOT_TAKEN'; throw e;
    }
    const appt = await createAppointment({
      providerId: ownerId,
      renderingProviderId: renderingProviderId || (scope.isBilling ? ownerId : null),
      title,
      patient: patient || '',
      patientUuid: patientUuid || null,
      type,
      procedureCode: procedureCode || null,
      date,
      startMin,
      durationMin,
      createdBy: req.authUserId,
    });
    const apptRaw = await getRawByUuid(appt.uuid);
    // Auto-create a numbered encounter (wired to MRN + DOS) for patient bookings.
    if (patientUuid) {
      const p = await getPatientRawByUuid(patientUuid);
      if (p && apptRaw) {
        await ensureEncounter({
          appointmentId: apptRaw.id, patientId: p.id, providerId: ownerId,
          apptDate: appt.date, mrn: p.mrn, createdBy: req.authUserId,
        });
      }
      // NO automatic eligibility on booking — a live 271 is only ever triggered by a
      // MANUAL verify. Benefits are shown from saved data until then.
    }
    await recordAudit({
      actorUserId: req.authUserId, action: 'appointment.create', entityType: 'appointment', entityId: appt.uuid,
      ip: req.ip, userAgent: req.get('user-agent'), metadata: { type, date, procedureCode: procedureCode || undefined },
    });
    res.status(201).json({ appointment: appt }); // immediate — no eligibility wait
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

    // No double-booking when moving the visit (date/time/duration change).
    if (b.date !== undefined || b.startMin !== undefined || b.durationMin !== undefined) {
      const date = b.date ?? row.appt_date;
      const startMin = b.startMin ?? row.start_min;
      const durationMin = b.durationMin ?? row.duration_min;
      if (b.status !== 'cancelled' && await findOverlap({ providerId: row.provider_id, date, startMin, durationMin, excludeUuid: row.uuid })) {
        const e = new Error('That time slot is already booked for this provider.'); e.status = 409; e.code = 'SLOT_TAKEN'; throw e;
      }
    }
    const appt = await updateAppointment(req.params.uuid, b);
    // NO automatic eligibility on reschedule / patient / procedure change — a live 271
    // is only ever triggered by a MANUAL verify.
    await recordAudit({
      actorUserId: req.authUserId, action, entityType: 'appointment', entityId: appt.uuid,
      ip: req.ip, userAgent: req.get('user-agent'), metadata: { fields: Object.keys(b) },
    });
    res.json({ appointment: appt }); // immediate
  } catch (err) { next(err); }
}

/** Manually (re)run eligibility for an appointment. Every attempt is audited. */
export async function verifyEligibility(req, res, next) {
  try {
    const row = await getRawByUuid(req.params.uuid);
    await assertCanManage(req, row);
    if (!(await isEligibilityEnabled())) return res.status(403).json({ error: 'Eligibility verification is currently disabled by your administrator.', code: 'ELIGIBILITY_DISABLED' });
    // A manual click is a deliberate user action → force a fresh check (this is the
    // ONLY way a with-benefits appointment re-calls the payer; automatic paths never do).
    const r = await auditedEligibility(req, row, { trigger: 'manual', manual: true, opts: { force: true } });
    if (r.skipped === 'stedi_disabled') return res.status(503).json({ error: 'Eligibility service is not configured.', code: 'STEDI_DISABLED' });
    if (r.skipped) return res.status(422).json({ error: ELIG_SKIP_MSG[r.skipped] || 'Eligibility could not be verified.', code: `ELIG_${r.skipped.toUpperCase()}` });
    res.status(201).json({ appointment: toPublicAppointment(await getRawByUuid(req.params.uuid)), status: r.check?.status });
  } catch (err) {
    // Payer/clearinghouse error — already audited as outcome:'error' by the helper.
    if (err.code === 'STEDI_US_IP_REQUIRED') {
      return res.status(502).json({
        error: 'Medicare eligibility requires a U.S.-based server connection. This environment’s network location is outside the U.S., so the payer rejected the request. Commercial payers are unaffected — deploy the backend on a U.S. host to enable Medicare Part B checks.',
        code: err.code,
      });
    }
    if (err.code && String(err.code).startsWith('STEDI')) return res.status(502).json({ error: err.message, code: err.code });
    next(err);
  }
}

/** The appointment's latest eligibility check (for the benefits popup). */
export async function getEligibility(req, res, next) {
  try {
    const row = await getRawByUuid(req.params.uuid);
    await assertCanManage(req, row);
    res.json({ check: await getAppointmentCheck(row.uuid) });
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const row = await getRawByUuid(req.params.uuid);
    await assertCanManage(req, row);
    const reason = String(req.body?.reason || '').trim();
    await deleteAppointment(req.params.uuid); // also purges the appointment's eligibility checks
    await recordAudit({
      actorUserId: req.authUserId,
      action: 'appointment.delete',
      entityType: 'appointment',
      entityId: req.params.uuid,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      // Reason + non-PHI context (never the encrypted title/patient name).
      metadata: { reason, date: row.appt_date, patientLinked: !!row.patient_uuid },
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
}
