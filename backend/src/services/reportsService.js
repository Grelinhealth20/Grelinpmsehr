/**
 * Reports + RVU Payscale — STRICTLY provider-scoped (owner-only), real-time from the live DB. Every query
 * filters `provider_id = :providerId` (resolved from the authenticated session, never a client value), so
 * a provider only ever sees their OWN encounters / notes / patients / pay — no cross-provider leakage.
 *
 * Payscale mirrors the CY2026 Central-Florida workbook exactly (see payscaleConfig.js): pay is on the
 * WORK-RVU value (Encounters × Work RVU × rate; rate = 60% × CF), from the CMS mpfs_rvu dataset, payable
 * codes only. Rounding matches the workbook: provider pay rounds the total; the Medicare reference value
 * rounds per-encounter then multiplies.
 */
import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';
import {
  RVU_YEAR, PAYABLE_STATUS, PROVIDER_SHARE, GROUP_SHARE, providerRatePerWorkRvu,
  conversionFactor, localityFor, providerType, DEFAULT_LOCALITY, posSetting, posForNoteType,
} from './payscaleConfig.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Place of Service per note — a REAL per-encounter input to the RVU calculation (selects facility vs
 * non-facility practice-expense RVU for the Medicare allowed amount). Derived from the note type/service
 * line: SNF Part B E/M (the universal note types) = POS 31/32 (facility); Pain-Management and
 * Personal-Injury office visits = POS 11 (office / non-facility). Unknown types fall back to `dflt`.
 * NOTE: POS does NOT change the provider's Work-RVU-based pay (per the workbook) — it changes the
 * reference Medicare allowed amount and is shown per line.
 */
const POS_NAME = {
  '02': 'Telehealth', '10': 'Telehealth (home)', '11': 'Office', '12': 'Home', '13': 'Assisted living',
  '31': 'Skilled nursing facility', '32': 'Nursing facility', '22': 'Hospital outpatient', '21': 'Inpatient hospital',
  '24': 'Ambulatory surgical center', '33': 'Custodial care',
};
function posInfo(posCode, noteType) {
  // The note's explicit CMS POS (any code: 11/12/31/32/10/…) is authoritative; when absent, seed from the
  // note type. Then classify facility vs non-facility PE via the full CMS POS map.
  const raw = posCode != null ? String(posCode).replace(/\D/g, '') : '';
  const code = raw ? raw.slice(0, 4) : posForNoteType(noteType);
  const setting = posSetting(code);
  const name = POS_NAME[code] || (setting === 'facility' ? 'Facility' : 'Office');
  return { code, setting, label: `${name} (POS ${code})` };
}

/** Provider report summary — total & typed encounters, signed/unsigned notes, patients visited. Owner-only. */
export async function providerSummary(providerId, { from = null, to = null } = {}) {
  const encParams = { pid: providerId };
  const encWhere = ['e.provider_id = :pid'];
  const encDate = 'COALESCE(e.encounter_date, a.appt_date, DATE(e.created_at))';
  if (from) { encWhere.push(`${encDate} >= :from`); encParams.from = from; }
  if (to) { encWhere.push(`${encDate} < :to`); encParams.to = to; }
  const [encRows] = await execute(
    `SELECT COUNT(*) AS total_encounters, COUNT(DISTINCT e.patient_id) AS patients_visited
       FROM encounters e LEFT JOIN appointments a ON a.id = e.appointment_id
      WHERE ${encWhere.join(' AND ')}`, encParams);
  const enc = encRows[0] || {};

  const nParams = { pid: providerId };
  const nWhere = ['n.provider_id = :pid'];
  if (from) { nWhere.push('n.created_at >= :from'); nParams.from = from; }
  if (to) { nWhere.push('n.created_at < :to'); nParams.to = to; }
  const [nRows] = await execute(
    `SELECT SUM(n.status = 'signed') AS signed_notes, SUM(n.status = 'draft') AS unsigned_notes, COUNT(*) AS total_notes
       FROM encounter_notes n WHERE ${nWhere.join(' AND ')}`, nParams);
  const notes = nRows[0] || {};
  const [types] = await execute(
    `SELECT n.note_type AS type, COUNT(*) AS cnt, SUM(n.status = 'signed') AS signed
       FROM encounter_notes n WHERE ${nWhere.join(' AND ')} GROUP BY n.note_type ORDER BY cnt DESC`, nParams);

  return {
    totalEncounters: Number(enc.total_encounters) || 0,
    patientsVisited: Number(enc.patients_visited) || 0,
    signedNotes: Number(notes.signed_notes) || 0,
    unsignedNotes: Number(notes.unsigned_notes) || 0,
    totalNotes: Number(notes.total_notes) || 0,
    encounterTypes: types.map((t) => ({ type: t.type || 'unspecified', count: Number(t.cnt) || 0, signed: Number(t.signed) || 0 })),
  };
}

/**
 * RVU-based payscale for one provider (owner-only, real-time). Sums the provider's SIGNED-note procedures
 * → mpfs_rvu → workbook math. `cfKind` standard|apm; `localityCode` FL 99/03/04; `setting` facility|office
 * (affects only the reference full fee, never pay).
 */
export async function providerPayscale(providerId, { from = null, to = null, credentials = [], cfKind = 'standard', localityCode = DEFAULT_LOCALITY, setting = 'facility', excludePaid = true } = {}) {
  const locality = localityFor(localityCode);
  const gpci = locality.gpci;
  const params = { pid: providerId, year: RVU_YEAR };
  const where = ['n.provider_id = :pid', "n.status = 'signed'", "c.kind = 'proc'"];
  if (from) { where.push('n.signed_at >= :from'); params.from = from; }
  if (to) { where.push('n.signed_at < :to'); params.to = to; }
  // Anti-join the paid-note ledger: a note already PAID in a finalized period is never counted again, so
  // already-paid RVUs can never appear on a later paycheck (structural no-double-pay). finalizePeriod calls
  // with excludePaid:false only to see the raw period, but the ledger insert itself enforces pay-once.
  if (excludePaid) where.push('pnl.note_id IS NULL');
  const [rows] = await execute(
    `SELECT n.id AS note_id, c.code, c.description, COALESCE(c.units, 1) AS units, n.note_type AS note_type, n.pos_code AS pos_code,
            m.work_rvu, m.fac_pe_rvu, m.nonfac_pe_rvu, m.mp_rvu, m.conv_factor, m.status_code
       FROM encounter_notes n
       JOIN encounter_note_codes c ON c.note_id = n.id AND c.kind = 'proc'
       LEFT JOIN paid_note_ledger pnl ON pnl.note_id = n.id
       LEFT JOIN mpfs_rvu m ON m.hcpcs = c.code AND m.modifier = '' AND m.year = :year
      WHERE ${where.join(' AND ')}`, params);

  const byCode = new Map();
  const unpriced = new Set();
  const paidNoteIds = new Set();
  let datasetCf = null;
  for (const r of rows) {
    const inDataset = r.work_rvu != null || r.conv_factor != null;
    if (!inDataset) { unpriced.add(r.code); continue; }                 // not in the MPFS RVU file
    if (r.status_code && !PAYABLE_STATUS.has(r.status_code)) continue;  // not separately payable by RVUs
    const work = Number(r.work_rvu) || 0;
    if (work <= 0) continue;                                            // no work RVU → no provider pay
    if (datasetCf == null && Number(r.conv_factor) > 0) datasetCf = Number(r.conv_factor);
    paidNoteIds.add(r.note_id);                                         // this note contributed payable work
    const units = Number(r.units) || 1;
    const pos = posInfo(r.pos_code, r.note_type);                            // REAL per-encounter POS (fac vs office PE)
    const key = `${r.code}|${pos.code}`;
    const agg = byCode.get(key) || {
      code: r.code, description: r.description, setting: pos.setting, placeOfService: pos.label,
      units: 0, workRvu: work, fac_pe: Number(r.fac_pe_rvu) || 0, nonfac_pe: Number(r.nonfac_pe_rvu) || 0, mp: Number(r.mp_rvu) || 0,
    };
    agg.units += units;
    byCode.set(key, agg);
  }

  const cf = conversionFactor(cfKind, datasetCf); // live dataset CF (standard) or CMS APM CF
  const rate = providerRatePerWorkRvu(cf);        // DERIVED: 60% × CF (→ $20.0405 at standard CF)
  const lines = [];
  let totalWorkRvu = 0, providerPay = 0, medicareWorkValue = 0, fullFeeRef = 0;
  for (const a of byCode.values()) {
    const totWork = a.workRvu * a.units;
    const linePay = round2(totWork * rate);                                   // pay: round the total (workbook Step 7)
    const lineWorkValue = round2(a.units * round2(a.workRvu * cf));           // reference: round per-encounter, then × (Steps 9–10)
    const pe = a.setting === 'facility' ? a.fac_pe : a.nonfac_pe;             // POS-driven PE (facility vs non-facility)
    const perEncFee = round2((a.workRvu * gpci.work + pe * gpci.pe + a.mp * gpci.mp) * cf);
    const lineFee = round2(a.units * perEncFee);                              // full FL physician fee (reference only)
    totalWorkRvu += totWork;
    providerPay += linePay;
    medicareWorkValue += lineWorkValue;
    fullFeeRef += lineFee;
    lines.push({ code: a.code, description: a.description, placeOfService: a.placeOfService, encounters: a.units, workRvu: round2(totWork), providerPay: linePay, medicareWorkValue: lineWorkValue, fullFee: lineFee });
  }
  lines.sort((x, y) => y.providerPay - x.providerPay);
  providerPay = round2(providerPay);
  medicareWorkValue = round2(medicareWorkValue);
  const groupRetained = round2(medicareWorkValue - providerPay);

  return {
    providerType: providerType(credentials),
    locality: { code: locality.code, name: locality.name },
    gpci, conversionFactor: cf, providerRatePerWorkRvu: rate,
    providerShare: PROVIDER_SHARE, groupShare: GROUP_SHARE, defaultSetting: setting,
    totalWorkRvu: round2(totalWorkRvu),
    providerPay, groupRetained, medicareWorkValue, fullFeeReference: round2(fullFeeRef),
    procedureCount: lines.length, lines, unpricedCodes: [...unpriced],
    noteIds: [...paidNoteIds],   // exact signed notes that produced this pay (for the paid-note ledger)
  };
}

/** Bi-weekly / monthly period boundaries (UTC), most-recent first. Bi-weekly anchored to 2024-01-01 (Mon). */
export function buildPeriods(periodType, count = 6, ref = new Date()) {
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  const periods = [];
  if (periodType === 'biweekly') {
    const ANCHOR = Date.UTC(2024, 0, 1);
    const P = 14 * 86400000;
    const today = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
    const idx = Math.floor((today - ANCHOR) / P);
    for (let i = 0; i < count; i++) { const s = ANCHOR + (idx - i) * P; const e = s + P; periods.push({ label: `${ymd(s)} – ${ymd(e - 86400000)}`, from: ymd(s), to: ymd(e) }); }
  } else {
    for (let i = 0; i < count; i++) {
      const s = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i, 1);
      const e = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - i + 1, 1);
      periods.push({ label: new Date(s).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), from: ymd(s), to: ymd(e) });
    }
  }
  return periods;
}

/**
 * Monthly statement (workbook "Monthly Statement" layout) — for ONE month, each procedure the provider
 * personally performed, with encounters split by WEEK of the month (Week 1–5, by signed_at day), total
 * encounters, place of service, and pay. Owner-only, real-time.
 */
export async function providerMonthlyStatement(providerId, { year, month, credentials = [], cfKind = 'standard', localityCode = DEFAULT_LOCALITY, setting = 'facility' } = {}) {
  const y = Number(year); const mo = Number(month); // month is 1-12
  const from = `${y}-${String(mo).padStart(2, '0')}-01`;
  const to = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10); // first of next month
  const [rows] = await execute(
    `SELECT c.code, c.description, COALESCE(c.units, 1) AS units, DAY(n.signed_at) AS d, n.note_type AS note_type, n.pos_code AS pos_code,
            m.work_rvu, m.conv_factor, m.status_code
       FROM encounter_notes n
       JOIN encounter_note_codes c ON c.note_id = n.id AND c.kind = 'proc'
       LEFT JOIN mpfs_rvu m ON m.hcpcs = c.code AND m.modifier = '' AND m.year = :year
      WHERE n.provider_id = :pid AND n.status = 'signed' AND n.signed_at >= :from AND n.signed_at < :to`,
    { pid: providerId, year: RVU_YEAR, from, to });

  const byCode = new Map();
  let datasetCf = null;
  for (const r of rows) {
    if (r.work_rvu == null && r.conv_factor == null) continue;         // unpriced
    if (r.status_code && !PAYABLE_STATUS.has(r.status_code)) continue; // not payable by RVUs
    const work = Number(r.work_rvu) || 0;
    if (work <= 0) continue;
    if (datasetCf == null && Number(r.conv_factor) > 0) datasetCf = Number(r.conv_factor);
    const units = Number(r.units) || 1;
    const wk = Math.min(5, Math.max(1, Math.ceil(Number(r.d) / 7)));   // Week 1–5 of the month
    const pos = posInfo(r.pos_code, r.note_type);                           // REAL per-encounter POS
    const key = `${r.code}|${pos.code}`;
    const agg = byCode.get(key) || { code: r.code, description: r.description, work, weeks: [0, 0, 0, 0, 0], total: 0, placeOfService: pos.label };
    agg.weeks[wk - 1] += units;
    agg.total += units;
    byCode.set(key, agg);
  }
  const cf = conversionFactor(cfKind, datasetCf);
  const rate = providerRatePerWorkRvu(cf);
  const lines = [];
  let totalPay = 0, totalEnc = 0;
  for (const a of byCode.values()) {
    const pay = round2(a.work * a.total * rate);
    totalPay += pay; totalEnc += a.total;
    lines.push({ code: a.code, description: a.description, weeks: a.weeks, encounters: a.total, placeOfService: a.placeOfService, pay });
  }
  lines.sort((x, y) => y.pay - x.pay);
  return {
    year: y, month: mo, from, to,
    label: new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    providerRatePerWorkRvu: rate,
    lines, totalEncounters: totalEnc, totalPay: round2(totalPay),
  };
}

/**
 * ADMIN (master/super) view — per-provider pay across the group, real-time. Aggregates every provider's
 * signed payable procedures → pay, optionally filtered to one facility (providers assigned to it) and/or
 * one provider. Not owner-scoped (admins see all); each row is one provider with their own total, so no
 * provider's data bleeds into another's. Pay is Work-RVU based (locality-independent), so it is accurate
 * for any facility/county; the facility's locality only affects the reference fee (shown per-provider).
 */
export async function adminProviderPayscale({ facilityUuid = null, providerUuid = null, from = null, to = null, cfKind = 'standard', excludePaid = true } = {}) {
  const params = { year: RVU_YEAR };
  const where = ["n.status = 'signed'", "c.kind = 'proc'"];
  if (from) { where.push('n.signed_at >= :from'); params.from = from; }
  if (to) { where.push('n.signed_at < :to'); params.to = to; }
  if (providerUuid) { where.push('u.uuid = :puuid'); params.puuid = providerUuid; }
  // Outstanding-pay view: notes already PAID in a finalized period are excluded, so an admin never sees
  // already-paid RVUs as still owed (paid history lives in the finalized-snapshots list). Same anti-join
  // as the provider payscale — keeps the group total and the per-provider paychecks consistent.
  if (excludePaid) where.push('pnl.note_id IS NULL');
  let facilityJoin = '';
  if (facilityUuid) {
    facilityJoin = 'JOIN provider_facilities pf ON pf.provider_id = n.provider_id JOIN facilities f ON f.id = pf.facility_id';
    where.push('f.uuid = :fuuid'); params.fuuid = facilityUuid;
  }
  const [rows] = await execute(
    `SELECT u.uuid AS provider_uuid, u.full_name_enc, u.credentials, u.role,
            c.code, SUM(COALESCE(c.units, 1)) AS units, m.work_rvu, m.conv_factor, m.status_code
       FROM encounter_notes n
       JOIN users u ON u.id = n.provider_id
       LEFT JOIN paid_note_ledger pnl ON pnl.note_id = n.id
       ${facilityJoin}
       JOIN encounter_note_codes c ON c.note_id = n.id AND c.kind = 'proc'
       LEFT JOIN mpfs_rvu m ON m.hcpcs = c.code AND m.modifier = '' AND m.year = :year
      WHERE ${where.join(' AND ')}
      GROUP BY u.uuid, u.full_name_enc, u.credentials, u.role, c.code, m.work_rvu, m.conv_factor, m.status_code`,
    params);

  const byProv = new Map();
  let datasetCf = null;
  for (const r of rows) {
    if (r.work_rvu == null && r.conv_factor == null) continue;
    if (r.status_code && !PAYABLE_STATUS.has(r.status_code)) continue;
    const work = Number(r.work_rvu) || 0;
    if (work <= 0) continue;
    if (datasetCf == null && Number(r.conv_factor) > 0) datasetCf = Number(r.conv_factor);
    const units = Number(r.units) || 0;
    const p = byProv.get(r.provider_uuid) || { providerUuid: r.provider_uuid, nameEnc: r.full_name_enc, credentials: r.credentials, codes: [] };
    p.codes.push({ work, units });
    byProv.set(r.provider_uuid, p);
  }
  const cf = conversionFactor(cfKind, datasetCf);
  const rate = providerRatePerWorkRvu(cf);
  const providers = [];
  let totalPay = 0, totalEnc = 0;
  for (const p of byProv.values()) {
    let pay = 0, wrvu = 0, enc = 0;
    for (const cc of p.codes) { pay += round2(cc.work * cc.units * rate); wrvu += cc.work * cc.units; enc += cc.units; }
    pay = round2(pay); totalPay += pay; totalEnc += enc;
    let creds = []; try { creds = Array.isArray(p.credentials) ? p.credentials : JSON.parse(p.credentials || '[]'); } catch { creds = []; }
    providers.push({
      providerUuid: p.providerUuid,
      name: p.nameEnc ? (() => { try { return decrypt(p.nameEnc); } catch { return '—'; } })() : '—',
      providerType: providerType(creds),
      encounters: enc, workRvu: round2(wrvu), providerPay: pay,
    });
  }
  providers.sort((a, b) => b.providerPay - a.providerPay);
  return {
    conversionFactor: cf, providerRatePerWorkRvu: rate,
    providerCount: providers.length, totalEncounters: totalEnc, totalPay: round2(totalPay),
    providers,
  };
}

/** Bi-weekly + monthly pay history for a provider (owner-only, real-time). */
export async function providerPayPeriods(providerId, { periodType = 'monthly', count = 6, credentials = [], cfKind = 'standard', localityCode = DEFAULT_LOCALITY, setting = 'facility' } = {}) {
  const periods = buildPeriods(periodType === 'biweekly' ? 'biweekly' : 'monthly', count);
  const out = [];
  // Finalized (locked) periods are served from the IMMUTABLE snapshot, so a paid period never changes when
  // notes are later edited/deleted. Un-finalized periods compute in real time. (Direct table read — avoids
  // a circular import with payrollService.)
  const [snaps] = await execute(
    `SELECT DATE_FORMAT(period_from,'%Y-%m-%d') AS pf, DATE_FORMAT(period_to,'%Y-%m-%d') AS pt,
            provider_pay, group_retained, medicare_value, work_rvu
       FROM pay_period_snapshots WHERE provider_id = :pid AND status = 'finalized'`, { pid: providerId });
  const snapMap = new Map(snaps.map((s) => [`${s.pf}|${s.pt}`, s]));
  for (const p of periods) {
    const snap = snapMap.get(`${p.from}|${p.to}`);
    if (snap) {
      out.push({ label: p.label, from: p.from, to: p.to, providerPay: Number(snap.provider_pay), groupRetained: Number(snap.group_retained), medicareWorkValue: Number(snap.medicare_value), totalWorkRvu: Number(snap.work_rvu), procedureCount: undefined, finalized: true });
    } else {
      const pay = await providerPayscale(providerId, { from: p.from, to: p.to, credentials, cfKind, localityCode, setting });
      out.push({ label: p.label, from: p.from, to: p.to, providerPay: pay.providerPay, groupRetained: pay.groupRetained, medicareWorkValue: pay.medicareWorkValue, totalWorkRvu: pay.totalWorkRvu, procedureCount: pay.procedureCount, finalized: false });
    }
  }
  return {
    periodType: periodType === 'biweekly' ? 'biweekly' : 'monthly',
    providerType: providerType(credentials),
    providerRatePerWorkRvu: providerRatePerWorkRvu(conversionFactor(cfKind)),
    periods: out,
  };
}
