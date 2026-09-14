/**
 * Report Excel (.xlsx) export — deterministic, enterprise-grade. Builds properly-formatted workbooks with
 * styled headers and accurate, real data (no mock, no data loss). Two reports, each provider-scoped
 * (own data) or admin-scoped (all / filtered):
 *   • Visit / Encounters report — one row per encounter note (date, patient, MRN, type, POS, status).
 *   • Billing report — per-procedure pay (code, POS, encounters, work RVU, pay) from the RVU payscale.
 * Rows are ORDER BY-ed in SQL and the workbook is built in fixed order, so the output is deterministic.
 */
import ExcelJS from 'exceljs';
import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';
import { providerPayscale, adminProviderPayscale } from './reportsService.js';
import { posSetting, RVU_YEAR, PAYABLE_STATUS, conversionFactor, providerRatePerWorkRvu } from './payscaleConfig.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const POS_NAMES = {
  '02': 'Telehealth (other than home)', '03': 'School', '04': 'Homeless shelter', '09': 'Prison / correctional', '10': 'Telehealth (patient home)',
  '11': 'Office', '12': 'Home', '13': 'Assisted living', '14': 'Group home', '15': 'Mobile unit', '16': 'Temporary lodging', '17': 'Walk-in retail clinic',
  '18': 'Worksite', '19': 'Off-campus outpatient', '20': 'Urgent care', '21': 'Inpatient hospital', '22': 'Hospital outpatient (on-campus)', '23': 'Emergency room',
  '24': 'Ambulatory surgical center', '25': 'Birthing center', '26': 'Military treatment facility', '31': 'Skilled nursing facility', '32': 'Nursing facility',
  '33': 'Custodial care', '34': 'Hospice', '49': 'Independent clinic', '50': 'FQHC', '51': 'Inpatient psychiatric', '52': 'Psychiatric partial hospitalization',
  '53': 'Community mental health center', '54': 'Intermediate care facility (IID)', '55': 'Residential SUD treatment', '56': 'Psychiatric residential treatment',
  '57': 'Non-residential SUD treatment', '61': 'Inpatient rehab facility', '62': 'Outpatient rehab', '65': 'ESRD (dialysis)', '71': 'Public health clinic', '72': 'Rural health clinic',
};
const posLabel = (code) => (code ? `${POS_NAMES[String(code)] || (posSetting(code) === 'facility' ? 'Facility' : 'Office')} (POS ${code})` : '—');
const safeName = (enc) => { try { const d = JSON.parse(decrypt(enc)); return `${d.firstName || ''} ${d.lastName || ''}`.trim() || '—'; } catch { return '—'; } };
const money = (n) => Number(Number(n || 0).toFixed(2));

// ---- data ----------------------------------------------------------------------------------------------
/** Encounter-note rows for the visit/encounters report. providerId → own; else all (admin), optionally by facility. */
export async function encountersRows({ providerId = null, facilityUuid = null, from = null, to = null } = {}) {
  const params = {};
  const where = [];
  if (providerId) { where.push('e.provider_id = :pid'); params.pid = providerId; }
  const dateExpr = 'COALESCE(e.encounter_date, a.appt_date, DATE(e.created_at))';
  if (from) { where.push(`${dateExpr} >= :from`); params.from = from; }
  if (to) { where.push(`${dateExpr} < :to`); params.to = to; }
  let facJoin = '';
  if (facilityUuid) { facJoin = 'JOIN facilities f ON f.id = p.facility_id'; where.push('f.uuid = :fuuid'); params.fuuid = facilityUuid; }
  const [rows] = await execute(
    `SELECT DATE_FORMAT(${dateExpr}, '%Y-%m-%d') AS dos, e.encounter_no, p.mrn, p.demographics_enc,
            u.full_name_enc AS provider_enc, n.note_type, n.pos_code, n.status, DATE_FORMAT(n.signed_at, '%Y-%m-%d') AS signed_date
       FROM encounters e
       LEFT JOIN appointments a ON a.id = e.appointment_id
       LEFT JOIN patients p ON p.id = e.patient_id
       LEFT JOIN users u ON u.id = e.provider_id
       ${facJoin}
       LEFT JOIN encounter_notes n ON n.encounter_id = e.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY dos, e.encounter_no, n.created_at`, params);
  return rows.map((r) => ({
    dos: r.dos || '—',
    patient: r.demographics_enc ? safeName(r.demographics_enc) : '—',
    mrn: r.mrn || '—',
    provider: r.provider_enc ? (() => { try { return decrypt(r.provider_enc); } catch { return '—'; } })() : '—',
    encounterNo: r.encounter_no || '—',
    noteType: r.note_type || '(no note)',
    pos: r.pos_code ? posLabel(r.pos_code) : '—',
    status: r.status === 'signed' ? 'Signed' : r.status === 'draft' ? 'Unsigned' : '—',
    signedDate: r.signed_date || '',
  }));
}

// ---- workbook helpers ----------------------------------------------------------------------------------
function newBook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Grelin Health PMS/EHR';
  wb.created = new Date(Date.UTC(2026, 0, 1)); // fixed → deterministic file metadata
  wb.modified = wb.created;
  return wb;
}
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
const TITLE_FONT = { bold: true, size: 14, color: { argb: 'FF1F3A5F' } };
function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } };
  });
  row.height = 20;
}
function metaBlock(ws, title, meta) {
  ws.mergeCells(1, 1, 1, Math.max(2, Object.keys(meta).length));
  const t = ws.getCell('A1'); t.value = title; t.font = TITLE_FONT;
  let r = 2;
  for (const [k, v] of Object.entries(meta)) { ws.getCell(r, 1).value = k; ws.getCell(r, 1).font = { bold: true, size: 10 }; ws.getCell(r, 2).value = v; ws.getCell(r, 2).font = { size: 10 }; r++; }
  return r + 1; // first data row (after a blank line)
}

/** Visit/Encounters report workbook (Buffer). */
export async function buildEncountersWorkbook({ title, meta, rows }) {
  const wb = newBook();
  const ws = wb.addWorksheet('Encounters', { views: [{ state: 'frozen', ySplit: 0 }] });
  const headerRowIdx = metaBlock(ws, title, meta);
  const cols = [
    { h: 'Date of Service', k: 'dos', w: 16 }, { h: 'Patient', k: 'patient', w: 26 }, { h: 'MRN', k: 'mrn', w: 16 },
    { h: 'Provider', k: 'provider', w: 24 }, { h: 'Encounter #', k: 'encounterNo', w: 16 }, { h: 'Note Type', k: 'noteType', w: 16 },
    { h: 'Place of Service', k: 'pos', w: 26 }, { h: 'Status', k: 'status', w: 12 }, { h: 'Signed Date', k: 'signedDate', w: 14 },
  ];
  const hr = ws.getRow(headerRowIdx);
  cols.forEach((c, i) => { hr.getCell(i + 1).value = c.h; ws.getColumn(i + 1).width = c.w; });
  styleHeaderRow(hr);
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  rows.forEach((row) => { const dr = ws.addRow([]); cols.forEach((c, i) => { dr.getCell(i + 1).value = row[c.k]; }); });
  ws.getCell(ws.rowCount + 1, 1).value = `Total encounters: ${rows.length}`;
  ws.getCell(ws.rowCount, 1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

const fmtAddress = (a) => {
  if (!a) return '';
  if (typeof a === 'string') return a;
  const parts = [a.line1 || a.address1 || a.street, a.line2 || a.address2].filter(Boolean).join(' ');
  const cityLine = [a.city, [a.state, a.zip || a.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [parts, cityLine].filter(Boolean).join(', ');
};

/** DETAILED, UNGROUPED billing/claim rows — ONE row per SIGNED encounter note (its ICDs/CPTs listed in-row). */
export async function billingDetailRows({ providerId = null, facilityUuid = null, from = null, to = null } = {}) {
  const params = {};
  const where = ["n.status = 'signed'"];
  if (providerId) { where.push('n.provider_id = :pid'); params.pid = providerId; }
  const dateExpr = 'COALESCE(e.encounter_date, a.appt_date, DATE(e.created_at))';
  if (from) { where.push(`${dateExpr} >= :from`); params.from = from; }
  if (to) { where.push(`${dateExpr} < :to`); params.to = to; }
  let facJoin = '';
  if (facilityUuid) { facJoin = 'JOIN facilities f ON f.id = p.facility_id'; where.push('f.uuid = :fuuid'); params.fuuid = facilityUuid; }
  const [rows] = await execute(
    `SELECT n.id AS note_id, e.encounter_no, DATE_FORMAT(${dateExpr}, '%Y-%m-%d') AS dos,
            p.mrn, p.demographics_enc, p.insurance_enc, n.pos_code, n.status, n.signed_by_name,
            u.full_name_enc AS provider_enc
       FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN appointments a ON a.id = e.appointment_id
       LEFT JOIN patients p ON p.id = e.patient_id
       LEFT JOIN users u ON u.id = n.provider_id
       ${facJoin}
      WHERE ${where.join(' AND ')}
      ORDER BY dos, e.encounter_no, n.id`, params);
  if (!rows.length) return [];
  // Codes for all notes in ONE query (no N+1), grouped per note into ICD / CPT lists (in-row, not row-grouped).
  const ids = rows.map((r) => r.note_id);
  const inParams = {}; ids.forEach((id, i) => { inParams[`i${i}`] = id; });
  // Procedures are filtered to PAYABLE, non-zero-work-RVU CPT/HCPCS only (join mpfs_rvu): zero-RVU and
  // non-payable (status not A/R/T) codes are removed from the claim's CPT list. Diagnoses (ICDs) keep all.
  const [codeRows] = await execute(
    `SELECT c.note_id, c.kind, c.code, c.modifiers
       FROM encounter_note_codes c
       LEFT JOIN mpfs_rvu m ON m.hcpcs = c.code AND m.modifier = '' AND m.year = :year
      WHERE c.note_id IN (${ids.map((_, i) => `:i${i}`).join(',')})
        AND (c.kind = 'dx' OR (c.kind = 'proc' AND COALESCE(m.work_rvu, 0) > 0 AND m.status_code IN ('A', 'R', 'T')))
      ORDER BY c.note_id, c.kind, c.seq`,
    { ...inParams, year: RVU_YEAR });
  const codesByNote = new Map();
  for (const c of codeRows) {
    const e = codesByNote.get(c.note_id) || { dx: [], proc: [] };
    if (c.kind === 'dx') e.dx.push(c.code);
    else if (c.kind === 'proc') e.proc.push(c.modifiers ? `${c.code}-${c.modifiers}` : c.code);
    codesByNote.set(c.note_id, e);
  }
  return rows.map((r) => {
    const d = r.demographics_enc ? (() => { try { return JSON.parse(decrypt(r.demographics_enc)); } catch { return {}; } })() : {};
    let ins = null;
    if (r.insurance_enc) { try { const raw = JSON.parse(decrypt(r.insurance_enc)); ins = Array.isArray(raw) ? raw[0] : raw; } catch { ins = null; } }
    const codes = codesByNote.get(r.note_id) || { dx: [], proc: [] };
    return {
      mrn: r.mrn || '—',
      encounterId: r.encounter_no || '—',
      patient: `${d.firstName || ''} ${d.lastName || ''}`.trim() || '—',
      dob: d.dob || '',
      gender: d.sex || d.gender || '',
      payer: ins?.payerName || ins?.payer || ins?.planName || '',
      memberId: ins?.memberId || ins?.memberNumber || ins?.subscriberId || ins?.policyNumber || '',
      address: fmtAddress(d.address),
      ssn: d.ssn || '',
      dos: r.dos || '—',
      pos: r.pos_code ? posLabel(r.pos_code) : '—',
      icds: codes.dx.join(', '),
      cpts: codes.proc.join(', '),
      renderingProvider: r.signed_by_name || (r.provider_enc ? (() => { try { return decrypt(r.provider_enc); } catch { return '—'; } })() : '—'),
      signedStatus: 'Signed',
    };
  });
}

/** Detailed billing/claim workbook (Buffer). One row per signed encounter; no grouping. */
export async function buildBillingWorkbook({ title, meta, rows }) {
  const wb = newBook();
  const ws = wb.addWorksheet('Billing', {});
  const headerRowIdx = metaBlock(ws, title, meta);
  const cols = [
    { h: 'MRN', k: 'mrn', w: 16 }, { h: 'Encounter ID', k: 'encounterId', w: 16 }, { h: 'Patient Name', k: 'patient', w: 26 },
    { h: 'DOB', k: 'dob', w: 14 }, { h: 'Gender', k: 'gender', w: 10 }, { h: 'Payer Name', k: 'payer', w: 24 },
    { h: 'Member ID', k: 'memberId', w: 20 }, { h: 'Address', k: 'address', w: 34 }, { h: 'SSN', k: 'ssn', w: 14 },
    { h: 'Date of Service', k: 'dos', w: 16 }, { h: 'Place of Service', k: 'pos', w: 26 }, { h: 'ICDs', k: 'icds', w: 26 },
    { h: 'CPTs & Modifiers', k: 'cpts', w: 26 }, { h: 'Rendering Provider', k: 'renderingProvider', w: 24 }, { h: 'Signed Status', k: 'signedStatus', w: 14 },
  ];
  const hr = ws.getRow(headerRowIdx);
  cols.forEach((c, i) => { hr.getCell(i + 1).value = c.h; ws.getColumn(i + 1).width = c.w; });
  styleHeaderRow(hr);
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  rows.forEach((row) => { const dr = ws.addRow([]); cols.forEach((c, i) => { dr.getCell(i + 1).value = row[c.k]; }); });
  ws.getCell(ws.rowCount + 1, 1).value = `Total encounters: ${rows.length}`;
  ws.getCell(ws.rowCount, 1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

// ---- Processed-RVU detail (payscale) -------------------------------------------------------------------
/**
 * DETAILED processed-RVU rows for the admin payscale download — ONE row per payable procedure line, by DATE
 * OF SERVICE, with the exact pay derivation. Matches the on-screen payscale filters (facility / provider /
 * period) and its outstanding (unpaid) view (excludePaid). Deterministic: SQL ORDER BY + fixed math, no
 * mock. Pay model (CMS 2026 PFS, Central FL): provider pay = round2(Work RVU × units × rate),
 * rate = round(CF × PW-GPCI × 0.60); Medicare Work-RVU value = round2(Work RVU × units × CF);
 * group share (40%) = value − provider pay. Only Work RVU drives pay (PE/MP never do); -TC lines are 0-work
 * and excluded; each code priced against its actual payment modifier (TC/26/base).
 */
export async function payscaleDetailRows({ facilityUuid = null, providerUuid = null, from = null, to = null, cfKind = 'standard', excludePaid = true } = {}) {
  const params = { year: RVU_YEAR };
  const DOS = 'COALESCE(e.encounter_date, a.appt_date, DATE(e.created_at))';
  const where = ["n.status = 'signed'", "c.kind = 'proc'"];
  if (from) { where.push(`${DOS} >= :from`); params.from = from; }
  if (to) { where.push(`${DOS} < :to`); params.to = to; }
  if (providerUuid) { where.push('u.uuid = :puuid'); params.puuid = providerUuid; }
  if (excludePaid) where.push('pnl.note_id IS NULL');
  let facilityJoin = '';
  if (facilityUuid) {
    facilityJoin = 'JOIN provider_facilities pf ON pf.provider_id = n.provider_id JOIN facilities f ON f.id = pf.facility_id';
    where.push('f.uuid = :fuuid'); params.fuuid = facilityUuid;
  }
  const modCase = "CASE WHEN UPPER(COALESCE(c.modifiers,'')) REGEXP '(^|[^A-Z])TC([^A-Z]|$)' THEN 'TC' "
    + "WHEN COALESCE(c.modifiers,'') REGEXP '(^|[^0-9])26([^0-9]|$)' THEN '26' ELSE '' END";
  const [rows] = await execute(
    `SELECT DATE_FORMAT(${DOS}, '%Y-%m-%d') AS dos, e.encounter_no, n.pos_code, u.full_name_enc AS provider_enc,
            c.code, c.modifiers, COALESCE(c.units, 1) AS units, c.seq,
            COALESCE(mm.work_rvu, mb.work_rvu) AS work_rvu, COALESCE(mm.conv_factor, mb.conv_factor) AS conv_factor,
            COALESCE(mm.status_code, mb.status_code) AS status_code
       FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN appointments a ON a.id = e.appointment_id
       JOIN users u ON u.id = n.provider_id
       LEFT JOIN paid_note_ledger pnl ON pnl.note_id = n.id
       ${facilityJoin}
       JOIN encounter_note_codes c ON c.note_id = n.id AND c.kind = 'proc'
       LEFT JOIN mpfs_rvu mm ON mm.hcpcs = c.code AND mm.year = :year AND mm.modifier = ${modCase}
       LEFT JOIN mpfs_rvu mb ON mb.hcpcs = c.code AND mb.year = :year AND mb.modifier = ''
      WHERE ${where.join(' AND ')}
      ORDER BY dos, e.encounter_no, c.seq, c.code`, params);
  // Determine the live dataset CF (same as the payscale service) before computing pay, so the rate is derived.
  let datasetCf = null;
  const payable = [];
  for (const r of rows) {
    const work = Number(r.work_rvu) || 0;
    if (r.status_code && !PAYABLE_STATUS.has(r.status_code)) continue; // non-payable status → not paid
    if (work <= 0) continue;                                           // 0-work (e.g. -TC) → not paid
    if (datasetCf == null && Number(r.conv_factor) > 0) datasetCf = Number(r.conv_factor);
    payable.push({ ...r, work });
  }
  const cf = conversionFactor(cfKind, datasetCf);
  const rate = providerRatePerWorkRvu(cf);
  // Build the lines (DOS order), each with the natural per-line round.
  const lines = payable.map((r) => {
    const units = Number(r.units) || 0;
    const d = new Date(`${r.dos}T00:00:00Z`);
    return {
      _key: `${r.provider_enc || ''}|${r.code}|${r.modifiers || ''}`, _work: r.work, _units: units,
      dos: r.dos || '—',
      month: Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      week: Number.isNaN(d.getTime()) ? '—' : `Week ${Math.min(5, Math.ceil(d.getUTCDate() / 7))}`,
      procedure: r.modifiers ? `${r.code}-${r.modifiers}` : r.code,
      pos: r.pos_code ? posLabel(r.pos_code) : '—',
      encounterId: r.encounter_no || '—',
      provider: r.provider_enc ? (() => { try { return decrypt(r.provider_enc); } catch { return '—'; } })() : '—',
      workRvu: round2(r.work * units),
      providerPay: round2(r.work * units * rate),
      medicareValue: round2(r.work * units * cf),
    };
  });
  // RECONCILE to the paycheck. The payscale table / statement / payroll pay `round2(Σ(work×units) × rate)`
  // PER CODE (round the total). Summing per-line rounds would drift by a few cents, so here the line pays
  // are reconciled to that authoritative per-code total (work RVU is POS-independent → group key is
  // provider+code+modifier): the rounding residual is absorbed by the group's LAST line (standard payroll
  // penny-reconciliation). Result: the detail export's totals equal the actual paycheck to the exact cent.
  const byKey = new Map();
  lines.forEach((l, i) => { if (!byKey.has(l._key)) byKey.set(l._key, []); byKey.get(l._key).push(i); });
  for (const idxs of byKey.values()) {
    const w = lines[idxs[0]]._work;
    const totUnits = idxs.reduce((s, i) => s + lines[i]._units, 0);
    const authPay = round2(w * totUnits * rate);
    const authValue = round2(w * totUnits * cf);
    const sumPay = round2(idxs.reduce((s, i) => s + lines[i].providerPay, 0));
    const sumValue = round2(idxs.reduce((s, i) => s + lines[i].medicareValue, 0));
    const last = idxs[idxs.length - 1];
    lines[last].providerPay = round2(lines[last].providerPay + (authPay - sumPay));     // absorb pay residual
    lines[last].medicareValue = round2(lines[last].medicareValue + (authValue - sumValue)); // absorb value residual
  }
  return lines.map((l) => {
    const groupShare = round2(l.medicareValue - l.providerPay);
    return {
      dos: l.dos, month: l.month, week: l.week, procedure: l.procedure, pos: l.pos,
      encounterId: l.encounterId, provider: l.provider, workRvu: l.workRvu, units: l._units,
      calculation: `${round2(l._work)} Work RVU × ${l._units} unit${l._units === 1 ? '' : 's'} × $${rate.toFixed(4)}/RVU → provider $${l.providerPay.toFixed(2)} (60%), group $${groupShare.toFixed(2)} (40%); Medicare value $${l.medicareValue.toFixed(2)}`,
      groupShare, providerPay: l.providerPay, cf, rate,
    };
  });
}

const MONEY_FMT = '$#,##0.00';
const RVU_FMT = '0.00';
/** Processed-RVU detail workbook (Buffer) — Month · Week · Procedure · POS · Encounter · Provider · Work
 *  RVUs · Calculations · Group Share (40%) · Provider Pay (60%). Deterministic; currency-formatted; totals. */
export async function buildPayscaleDetailWorkbook({ title, meta, rows }) {
  const wb = newBook();
  const ws = wb.addWorksheet('Processed RVUs', {});
  const headerRowIdx = metaBlock(ws, title, meta);
  const cols = [
    { h: 'Month', k: 'month', w: 18 }, { h: 'Week', k: 'week', w: 10 }, { h: 'Date of Service', k: 'dos', w: 16 },
    { h: 'Procedure', k: 'procedure', w: 16 }, { h: 'Place of Service', k: 'pos', w: 26 }, { h: 'Encounter', k: 'encounterId', w: 18 },
    { h: 'Provider', k: 'provider', w: 24 }, { h: 'Work RVUs', k: 'workRvu', w: 12, num: RVU_FMT },
    { h: 'Calculation', k: 'calculation', w: 62 }, { h: 'Group Share (40%)', k: 'groupShare', w: 16, num: MONEY_FMT },
    { h: 'Provider Pay (60%)', k: 'providerPay', w: 18, num: MONEY_FMT },
  ];
  const hr = ws.getRow(headerRowIdx);
  cols.forEach((c, i) => { hr.getCell(i + 1).value = c.h; ws.getColumn(i + 1).width = c.w; if (c.num) ws.getColumn(i + 1).numFmt = c.num; });
  styleHeaderRow(hr);
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  let tW = 0, tG = 0, tP = 0;
  rows.forEach((row) => {
    const dr = ws.addRow([]);
    cols.forEach((c, i) => { dr.getCell(i + 1).value = c.num ? Number(row[c.k]) || 0 : row[c.k]; });
    tW += Number(row.workRvu) || 0; tG += Number(row.groupShare) || 0; tP += Number(row.providerPay) || 0;
  });
  const tr = ws.getRow(ws.rowCount + 1);
  tr.getCell(1).value = `Total — ${rows.length} processed line${rows.length === 1 ? '' : 's'}`;
  tr.getCell(8).value = round2(tW); tr.getCell(8).numFmt = RVU_FMT;
  tr.getCell(10).value = round2(tG); tr.getCell(10).numFmt = MONEY_FMT;
  tr.getCell(11).value = round2(tP); tr.getCell(11).numFmt = MONEY_FMT;
  tr.eachCell((cell) => { cell.font = { bold: true }; });
  return wb.xlsx.writeBuffer();
}

export { providerPayscale, adminProviderPayscale };
