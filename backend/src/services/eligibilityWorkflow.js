import { stediEnabled, searchPayer, checkEligibility, stediLog } from './stediService.js';
import { resolvePayer, resolveMedicarePartB, isMedicarePartB, normalizeState } from './payerDirectoryService.js';
import { saveCheck, mergeVerificationIntoPatient, hasCheckThisMonth, listChecks } from './eligibilityService.js';
import { providerPrimaryFacility } from './facilityService.js';
import { stcsForProcedures } from './procedureStc.js';
import { updatePatient, getRawByUuid as getPatientRawByUuid, toPublicPatient } from './patientService.js';
import { logger } from '../config/logger.js';

/**
 * End-to-end, SERVER-SIDE eligibility verification for a patient. Every input is
 * pulled from the Face Sheet — nothing is entered for the check by hand:
 *
 *   - subscriber : demographics (name, DOB) + primary insurance (member ID)
 *   - payer      : the entered payer is resolved to the canonical Stedi payer
 *                  (name + tradingPartnerServiceId) via the Payer Network
 *   - provider   : the rendering provider's ASSIGNED FACILITY NPI + name
 *   - encounter  : service type is ALWAYS "30" (Health Benefit Plan Coverage);
 *                  date of service is the date the patient was added to the system
 *
 * On success the raw 271 is saved (encrypted) and the confirmed identity (address,
 * group #, MBI, canonical payer, plan, cost-shares) is written back to the Face
 * Sheet + insurance. De-duplicated to at most one verification per patient+policy
 * per calendar month. No mock/fallback — if Stedi is unconfigured or the payer
 * can't be resolved, it returns a `skipped` reason and writes nothing.
 */

function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  const s = String(v).slice(0, 10).replace(/-/g, '');
  return /^\d{8}$/.test(s) ? s : '';
}

/**
 * @returns {Promise<{check,patient,payer}|{skipped:string}>}
 */
export async function verifyPatientEligibility({ patient, patientId, providerId, policyIndex = 0, force = false, procedureCodes = [], dosOverride = null, appointmentUuid = null, writeBack = true }) {
  if (!stediEnabled()) return { skipped: 'stedi_disabled' };

  const ins = (patient?.insurance || [])[policyIndex];
  if (!ins) return { skipped: 'no_insurance' };
  // Member ID for the 271: the MBI (Original Medicare) takes precedence; the plan
  // member ID is used ONLY when no MBI is on file.
  const mbi = String(ins.mbi || '').trim();
  const memberId = mbi || String(ins.memberId || '').trim();
  if (!memberId) return { skipped: 'no_member_id' };

  const demo = patient.demographics || {};
  const dob = ymd(demo.dob);
  if (!dob) return { skipped: 'no_dob' };
  if (!demo.firstName || !demo.lastName) return { skipped: 'no_name' };

  if (!force && await hasCheckThisMonth(patientId, policyIndex)) return { skipped: 'duplicate_this_month' };

  // 1. Provider identity = the rendering provider's ASSIGNED FACILITY (NPI + state).
  const fac = await providerPrimaryFacility(providerId);
  if (!fac || !fac.npi) return { skipped: 'no_facility_npi' };

  // 2. Resolve the payer. An MBI on file (or a Medicare-Part-B payer name) routes to
  //    the STATE-SPECIFIC Medicare Part B MAC using the ASSIGNED FACILITY'S STATE
  //    (real-time). The STEDI payer ID — not the primary payer ID — is the
  //    tradingPartnerServiceId. Non-Medicare payers resolve from the directory (DB)
  //    first, then the live payer-search API.
  const medicarePartB = !!mbi || isMedicarePartB(ins.payer);
  let payer;
  if (medicarePartB) {
    if (!normalizeState(fac.state)) return { skipped: 'no_facility_state' };
    payer = await resolveMedicarePartB(fac.state);
  } else {
    if (!ins.payer) return { skipped: 'no_payer' };
    payer = await resolvePayer(ins.payer, { state: fac.state });
    if (!payer) payer = await searchPayer(ins.payer);
  }
  if (!payer || !payer.stediId) return { skipped: 'payer_unresolved' };

  // 3a. Procedure-specific targeting: map billed CPT/HCPCS -> the Service Type
  //     Code its benefits live under, and request THAT STC alongside base "30".
  //     (Stedi/payers, except CMS HETS, won't accept a procedure code + STC in the
  //     same request, so we target by STC — the reliable, payer-agnostic path.)
  const proc = stcsForProcedures(procedureCodes);
  const serviceTypeCodes = [...new Set(['30', ...proc.stcs])];

  // 3b. Build the request entirely from the Face Sheet.
  const request = {
    provider: { npi: fac.npi, organizationName: fac.name || undefined },
    subscriber: {
      firstName: demo.firstName,
      lastName: demo.lastName,
      dateOfBirth: dob,
      memberId, // MBI when present, else the plan member ID
      ...(demo.address ? { address: { address1: demo.address, city: demo.city || undefined } } : {}),
    },
    encounter: {
      serviceTypeCodes,                    // "30" + any procedure-derived STCs
      // DOS: appointment date when verifying an appointment, else the patient's add date.
      dateOfService: dosOverride || ymd(patient.createdAt) || ymd(new Date()),
    },
    tradingPartnerServiceId: payer.stediId, // Stedi payer ID (routing key)
    externalPatientId: memberId || patient.uuid,
  };

  stediLog('eligibility.request', { patient: patient.uuid, stediId: payer.stediId, facilityNpi: fac.npi, serviceTypeCodes, appointment: appointmentUuid || undefined });

  // 4. Real-time 271 (no mock). Errors propagate to the caller.
  const response = await checkEligibility(request);

  // 5. Persist (encrypted). Appointment checks are stored against the appointment
  //    (service_date = appointment DOS) and never overwrite the Face Sheet.
  const context = proc.resolved.length ? { requestedProcedures: proc.resolved, requestedStcs: serviceTypeCodes, unmappedProcedures: proc.unmapped } : { requestedStcs: serviceTypeCodes };
  const check = await saveCheck({ patientId, policyIndex, response, createdBy: providerId, context, appointmentUuid, serviceDate: dosOverride || null });
  let updated = patient;
  if (writeBack) {
    // Store the STEDI payer ID (not the primary payer ID) on the policy.
    const patch = mergeVerificationIntoPatient(patient, check.summary, policyIndex, { canonicalPayer: payer.name, payerId: payer.stediId });
    updated = await updatePatient(patient.uuid, patch);
  }

  stediLog('eligibility.saved', { patient: patient.uuid, status: check.status, appointment: appointmentUuid || undefined });
  return { check, patient: updated, payer };
}

/**
 * Verify eligibility for an APPOINTMENT: same inputs as the Face Sheet, but the
 * DOS is the appointment date, the provider identity is the appointment's
 * rendering provider's assigned facility, and any selected procedure drives STC
 * targeting. The result is stored against the appointment (never overwrites the
 * patient) so the schedule can tag it and show basic benefits. Non-fatal.
 */
export async function verifyAppointmentEligibility(apptRow) {
  try {
    if (!stediEnabled()) return { skipped: 'stedi_disabled' };
    if (!apptRow?.patient_uuid) return { skipped: 'no_patient' };
    const prow = await getPatientRawByUuid(apptRow.patient_uuid);
    if (!prow) return { skipped: 'no_patient' };
    const providerId = apptRow.rendering_provider_id || apptRow.provider_id;
    const dos = String(apptRow.appt_date || '').replace(/-/g, ''); // YYYY-MM-DD -> YYYYMMDD
    const r = await verifyPatientEligibility({
      patient: toPublicPatient(prow),
      patientId: prow.id,
      providerId,
      policyIndex: 0,
      procedureCodes: apptRow.procedure_code ? [apptRow.procedure_code] : [],
      dosOverride: /^\d{8}$/.test(dos) ? dos : null,
      appointmentUuid: apptRow.uuid,
      force: true,        // appointment checks are per-appointment, not monthly-deduped
      writeBack: false,   // never mutate the Face Sheet from an appointment check
    });
    if (r.skipped) logger.info({ appointment: apptRow.uuid, reason: r.skipped }, 'appointment eligibility skipped');
    return r;
  } catch (err) {
    logger.warn({ appointment: apptRow?.uuid, err: err.message, code: err.code }, 'appointment eligibility failed');
    return { skipped: 'error', error: err.message };
  }
}

/** The existing latest check for a policy (used when a re-verify is a monthly dupe). */
export async function latestCheckForPolicy(patientId, policyIndex = 0) {
  const all = await listChecks(patientId);
  return all.find((c) => c.policyIndex === policyIndex) || null;
}

/** Best-effort auto-verify used on patient creation; never throws into the caller. */
export async function autoVerifyOnCreate({ patient, patientId, providerId }) {
  try {
    const r = await verifyPatientEligibility({ patient, patientId, providerId, policyIndex: 0 });
    if (r.skipped) logger.info({ patient: patient.uuid, reason: r.skipped }, 'auto eligibility skipped');
    return r;
  } catch (err) {
    logger.warn({ patient: patient.uuid, err: err.message, code: err.code }, 'auto eligibility failed');
    return { skipped: 'error', error: err.message };
  }
}
