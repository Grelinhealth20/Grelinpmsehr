import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt, blindIndex } from '../utils/crypto.js';

/**
 * Benefits Verification (X12 271 real-time eligibility).
 *
 * The payer response (e.g. via Stedi) is a large, deeply-nested EDI-derived JSON.
 * We keep it out of the small patient row and store it in its OWN table, fully
 * ENCRYPTED (AES-256-GCM) as PHI:
 *   - raw_enc     : the payer response verbatim (minus the redundant `x12` string)
 *   - summary_enc : a normalized, provider/SNF-focused view (this module owns the shape)
 *
 * Rows are append-only history; the UI reads the LATEST check per insurance policy.
 * Access is gated at the controller by patient ownership (no cross-patient leakage).
 */

/* --- 271 normalizer -------------------------------------------------------- */

const STC_MAP = {
  '1': 'Medical Care', '30': 'Health Benefit Plan Coverage', '33': 'Chiropractic',
  '35': 'Dental Care', '47': 'Hospital', '48': 'Hospital - Inpatient',
  '49': 'Hospital - Room and Board', '50': 'Hospital - Outpatient', '54': 'Long Term Care',
  '86': 'Emergency Services', '88': 'Pharmacy', '98': 'Professional (Physician) Visit - Office',
  'AL': 'Vision (Optometry)', 'MH': 'Mental Health', 'UC': 'Urgent Care',
};
// Service types a SNF Part B physician cares about first (visit + facility context).
const SNF_ORDER = ['30', '1', '98', 'MH', '49', '48', '50', '54', '86', 'UC', '33', 'AL', '35', '88'];

const TQ = {
  '23': 'Calendar Year', '24': 'Year to Date', '25': 'Contract', '26': 'Episode',
  '27': 'Visit', '29': 'Remaining', '32': 'Lifetime', '33': 'Lifetime Remaining', '36': 'Admission',
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const money = (v) => {
  const n = num(v);
  if (n === null) return null;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
};
const pct = (v) => {
  const n = num(v);
  if (n === null) return null;
  const p = n <= 1 ? n * 100 : n; // 271 sends fractions ("0.2" = 20%)
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
};
const zipFmt = (z) => {
  const s = String(z || '').replace(/\D/g, '');
  if (s.length === 9) return `${s.slice(0, 5)}-${s.slice(5)}`;
  return s || '';
};
const yyyymmdd = (v) => {
  const s = String(v || '').replace(/\D/g, '');
  if (s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};
const addr = (a) => {
  if (!a) return '';
  return [a.address1, a.address2, [a.city, a.state].filter(Boolean).join(', '), zipFmt(a.postalCode)]
    .filter(Boolean).join(', ');
};
const net = (b) => {
  const c = b?.inPlanNetworkIndicatorCode;
  if (c === 'Y') return 'In-network';
  if (c === 'N') return 'Out-of-network';
  return null; // 'W' Not Applicable / unset
};
const noteOf = (b) => {
  const parts = (b.additionalInformation || []).map((d) => d.description).filter(Boolean);
  const tele = b.eligibilityAdditionalInformation?.industry;
  if (tele) parts.push(tele);
  return parts.join(' · ');
};

const KIND = {
  '1': { kind: 'active', label: 'Active Coverage' },
  'A': { kind: 'coinsurance', label: 'Co-Insurance' },
  'B': { kind: 'copay', label: 'Co-Payment' },
  'C': { kind: 'deductible', label: 'Deductible' },
  'G': { kind: 'oop', label: 'Out of Pocket' },
  'F': { kind: 'limitation', label: 'Limitation' },
  'I': { kind: 'noncovered', label: 'Non-Covered' },
};

function factValue(b, kind) {
  switch (kind) {
    case 'coinsurance': return pct(b.benefitPercent);
    case 'copay':
    case 'deductible':
    case 'oop': return money(b.benefitAmount);
    case 'noncovered': return 'Not covered';
    case 'active': return 'Active';
    case 'limitation': {
      const sd = (b.benefitsServiceDelivery || [])[0];
      if (sd) {
        const rem = (b.benefitsServiceDelivery || []).find((x) => x.timePeriodQualifierCode === '29');
        const base = `${sd.quantity} ${sd.quantityQualifier?.toLowerCase() || ''}/${sd.timePeriodQualifier || ''}`.trim();
        return rem ? `${base} (${rem.quantity} remaining)` : base;
      }
      if (b.benefitQuantity) return `${b.benefitQuantity} ${b.quantityQualifier || ''}`.trim();
      if (b.benefitPercent) return pct(b.benefitPercent);
      return 'See notes';
    }
    default: return null;
  }
}

/** Deductible / OOP roll-up for a service type across Calendar-Year / YTD / Remaining. */
function rollup(list, code, stc) {
  const rows = list.filter((b) => b.code === code && (b.serviceTypeCodes || []).includes(stc));
  if (!rows.length) return null;
  const at = (tq) => rows.find((r) => r.timeQualifierCode === tq);
  const cy = at('23') || at('25') || at('32');
  const ytd = at('24');
  const rem = at('29') || at('33');
  const out = {
    annual: money(cy?.benefitAmount),
    met: money(ytd?.benefitAmount),
    remaining: money(rem?.benefitAmount),
    network: net(cy || rows[0]),
  };
  if (out.annual === null && out.met === null && out.remaining === null) return null;
  return out;
}

export function normalize271(resp) {
  const bi = Array.isArray(resp?.benefitsInformation) ? resp.benefitsInformation : [];
  const ps = Array.isArray(resp?.planStatus) ? resp.planStatus[0] : null;
  const coverageActive = ps?.statusCode === '1' || bi.some((b) => b.code === '1');
  // A payer/clearinghouse error (AAA rejection — e.g. "Unable to Respond at
  // Current Time") means the payer COULD NOT answer. That is NOT "no coverage":
  // it must read as an error/retry state, never a red "Inactive".
  const respErrors = Array.isArray(resp?.errors) ? resp.errors : [];
  const payerError = respErrors.length > 0 && !coverageActive && bi.length === 0 && !ps;

  // Subscriber / member.
  const sub = resp?.subscriber || {};
  const sa = sub.address || {};
  const member = {
    name: [sub.firstName, sub.middleName, sub.lastName].filter(Boolean).join(' ').trim(),
    firstName: sub.firstName || '', lastName: sub.lastName || '',
    dob: yyyymmdd(sub.dateOfBirth),
    gender: sub.gender === 'M' ? 'Male' : sub.gender === 'F' ? 'Female' : (sub.gender || ''),
    memberId: sub.memberId || '',
    mbi: resp?.planInformation?.hicNumber || '',
    group: sub.groupNumber || resp?.planInformation?.groupNumber || '',
    groupDescription: sub.groupDescription || resp?.planInformation?.groupDescription || '',
    address: addr(sa),
    // Structured parts so the Face Sheet can be updated field-by-field.
    addressParts: {
      address1: [sa.address1, sa.address2].filter(Boolean).join(', '),
      city: sa.city || '', state: sa.state || '', zip: zipFmt(sa.postalCode),
    },
  };

  // Plan.
  const pdi = resp?.planDateInformation || {};
  const umbrella = bi.find((b) => b.code === '1' && b.planCoverage) || bi.find((b) => b.code === '1' && b.insuranceType);
  const plan = {
    name: ps?.planDetails || umbrella?.planCoverage || umbrella?.insuranceType || '',
    type: umbrella?.insuranceType || '',
    begin: yyyymmdd(pdi.planBegin),
    end: yyyymmdd(pdi.planEnd),
    serviceDate: yyyymmdd(pdi.service || resp?.encounter?.dateOfService),
    coverageLevel: umbrella?.coverageLevel || '',
  };

  // PCP (first Person entity under code 'L').
  let pcp = null;
  for (const b of bi) {
    if (b.code !== 'L') continue;
    const e = b.benefitsRelatedEntity;
    if (e && e.entityType === 'Person') {
      pcp = {
        name: [e.entityFirstname, e.entityMiddlename, e.entityName].filter(Boolean).join(' ').trim(),
        phone: e.contactInformation?.contacts?.find((c) => c.communicationMode === 'Telephone')?.communicationNumber || '',
        address: addr(e.address),
      };
      break;
    }
  }

  // Financial summary (Health Benefit Plan Coverage, STC 30).
  const financial = {
    deductible: rollup(bi, 'C', '30'),
    oop: rollup(bi, 'G', '30'),
  };

  // Per-service breakdown. Skip disclaimers, "other source", PCP entities, and the
  // broad multi-service "Active Coverage" umbrella rows (used only for the active set).
  const activeSet = new Set();
  bi.forEach((b) => { if (b.code === '1') (b.serviceTypeCodes || []).forEach((c) => activeSet.add(c)); });

  const svc = new Map();
  const ensure = (code, name) => {
    if (!svc.has(code)) svc.set(code, { code, name: name || STC_MAP[code] || `Service ${code}`, active: activeSet.has(code), items: [] });
    return svc.get(code);
  };
  bi.forEach((b) => {
    if (['P', 'W', 'L'].includes(b.code)) return;
    const codes = b.serviceTypeCodes || [];
    if (b.code === '1' && codes.length > 2) return; // umbrella active list
    const map = KIND[b.code];
    if (!map) return;
    const stc = codes[0];
    if (!stc) return;
    const name = (b.serviceTypes && b.serviceTypes[0]) || STC_MAP[stc];
    ensure(stc, name).items.push({
      kind: map.kind,
      label: map.label,
      value: factValue(b, map.kind),
      per: b.timeQualifier || TQ[b.timeQualifierCode] || null,
      network: net(b),
      coverageLevel: b.coverageLevel || null,
      note: noteOf(b) || null,
    });
  });
  const services = [...svc.values()].sort((a, b) => {
    const ia = SNF_ORDER.indexOf(a.code); const ib = SNF_ORDER.indexOf(b.code);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  // SNF Part B professional-visit cost highlight (STC 98, fall back to Medical Care 1).
  const office = services.find((s) => s.code === '98') || services.find((s) => s.code === '1');
  let visitCost = null;
  if (office) {
    const coins = office.items.find((i) => i.kind === 'coinsurance' && i.value && i.value !== '0%')
      || office.items.find((i) => i.kind === 'coinsurance');
    const copay = office.items.find((i) => i.kind === 'copay' && i.value && i.value !== '$0');
    visitCost = {
      service: office.name,
      coinsurance: coins?.value || null,
      copay: copay?.value || null,
      deductibleRemaining: financial.deductible?.remaining ?? null,
      note: 'Patient responsibility for a physician visit, after any remaining deductible.',
    };
  }

  // Plan-level member messages (SilverSneakers, etc.) and the estimate disclaimer.
  const messages = [];
  let disclaimer = '';
  bi.forEach((b) => {
    if (b.code === 'P') disclaimer = (b.additionalInformation || [])[0]?.description || disclaimer;
    if (b.code === '1' && (b.serviceTypeCodes || []).includes('30')) {
      (b.additionalInformation || []).forEach((d) => { if (d.description) messages.push(d.description); });
    }
  });

  // Limitations (visit caps, max ages) surfaced separately for quick scanning.
  const limitations = bi
    .filter((b) => b.code === 'F')
    .map((b) => ({
      service: (b.serviceTypes && b.serviceTypes[0]) || STC_MAP[(b.serviceTypeCodes || [])[0]] || 'Plan',
      value: factValue(b, 'limitation'),
      note: noteOf(b) || null,
    }))
    .filter((l) => l.value);

  return {
    status: payerError ? 'error' : (coverageActive ? 'active' : 'inactive'),
    statusLabel: payerError ? (respErrors[0].description || 'Payer could not respond') : (ps?.status || (coverageActive ? 'Active Coverage' : 'Inactive')),
    coverageActive,
    payerError,
    errors: respErrors,
    payer: { name: resp?.payer?.name || '', id: resp?.payer?.payorIdentification || resp?.tradingPartnerServiceId || '' },
    member,
    plan,
    pcp,
    financial,
    visitCost,
    services,
    limitations,
    messages,
    disclaimer,
    traceId: resp?.meta?.traceId || resp?.controlNumber || '',
    searchId: resp?.eligibilitySearchId || resp?.id || '',
  };
}

/* --- Persistence ----------------------------------------------------------- */

export function toPublicCheck(row) {
  if (!row) return null;
  let summary = null;
  try { summary = row.summary_enc ? JSON.parse(decrypt(row.summary_enc)) : null; } catch { summary = null; }
  return {
    uuid: row.uuid,
    policyIndex: Number(row.policy_index),
    payer: row.payer_name || summary?.payer?.name || '',
    status: row.status || summary?.status || 'unknown',
    serviceDate: row.service_date || summary?.plan?.serviceDate || null,
    planEnd: row.plan_end || summary?.plan?.end || null,
    verifiedAt: row.created_at,
    summary,
  };
}

/**
 * Copay / deductible / coinsurance / OOP by coverage level (Individual, Family)
 * for the appointment popup. Deductible + OOP are plan-level (STC 30). Copay +
 * coinsurance come from the appointment's primary service — the procedure's STC
 * when one was selected, otherwise the health-plan STC 30. Reads ACTUAL returned
 * values only (no fabrication); a value absent from the 271 is null.
 */
export function coverageLevelSummary(resp, stcs = ['30']) {
  const bi = Array.isArray(resp?.benefitsInformation) ? resp.benefitsInformation : [];
  const primary = (stcs || []).find((s) => s && s !== '30') || '30';
  const has = (b, stc) => (b.serviceTypeCodes || []).includes(stc);
  const find = (code, stc, level, tq) =>
    bi.find((b) => b.code === code && b.coverageLevelCode === level && has(b, stc) && (!tq || b.timeQualifierCode === tq))
    || bi.find((b) => b.code === code && b.coverageLevelCode === level && has(b, stc));
  const cell = (level) => ({
    deductible: money(find('C', '30', level, '23')?.benefitAmount),
    oopMax: money(find('G', '30', level, '23')?.benefitAmount),
    copay: money(find('B', primary, level)?.benefitAmount),
    coinsurance: pct(find('A', primary, level)?.benefitPercent),
  });
  return { primaryStc: primary, individual: cell('IND'), family: cell('FAM') };
}

// Normalize a date to a DATE column value (YYYY-MM-DD) from YYYYMMDD or YYYY-MM-DD.
function toDbDate(v) {
  const s = String(v || '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** Blind index of a patient's insurance identity (payer + member/MBI) for dedup. */
export function insuranceBidxOf(payer, memberOrMbi) {
  const id = String(memberOrMbi || '').trim().toUpperCase();
  if (!id) return null;
  return blindIndex(`${String(payer || '').trim().toLowerCase()}|${id}`);
}

/** Store one verification. `response` is the raw 271 payload (an object). */
export async function saveCheck({ patientId, policyIndex = 0, response, createdBy = null, context = null, appointmentUuid = null, serviceDate = null, insuranceBidx = null, automatic = false }) {
  const summary = normalize271(response);
  summary.coverageLevels = coverageLevelSummary(response, context?.requestedStcs || ['30']);
  // Record what was asked for (procedure-specific STC targeting) alongside the result.
  if (context) {
    if (context.requestedProcedures) summary.requestedProcedures = context.requestedProcedures;
    if (context.requestedStcs) summary.requestedStcs = context.requestedStcs;
    if (context.unmappedProcedures?.length) summary.unmappedProcedures = context.unmappedProcedures;
  }
  // Drop the bulky, redundant EDI string before persisting the raw response.
  const rawJson = JSON.stringify(response, (k, v) => (k === 'x12' ? undefined : v));
  const sdate = toDbDate(serviceDate) || summary.plan.serviceDate || null;
  const uuid = uuidv4();
  await execute(
    `INSERT INTO eligibility_checks
       (uuid, patient_id, policy_index, appointment_uuid, payer_name, member_id_bidx, insurance_bidx, status, automatic, service_date, plan_end, summary_enc, raw_enc, created_by)
     VALUES
       (:uuid, :pid, :idx, :appt, :payer, :midx, :ibidx, :status, :auto, :sdate, :pend, :summ, :raw, :by)`,
    {
      uuid,
      pid: patientId,
      idx: policyIndex,
      appt: appointmentUuid || null,
      // Payer name is insurance PHI — never stored in plaintext; it lives inside the
      // encrypted summary and is read from there. member_id is stored only as a
      // one-way HMAC blind index (never the raw value).
      payer: null,
      midx: summary.member.memberId ? blindIndex(summary.member.memberId) : null,
      ibidx: insuranceBidx || null,
      status: summary.status,
      auto: automatic ? 1 : 0,
      sdate,
      pend: summary.plan.end || null,
      summ: encrypt(JSON.stringify(summary)),
      raw: encrypt(rawJson),
      by: createdBy,
    },
  );
  return toPublicCheck({
    uuid, policy_index: policyIndex, payer_name: summary.payer.name, status: summary.status,
    service_date: sdate, plan_end: summary.plan.end, created_at: new Date(), summary_enc: encrypt(JSON.stringify(summary)),
  });
}

/** Latest appointment eligibility check (decrypted summary) for the schedule popup. */
export async function getAppointmentCheck(appointmentUuid) {
  const [rows] = await execute(
    `SELECT uuid, policy_index, payer_name, status, service_date, plan_end, summary_enc, created_at
       FROM eligibility_checks
      WHERE appointment_uuid = :au
      ORDER BY id DESC LIMIT 1`,
    { au: appointmentUuid },
  );
  return rows[0] ? toPublicCheck(rows[0]) : null;
}

/** Latest SUCCESSFUL check (any source) for this patient + insurance — the raw row. */
export async function latestBenefitsForInsurance(patientId, insuranceBidx) {
  if (!insuranceBidx) return null;
  const [rows] = await execute(
    `SELECT uuid, policy_index, appointment_uuid, payer_name, status, service_date, plan_end, summary_enc, created_at
       FROM eligibility_checks
      WHERE patient_id = :pid AND insurance_bidx = :ib AND status <> 'error'
      ORDER BY id DESC LIMIT 1`,
    { pid: patientId, ib: insuranceBidx },
  );
  return rows[0] || null;
}

/** Count of AUTOMATIC payer calls for this patient + insurance (the cap basis). */
export async function autoApiCountForInsurance(patientId, insuranceBidx) {
  if (!insuranceBidx) return 0;
  const [rows] = await execute(
    `SELECT COUNT(*) AS n FROM eligibility_checks WHERE patient_id = :pid AND insurance_bidx = :ib AND automatic = 1`,
    { pid: patientId, ib: insuranceBidx },
  );
  return Number(rows[0].n) || 0;
}

/** Reuse a stored check's benefits on an appointment (a DB copy — NO payer call). */
export async function cloneCheckToAppointment(sourceUuid, { appointmentUuid, serviceDate = null, insuranceBidx = null, createdBy = null }) {
  const uuid = uuidv4();
  await execute(
    `INSERT INTO eligibility_checks
       (uuid, patient_id, policy_index, appointment_uuid, payer_name, member_id_bidx, insurance_bidx, status, automatic, service_date, plan_end, summary_enc, raw_enc, created_by)
     SELECT :uuid, patient_id, policy_index, :appt, payer_name, member_id_bidx, :ib, status, 0, :sdate, plan_end, summary_enc, raw_enc, :by
       FROM eligibility_checks WHERE uuid = :src LIMIT 1`,
    { uuid, appt: appointmentUuid, ib: insuranceBidx, sdate: toDbDate(serviceDate), by: createdBy, src: sourceUuid },
  );
  return getAppointmentCheck(appointmentUuid);
}

/**
 * Merge payer-confirmed identity from a normalized 271 into the patient's Face
 * Sheet + the matching insurance policy. The payer response is authoritative for
 * address, group number, MBI and plan details, so those are CORRECTED (overwritten)
 * when the 271 provides them. Name/DOB/gender are only filled when missing so we
 * never silently rewrite a provider-entered identity. Returns a patch for
 * updatePatient; nothing is written for a different patient (caller is scoped).
 */
export function mergeVerificationIntoPatient(patient, summary, policyIndex = 0, opts = {}) {
  const m = summary?.member || {};
  const demographics = { ...(patient?.demographics || {}) };
  const ap = m.addressParts;
  if (ap) {
    if (ap.address1) demographics.address = ap.address1;
    if (ap.city) demographics.city = ap.city;
    if (ap.state) demographics.state = ap.state;
    if (ap.zip) demographics.zip = ap.zip;
  }
  if (!demographics.dob && m.dob) demographics.dob = m.dob;
  if (!demographics.firstName && m.firstName) demographics.firstName = m.firstName;
  if (!demographics.lastName && m.lastName) demographics.lastName = m.lastName;
  if (!demographics.gender || demographics.gender === 'unknown') {
    if (m.gender === 'Male') demographics.gender = 'male';
    else if (m.gender === 'Female') demographics.gender = 'female';
  }

  const RANKS = ['primary', 'secondary', 'tertiary'];
  const insurance = Array.isArray(patient?.insurance) ? patient.insurance.map((x) => ({ ...x })) : [];
  while (insurance.length <= policyIndex) {
    insurance.push({ type: RANKS[insurance.length] || 'primary', payer: '', memberId: '', group: '', planType: '', mbi: '', benefits: {} });
  }
  const pol = insurance[policyIndex];
  if (m.group) pol.group = m.group;             // payer-authoritative
  if (m.mbi) pol.mbi = m.mbi;                    // payer-authoritative
  // Fill the plan member ID only when missing — never overwrite it with an echoed
  // MBI (the MBI lives in its own field; the two must not be conflated).
  if (m.memberId && !pol.memberId) pol.memberId = m.memberId;
  // Canonical Stedi payer name + ID (e.g. "UHC" -> "UnitedHealthcare") override
  // the free-text entry so the face sheet matches the payer network exactly.
  if (opts.canonicalPayer) pol.payer = opts.canonicalPayer;
  else if (summary.payer?.name && !pol.payer) pol.payer = summary.payer.name;
  // Payer ID stored on the policy is the STEDI payer ID only (never the primary
  // payer ID from the 271, which is a different identifier).
  if (opts.payerId) pol.payerId = opts.payerId;
  if (!pol.planType && (summary.plan?.type || summary.plan?.name)) pol.planType = summary.plan.type || summary.plan.name;

  const f = summary.financial || {};
  const prev = pol.benefits || {};
  pol.benefits = {
    eligibilityStatus: summary.status === 'active' ? 'active' : summary.status === 'inactive' ? 'inactive' : (prev.eligibilityStatus || 'pending'),
    planName: summary.plan?.name || prev.planName || '',
    network: prev.network || '',
    effectiveDate: summary.plan?.begin || prev.effectiveDate || '',
    termDate: summary.plan?.end || prev.termDate || '',
    copay: summary.visitCost?.copay || prev.copay || '',
    coinsurance: summary.visitCost?.coinsurance || prev.coinsurance || '',
    deductible: f.deductible?.annual || prev.deductible || '',
    deductibleMet: f.deductible?.met || prev.deductibleMet || '',
    oopMax: f.oop?.annual || prev.oopMax || '',
    oopMet: f.oop?.met || prev.oopMet || '',
    coverageNotes: prev.coverageNotes || '',
    verifiedDate: summary.plan?.serviceDate || prev.verifiedDate || '',
    verifiedBy: 'Payer eligibility (271)',
    referenceNo: summary.traceId || prev.referenceNo || '',
  };
  return { demographics, insurance };
}

/**
 * Has this patient+policy already been verified in the CURRENT calendar month?
 * Enforces "no duplicate benefits verification for the same patient within a
 * month" (avoids redundant payer calls). Computed in the DB (NOW()) so it is
 * timezone-consistent with created_at.
 */
export async function hasCheckThisMonth(patientId, policyIndex = 0) {
  const [rows] = await execute(
    `SELECT id FROM eligibility_checks
      WHERE patient_id = :pid AND policy_index = :idx AND appointment_uuid IS NULL
        AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01 00:00:00')
      LIMIT 1`,
    { pid: patientId, idx: policyIndex },
  );
  return rows.length > 0;
}

/** Latest verification per insurance policy for a patient (for the Benefits tab). */
export async function listChecks(patientId) {
  const [rows] = await execute(
    `SELECT e.uuid, e.policy_index, e.payer_name, e.status, e.service_date, e.plan_end, e.summary_enc, e.created_at
       FROM eligibility_checks e
       JOIN (
         SELECT policy_index, MAX(id) AS max_id
           FROM eligibility_checks
          WHERE patient_id = :pid AND appointment_uuid IS NULL
          GROUP BY policy_index
       ) latest ON latest.max_id = e.id
      WHERE e.patient_id = :pid2 AND e.appointment_uuid IS NULL
      ORDER BY e.policy_index ASC`,
    { pid: patientId, pid2: patientId },
  );
  return rows.map(toPublicCheck);
}
