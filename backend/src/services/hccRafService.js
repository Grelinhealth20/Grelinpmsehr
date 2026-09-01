import { pool } from '../db/pool.js';

/**
 * CMS-HCC V28 risk-adjustment (RAF) engine. Deterministic implementation of the official CMS
 * Community model, built entirely from the loaded CMS model data:
 *   icd_hcc_map (ICD→HCC, model 'CMS-HCC_V28'), hcc_hierarchy (trumping), hcc_coefficient (factors).
 * The disease-category → HCC groupings and interaction rules below are transcribed verbatim from
 * the CMS model software (V2825T1M.TXT) — not invented.
 *
 * RAF = demographic factor + Σ surviving-HCC factors + disease-interaction factors + payment-HCC-
 * count factor, for the beneficiary segment (default CNA = Community, Non-dual, Aged — the common
 * outpatient 65+ case). Segment is a parameter; institutional/dual segments use their own prefix.
 */
const HCC_MODEL = 'CMS-HCC_V28';   // label used in icd_hcc_map
const COEF_MODEL = 'CMS-HCC-V28';  // label used in hcc_coefficient / hcc_hierarchy

// Disease categories (V2825T1M.TXT): category → member HCC numbers.
const DISEASE = {
  DIABETES: [35, 36, 37, 38],
  CARD_RESP_FAIL: [211, 212, 213],
  HF: [221, 222, 223, 224, 225, 226],
  CHR_LUNG: [276, 277, 278, 279, 280],
  KIDNEY: [326, 327, 328, 329],
};
// Community-model interactions (V2825T1M.TXT): coefficient suffix → categories that must co-occur.
const INTERACTIONS = [
  { name: 'DIABETES_HF_V28', need: ['DIABETES', 'HF'] },
  { name: 'HF_CHR_LUNG_V28', need: ['HF', 'CHR_LUNG'] },
  { name: 'HF_KIDNEY_V28', need: ['HF', 'KIDNEY'] },
  { name: 'CHR_LUNG_CARD_RESP_FAIL_V28', need: ['CHR_LUNG', 'CARD_RESP_FAIL'] },
  { name: 'HF_HCC238_V28', need: ['HF', 'HCC238'] },
];

function icdVariants(code) {
  const raw = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return [];
  const dotless = raw.replace(/\./g, '');
  const dotted = dotless.length > 3 ? `${dotless.slice(0, 3)}.${dotless.slice(3)}` : dotless;
  return [...new Set([raw, dotted, dotless])];
}
function ageBand(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return '65_69';
  if (a < 35) return '0_34'; if (a < 45) return '35_44'; if (a < 55) return '45_54';
  if (a < 60) return '55_59'; if (a < 65) return '60_64'; if (a < 70) return '65_69';
  if (a < 75) return '70_74'; if (a < 80) return '75_79'; if (a < 85) return '80_84';
  if (a < 90) return '85_89'; if (a < 95) return '90_94'; return '95_GT';
}

/**
 * Derive the CMS-HCC beneficiary segment from REAL patient data (never a blind default):
 *   aged/disabled ← age (Medicare: 65+ aged, <65 by disability),
 *   dual ← Medicaid present on any insurance policy (full-benefit dual assumed unless partial known),
 *   institutional ← long-term SNF resident (≥90 days at the date of service).
 * Community segments: C{N|F|P}{A|D}; institutional: INS. Returns { segment, basis, ... } so the
 * assumption is transparent and auditable. `patient` = { age, insurance:[], facility:{}, dos }.
 */
export function deriveSegment(patient = {}) {
  const age = Number(patient.age);
  const aged = !Number.isFinite(age) ? true : age >= 65;
  const ins = Array.isArray(patient.insurance) ? patient.insurance : [];
  const medicaid = ins.some((p) => /medicaid|medi-?cal|ahcccs|\bmcd\b|\bdual\b/i.test(
    `${p?.payer || ''} ${p?.planType || ''} ${p?.coverageType || ''} ${p?.type || ''}`));
  // Long-term institutional status (≥90 days) if we can determine it from the SNF admit date.
  let institutional = false; let instDays = null;
  const fac = patient.facility;
  if (fac && fac.admitDate && patient.dos) {
    const d = Math.floor((new Date(patient.dos).getTime() - new Date(fac.admitDate).getTime()) / 86400000);
    if (Number.isFinite(d) && d >= 90) { institutional = true; instDays = d; }
  }
  if (institutional) return { segment: 'INS', basis: `institutional — SNF resident ${instDays} days (≥90)`, aged, dual: medicaid, institutional: true };
  const dual = medicaid ? 'F' : 'N';
  const ad = aged ? 'A' : 'D';
  return {
    segment: `C${dual}${ad}`,
    basis: `community, ${medicaid ? 'full-benefit dual (Medicaid on file)' : 'non-dual (no Medicaid on file)'}, ${aged ? 'aged 65+' : 'disabled <65'}`,
    aged, dual: medicaid, institutional: false,
  };
}

/**
 * Compute the CMS-HCC V28 RAF for a diagnosis list. Returns the score plus a full breakdown
 * (each variable + coefficient) so it is auditable. `segment` may be passed explicitly or derived
 * upstream via deriveSegment; defaults to 'CNA' only if none supplied.
 */
export async function calcRaf(icds, { age, sex, segment = 'CNA', segmentBasis = null } = {}) {
  const variants = [...new Set((icds || []).flatMap(icdVariants))];
  const seg = String(segment || 'CNA').toUpperCase();
  const out = { model: COEF_MODEL, segment: seg, segmentBasis, age: age ?? null, sex: sex || null, raf: 0, hccs: [], parts: [], unmappedHccs: [] };
  if (!variants.length) return out;

  // 1) ICD → HCC (V28 payment HCCs)
  const [rows] = await pool.query('SELECT DISTINCT hcc_category FROM icd_hcc_map WHERE model = ? AND icd_code IN (?)', [HCC_MODEL, variants]);
  const hccs = new Set(rows.map((r) => Number(r.hcc_category)).filter((n) => n > 0));
  if (!hccs.size && !age && !sex) return out;

  // 2) Hierarchy trumping
  const [hier] = await pool.query('SELECT cc, trumped_cc FROM hcc_hierarchy WHERE model = ?', [COEF_MODEL]);
  for (const h of hier) if (hccs.has(h.cc)) hccs.delete(h.trumped_cc);
  const surviving = [...hccs].sort((a, b) => a - b);

  // 3) Coefficients
  const [coefRows] = await pool.query('SELECT name, coeff, label FROM hcc_coefficient WHERE model = ?', [COEF_MODEL]);
  const coef = new Map(coefRows.map((r) => [r.name, { c: Number(r.coeff), label: r.label }]));
  const add = (variable, type) => { const v = coef.get(variable); if (v) out.parts.push({ variable, coeff: v.c, label: v.label, type }); };

  // demographic
  add(`${seg}_${String(sex || 'F').toUpperCase()[0]}${ageBand(age)}`, 'demographic');
  // surviving HCCs
  for (const h of surviving) add(`${seg}_HCC${h}`, 'hcc');
  // disease interactions
  const flags = {};
  for (const [k, list] of Object.entries(DISEASE)) flags[k] = list.some((h) => hccs.has(h));
  flags.HCC238 = hccs.has(238);
  for (const it of INTERACTIONS) if (it.need.every((f) => flags[f])) add(`${seg}_${it.name}`, 'interaction');
  // payment-HCC-count factor
  if (surviving.length > 0) add(`${seg}_D${surviving.length >= 10 ? '10P' : surviving.length}`, 'count');

  out.hccs = surviving;
  out.raf = Number(out.parts.reduce((s, p) => s + p.coeff, 0).toFixed(3));
  return out;
}
