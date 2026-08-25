import { stediEnabled, checkEligibility, stediLog } from './stediService.js';
import { resolvePayer, resolveMedicarePartB, isMedicarePartB, normalizeState } from './payerDirectoryService.js';
import {
  saveCheck, mergeVerificationIntoPatient, listChecks, getAppointmentCheck,
  insuranceBidxOf, latestBenefitsForInsurance, autoApiCountForInsurance, cloneCheckToAppointment, toPublicCheck,
} from './eligibilityService.js';
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
  // IDENTIFIER PRECEDENCE for the 271:
  //   1) If an MBI is on file  → verify with the MBI (this is the first member ID used).
  //   2) ONLY when there is NO MBI → fall back to the primary policy's Member ID.
  const mbi = String(ins.mbi || '').trim();
  const memberId = mbi || String(ins.memberId || '').trim();
  if (!memberId) return { skipped: 'no_member_id' };

  const demo = patient.demographics || {};
  if (!demo.firstName || !demo.lastName) return { skipped: 'no_name' };
  const dob = ymd(demo.dob); // YYYYMMDD (subscriber.dateOfBirth)

  // Automatic-verification policy (bypassed by a manual `force`):
  //  • Reuse existing benefits for the SAME patient + SAME insurance — no payer call.
  //    (So a reschedule within the month with the same insurance never re-calls.)
  //  • Never make more than TWO automatic payer calls per insurance.
  //  • An insurance change (different payer / member / MBI) is a new identity → allowed.
  const insuranceBidx = insuranceBidxOf(ins.payer, memberId);
  if (!force) {
    const existing = await latestBenefitsForInsurance(patientId, insuranceBidx);
    if (existing) {
      if (appointmentUuid) {
        const linked = await getAppointmentCheck(appointmentUuid);
        if (linked && linked.status !== 'error') return { skipped: 'insurance_reused', check: linked };
        const cloned = await cloneCheckToAppointment(existing.uuid, { appointmentUuid, serviceDate: dosOverride, insuranceBidx, createdBy: providerId });
        return { skipped: 'insurance_reused', check: cloned };
      }
      return { skipped: 'insurance_reused', check: toPublicCheck(existing) };
    }
    if (await autoApiCountForInsurance(patientId, insuranceBidx) >= 2) return { skipped: 'insurance_auto_cap' };
  }

  // 1. Provider identity = the rendering provider's ASSIGNED FACILITY (NPI + state).
  const fac = await providerPrimaryFacility(providerId);
  if (!fac || !fac.npi) return { skipped: 'no_facility_npi' };

  // 2. Resolve the payer + its Stedi payer ID (the tradingPartnerServiceId — never
  //    the primary payer ID). ROUTING PRECEDENCE:
  //   • MBI on file (or a Medicare-Part-B payer name) → the STATE-SPECIFIC Medicare
  //     Part B MAC for the ASSIGNED FACILITY'S STATE, verified with the MBI.
  //   • Otherwise (no MBI) → the PRIMARY payer from the face sheet, resolved from the
  //     directory (DB) first, then the live payer-search API, verified with the
  //     primary Member ID.
  const medicarePartB = !!mbi || isMedicarePartB(ins.payer);
  let payer;
  if (medicarePartB) {
    if (!normalizeState(fac.state)) return { skipped: 'no_facility_state' };
    payer = await resolveMedicarePartB(fac.state);
  } else {
    if (!ins.payer) return { skipped: 'no_payer' };
    // EXACT resolution against the Stedi payer network only — no fuzzy match, no
    // live-search fallback. Unmatched → surfaced as "payer not matched" (never a
    // guessed payer). Providers pick the exact payer via the Payer search on the
    // face sheet, which stores the canonical name + Stedi ID.
    payer = await resolvePayer(ins.payer, { state: fac.state });
  }
  if (!payer || !payer.stediId) return { skipped: 'payer_unresolved' };

  // 3a. Procedure context. The billed CPT/HCPCS maps to a Service Type Code, but we
  //     DO NOT add it to the request: a procedure-specific inquiry must never change
  //     the plan's real benefits (and some payers error on it). We ALWAYS request the
  //     plan (STC 30) — the payer volunteers the per-service benefits — and merely
  //     READ the procedure's cost-share from that one authoritative response.
  const proc = stcsForProcedures(procedureCodes);
  const serviceTypeCodes = ['30'];        // plan coverage only — authoritative, unaffected by the procedure
  const readStcs = [...new Set(['30', ...proc.stcs])]; // which service's cost-share to surface

  // DOS: a provider-set date (from the UI) or the appointment date; otherwise the
  // date the patient was added. Normalized to YYYYMMDD. REQUIRED — no synthetic
  // "today" fallback (never a wrong date).
  const dateOfService = ymd(dosOverride) || ymd(patient.createdAt);
  if (!dateOfService) return { skipped: 'no_dos' };

  // 3b. Build the request in the EXACT required shape. No dependents, no address.
  //   subscriber   : first/last name + dateOfBirth + memberId (MBI first, else plan member ID).
  //   provider     : the assigned facility NPI + facility (organization) name.
  //   encounter    : serviceTypeCodes ALWAYS ["30"] + dateOfService (kept).
  //   tradingPartnerServiceId : the Stedi payer ID (routing key — never the plan payer ID).
  const request = {
    subscriber: {
      firstName: demo.firstName,
      lastName: demo.lastName,
      dateOfBirth: dob,
      memberId,                            // MBI when present, else the plan member ID
    },
    provider: {
      npi: fac.npi,                        // assigned facility NPI
      organizationName: fac.name || undefined, // assigned facility name
    },
    controlNumber: null,
    externalPatientId: memberId,
    encounter: {
      serviceTypeCodes,                    // ALWAYS "30" — the real plan benefits
      dateOfService,                       // appointment DOS, else the patient add-date (no fallback)
    },
    tradingPartnerServiceId: payer.stediId,
  };

  stediLog('eligibility.request', { patient: patient.uuid, stediId: payer.stediId, facilityNpi: fac.npi, serviceTypeCodes, procedures: proc.resolved.map((p) => p.code), appointment: appointmentUuid || undefined });

  // 4. Real-time 271 (no mock). Errors propagate to the caller.
  const response = await checkEligibility(request);

  // 5. Persist (encrypted). Appointment checks are stored against the appointment
  //    (service_date = appointment DOS) and never overwrite the Face Sheet.
  const context = proc.resolved.length ? { requestedProcedures: proc.resolved, requestedStcs: readStcs, unmappedProcedures: proc.unmapped } : { requestedStcs: readStcs };
  const check = await saveCheck({ patientId, policyIndex, response, createdBy: providerId, context, appointmentUuid, serviceDate: dosOverride || null, insuranceBidx, automatic: !force });
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
export async function verifyAppointmentEligibility(apptRow, { force = false } = {}) {
  try {
    if (!apptRow?.patient_uuid) return { skipped: 'no_patient' };
    // IDEMPOTENT: once benefits are fetched cleanly, never call the payer again.
    // Only (re)run when there is no check yet, the last one ERRORED (payer wasn't
    // responding), or force is set. So a successful appointment is verified exactly once.
    const existing = await getAppointmentCheck(apptRow.uuid);
    if (existing && existing.status !== 'error' && !force) {
      return { skipped: 'already_verified', check: existing };
    }
    if (!stediEnabled()) return { skipped: 'stedi_disabled' };
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
    // Re-throw real payer/clearinghouse errors (STEDI_US_IP_REQUIRED, STEDI_ERROR,
    // timeouts) so the MANUAL verify endpoint can surface the exact reason. Background
    // auto-verify callers wrap this in `.catch(() => {})`, so a throw is harmless there.
    logger.warn({ appointment: apptRow?.uuid, err: err.message, code: err.code }, 'appointment eligibility failed');
    throw err;
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
