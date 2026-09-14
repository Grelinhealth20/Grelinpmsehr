/**
 * Payscale configuration — Central Florida RVU Provider Compensation, CY2026.
 * Mirrors the group's authoritative workbook (FL_RVU_Provider_Compensation_2026). Priced for CMS locality
 * **Rest of Florida (99)** — Brevard County and all of Central Florida — with the other two Florida
 * localities available to enable if the group bills there.
 *
 * COMPENSATION MODEL (exact, per the workbook) — the split is on the WORK-RVU VALUE, not the full fee:
 *   Medicare Work-RVU value = Work RVU × PW GPCI(1.000) × Conversion Factor
 *   Provider payment        = Encounters × Work RVU × ProviderRate,  ProviderRate = PROVIDER_SHARE × CF
 *   Group retained          = Medicare Work-RVU value − Provider payment  (= GROUP_SHARE × Work-RVU value)
 *   → 60% of the Work-RVU value to the rendering provider, 40% to the group. ONLY the Work RVU drives pay;
 *     practice-expense and malpractice RVUs never enter provider pay (they only affect the reference fee).
 *
 * NOTHING IS STATIC: the conversion factor is read from the loaded CMS dataset (mpfs_rvu.conv_factor,
 * CMS RVU26C July-2026 — e.g. 33.4009), and the provider rate is DERIVED as PROVIDER_SHARE × CF at query
 * time (→ $20.0405 for the standard CF). RVUs + status indicator also come from the dataset. Payable codes
 * only (CMS status A/R/T with non-zero work RVU).
 */

export const RVU_YEAR = Number(process.env.PAYSCALE_RVU_YEAR || 2026);

// Florida Medicare localities (CY2026 Final GPCI Addendum E + CMS 26LOCCO county map). PW (work) GPCI is
// the 1.000 statutory floor in every FL locality → GPCI never changes provider pay, only the reference
// full FL physician fee (which includes PE/MP). Default = 99 (Central Florida / Brevard).
export const LOCALITIES = Object.freeze({
  '99': { code: '99', name: 'Rest of Florida (Central Florida — incl. Brevard County)', carrier: '09102', gpci: { work: 1.000, pe: 0.956, mp: 1.503 },
    counties: ['Brevard', 'Orange', 'Osceola', 'Seminole', 'Lake', 'Volusia', 'Polk', 'Hillsborough', 'Pinellas', 'Pasco', 'and all other non-South-Florida counties'] },
  '03': { code: '03', name: 'Fort Lauderdale', carrier: '09102', gpci: { work: 1.000, pe: 1.013, mp: 1.808 },
    counties: ['Broward', 'Collier', 'Indian River', 'Lee', 'Martin', 'Palm Beach', 'St. Lucie'] },
  '04': { code: '04', name: 'Miami', carrier: '09102', gpci: { work: 1.000, pe: 1.041, mp: 2.529 },
    counties: ['Miami-Dade', 'Monroe'] },
});
export const DEFAULT_LOCALITY = process.env.PAYSCALE_LOCALITY || '99';
export function localityFor(code) { return LOCALITIES[code] || LOCALITIES[DEFAULT_LOCALITY]; }

// CY2026 conversion factors (CMS RVU files). `standard` matches the dataset's mpfs_rvu.conv_factor and is
// the one used unless a provider is a qualifying APM participant. Used only as a fallback — the service
// reads the live CF from the dataset so nothing is hard-pinned.
export const CONVERSION_FACTORS = Object.freeze({ standard: 33.4009, apm: 33.5675 });
export function conversionFactor(kind = 'standard', datasetCf = null) {
  if (kind === 'apm') return CONVERSION_FACTORS.apm;
  return Number(datasetCf) > 0 ? Number(datasetCf) : CONVERSION_FACTORS.standard; // prefer the live dataset CF
}

// Revenue split (on the Work-RVU value). Provider rate is DERIVED — never hardcoded — from the live CF and
// the locality's WORK GPCI: rate = PROVIDER_SHARE × CF × PW-GPCI. In every Florida locality PW-GPCI is the
// 1.000 statutory floor, so the rate is $20.0405 at the standard CF (unchanged); in a county/state whose
// PW-GPCI ≠ 1.000 the rate scales geographically, so pay is accurate everywhere — nothing is static.
export const PROVIDER_SHARE = Number(process.env.PAYSCALE_PROVIDER_SHARE || 0.60);
export const GROUP_SHARE = Math.round((1 - PROVIDER_SHARE) * 1e6) / 1e6;
export function providerRatePerWorkRvu(cf, workGpci = 1) {
  return Math.round(Number(cf) * (Number(workGpci) || 1) * PROVIDER_SHARE * 1e4) / 1e4; // 4 dp
}

/**
 * The CMS payment modifier that changes a procedure's WORK RVU: TC (technical component — no physician
 * work, work RVU 0) and 26 (professional component). Informational modifiers (25, 59, 57, 24, 76, …) do
 * NOT have their own RVU row — they price at the global/base ('') row, which is the CMS-correct behavior.
 * A procedure billed -TC must be paid on the -TC row (0 work → $0 to the provider), never the global row.
 */
export function pricingModifier(modifiers) {
  const s = String(modifiers || '').toUpperCase();
  if (/(^|[^A-Z])TC([^A-Z]|$)/.test(s)) return 'TC';
  if (/(^|\D)26(\D|$)/.test(s)) return '26';
  return '';
}

// MPFS status indicators separately payable by RVUs (A active, R restricted-coverage, T same-day-only).
export const PAYABLE_STATUS = new Set(['A', 'R', 'T']);

// ---- CMS Place of Service (POS) → practice-expense setting -------------------------------------------
// Every CMS POS code classified as 'facility' (facility PE RVU applies) or 'office' (non-facility PE RVU),
// per CMS MPFS site-of-service policy. This drives which PE RVU is used in the Medicare allowed amount for
// ANY place of service. (Note the subtle CMS split: 31 SNF = facility, 32 Nursing Facility = non-facility;
// 02 telehealth-not-home = facility, 10 telehealth-in-home = non-facility.)
const POS_FACILITY = new Set([
  '02', '19', '21', '22', '23', '24', '26', '31', '34', '41', '42', '51', '52', '53', '56', '61',
]);
const POS_NONFACILITY = new Set([
  '01', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18',
  '20', '25', '27', '32', '33', '49', '50', '54', '55', '57', '58', '60', '62', '65', '71', '72', '99',
]);
/** Facility vs non-facility PE setting for a CMS POS code (defaults to non-facility/office if unknown). */
export function posSetting(code) {
  const c = String(code || '').replace(/\D/g, '').padStart(2, '0').slice(-2);
  if (POS_FACILITY.has(c)) return 'facility';
  if (POS_NONFACILITY.has(c)) return 'office';
  return 'office';
}

/**
 * The default POS code for a note type when one is not explicitly set on the note. SNF Part B E/M
 * (the universal note types) → 31 (SNF); Pain/PI/TCM office visits → 11 (office); telehealth → 02
 * (facility-originating) or 10 (home, for pain/PI). Used to SEED encounter_notes.pos_code at creation;
 * the provider can override it to any CMS POS (11, 12, 31, 32, 10, …).
 */
export function posForNoteType(noteType, dflt = '31') {
  const nt = String(noteType || '');
  if (/telehealth/i.test(nt)) return (nt.startsWith('pain_') || nt.startsWith('pi_')) ? '10' : '02';
  if (nt.startsWith('pain_') || nt.startsWith('pi_') || nt.startsWith('tcm_')) return '11';
  if (['hp', 'soap', 'progress', 'discharge', 'acuteChange', 'acp', 'hospice', 'custom'].includes(nt)) return '31';
  return dflt;
}

/**
 * BACKUP Place-of-Service identification from the DOCUMENTED record — used only when the provider has NOT
 * explicitly set a POS on the note. DETERMINISTIC and evidence-based: it reads the note's own text and
 * returns the CMS POS that the documentation actually states (telehealth / SNF / nursing facility / office
 * / home / inpatient / ER / …), ordered most-specific first. It NEVER fabricates: with no explicit POS in
 * the text it returns the compliance-safe note-type default (posForNoteType) — the same seed used at note
 * creation — which the provider/coder can override. The explicit `encounter_notes.pos_code` always wins;
 * this is the fallback so the POS-authoritative E/M and the POS shown on billing are accurate in real time.
 */
function posRecordText(content) {
  if (!content || typeof content !== 'object') return '';
  const parts = [];
  const walk = (v) => { if (typeof v === 'string') parts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(content.sections); walk(content.encounterType); walk(content.reason);
  return parts.join('  ').toLowerCase();
}
// Ordered, evidence-based POS rules (CMS POS set). FIRST match wins, so the list is MOST-SPECIFIC first —
// a facility type that contains a generic word ("skilled NURSING FACILITY", "rural health CLINIC") is placed
// before the generic term it contains. Telehealth is handled separately (modality overrides location).
// MAJOR, specialty-aligned CMS POS only (SNF / Pain / PI) — the same set the note-editor POS picker offers.
// A location outside this set (school, prison, dialysis, psych, FQHC, …) is not something this practice
// bills, so it is NOT force-detected; it falls through to the compliance-safe note-type default instead.
const POS_RULES = [
  ['31', /\bskilled nursing\b|\bs\.?n\.?f\b|\bsub-?acute (rehab|unit|care|nursing)\b|\bsnf\b/],           // Skilled nursing facility
  ['32', /\bnursing facility\b|\blong[- ]?term care\b|\bl\.?t\.?c\b|\bltc\b|\bnursing home\b/],           // Nursing facility
  ['33', /\bcustodial care\b|\bcustodial (facility|nursing)\b/],                                          // Custodial care facility
  ['13', /\bassisted living\b|\ba\.?l\.?f\b|\balf\b/],                                                    // Assisted living facility
  ['34', /\bhospice\b|\bend-?of-?life care\b/],                                                           // Hospice
  ['62', /\b(comprehensive )?outpatient rehab(ilitation)?\b|\bcorf\b|\boutpatient (pt|physical therapy|ot|occupational therapy)\b/], // Outpatient rehab
  ['24', /\bambulatory surgical center\b|\basc\b|\bsurgery center\b|\boutpatient surgery center\b/],       // Ambulatory surgical center
  ['23', /\bemergency (department|room|dept)\b|\be\.?d\.? visit\b|\be\.?r\.? visit\b|\bemergency room\b/], // Emergency room
  ['22', /\b(on-?campus )?hospital outpatient\b|\bhospital outpatient (department|clinic)\b|\bopd\b/],     // Hospital outpatient
  ['21', /\binpatient\b|\badmitted to (the )?hospital\b|\bhospital (ward|floor|service|admission|inpatient)\b|\bacute care hospital\b/], // Inpatient hospital
  ['12', /\b(home visit|house call|seen at home|in the (patient'?s )?home|homebound|patient'?s residence|at the residence)\b/], // Home
  ['11', /\b(office visit|in[- ]?office|clinic visit|in (the )?clinic|outpatient office|physician office|private office)\b/],   // Office
];
export function detectPosFromRecord(content, noteType) {
  const t = posRecordText(content);
  if (t) {
    // Telehealth first — the MODALITY overrides the physical-location words that may also appear in the note.
    if (/\btelehealth\b|\bvideo visit\b|\bvirtual visit\b|\btele[- ]?health\b|\btelemedicine\b/.test(t)) {
      return /\b(home|patient'?s home|in[- ]?home|residence|at home)\b/.test(t) ? '10' : '02';
    }
    for (const [code, re] of POS_RULES) { if (re && re.test(t)) return code; }
  }
  return posForNoteType(noteType); // no explicit evidence → compliance-safe note-type default (never fabricated)
}

// Provider type from credentials — reported for transparency. The workbook applies the SAME $/Work-RVU
// rate to every provider (Medicare's NPP 85% differential is about what Medicare pays an NPP, not this
// group's internal Work-RVU rate), so this labels the provider without changing comp.
const PHYSICIAN = new Set(['MD', 'DO', 'MBBS']);
const NPP = new Set(['NP', 'APRN', 'FNP', 'AGNP', 'AGACNP', 'ACNP', 'PMHNP', 'DNP', 'PA', 'PAC', 'CNS', 'CRNA', 'CNM']);
export function providerType(credentials = []) {
  const creds = (Array.isArray(credentials) ? credentials : []).map((c) => String(c).toUpperCase().replace(/[^A-Z]/g, ''));
  if (creds.some((c) => PHYSICIAN.has(c))) return 'physician';
  if (creds.some((c) => NPP.has(c))) return 'npp';
  return 'unspecified';
}
