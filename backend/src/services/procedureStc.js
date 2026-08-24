/**
 * Procedure (CPT/HCPCS) → X12 Service Type Code (STC) mapping for SNF Part B.
 *
 * Stedi's payer network reliably answers eligibility at the SERVICE TYPE CODE
 * level, and (except CMS HETS) will not accept a procedure code and an STC in the
 * same request. So to get "procedure-specific" benefits we map the billed
 * procedure to the STC its benefits live under and request THAT STC (alongside the
 * base "30" health-plan inquiry). The 271's per-service breakdown then carries the
 * cost-share for that category.
 *
 * STC references (X12 271 EB03 service type codes):
 *   98 Professional (Physician) Visit - Office   1  Medical Care
 *   MH Mental Health                             PT Physical Therapy
 *   AD Occupational Therapy                      AF Speech Therapy
 *   5  Diagnostic Lab                            4  Diagnostic X-Ray
 */

// Exact CPT/HCPCS → STC. Codes are matched as strings (leading zeros preserved).
// EXPLICIT mappings only — every entry is a known code with a definite service
// category. Unlisted codes resolve to null (no range/category guessing).
const EXACT = {
  // --- Evaluation & Management (SNF + office/outpatient) -> Physician Visit ---
  '99202': '98', '99203': '98', '99204': '98', '99205': '98',
  '99211': '98', '99212': '98', '99213': '98', '99214': '98', '99215': '98',
  '99304': '98', '99305': '98', '99306': '98',
  '99307': '98', '99308': '98', '99309': '98', '99310': '98',
  '99315': '98', '99316': '98', '99318': '98',
  '99483': '98', '99497': '98', '99498': '98',
  // --- Behavioral / mental health -> MH ---
  '90791': 'MH', '90792': 'MH', '90832': 'MH', '90833': 'MH', '90834': 'MH',
  '90836': 'MH', '90837': 'MH', '90838': 'MH', '90853': 'MH',
  '96130': 'MH', '96131': 'MH', '96132': 'MH', '96133': 'MH', '96136': 'MH', '96137': 'MH',
  // --- Wound care / debridement -> Medical Care ---
  '11042': '1', '11043': '1', '11044': '1', '11045': '1', '11046': '1', '11047': '1',
  '97597': '1', '97598': '1', '97602': '1',
  // --- Injections / minor procedures -> Medical Care ---
  '20610': '1', '20611': '1', '96372': '1', '96373': '1', '96374': '1',
  // --- Pain management (injections, joint/epidural/facet/nerve blocks) -> Medical Care ---
  '20600': '1', '20604': '1', '20605': '1', '20606': '1', '20552': '1', '20553': '1',
  '62321': '1', '62323': '1', '62322': '1', '62320': '1',
  '64483': '1', '64484': '1', '64493': '1', '64494': '1', '64495': '1',
  '64405': '1', '64450': '1', '64415': '1', '64416': '1',
  // --- Transitional / Chronic Care Management -> Physician Visit ---
  '99495': '98', '99496': '98', '99490': '98', '99491': '98', '99487': '98', '99489': '98',
  // --- Podiatry (nail/callus care) -> Medical Care ---
  '11055': '1', '11056': '1', '11057': '1', '11719': '1', '11720': '1', '11721': '1', '11730': '1',
  // --- Physical therapy -> PT ---
  '97110': 'PT', '97112': 'PT', '97116': 'PT', '97140': 'PT', '97150': 'PT',
  '97530': 'PT', '97535': 'PT', '97542': 'PT', '97750': 'PT',
  '97161': 'PT', '97162': 'PT', '97163': 'PT', '97164': 'PT',
  // --- Occupational therapy -> AD ---
  '97165': 'AD', '97166': 'AD', '97167': 'AD', '97168': 'AD', '97169': 'AD',
  // --- Speech therapy -> AF ---
  '92507': 'AF', '92508': 'AF', '92521': 'AF', '92522': 'AF', '92523': 'AF',
  '92524': 'AF', '92526': 'AF', '92610': 'AF',
  // --- Common labs -> Diagnostic Lab ---
  '80048': '5', '80053': '5', '80061': '5', '81000': '5', '81001': '5',
  '83036': '5', '85025': '5', '84443': '5',
  // --- Common imaging -> Diagnostic X-Ray ---
  '71045': '4', '71046': '4', '73030': '4', '73130': '4', '73610': '4', '76700': '4',
};

const STC_LABEL = {
  '98': 'Physician office visit', '1': 'Medical care', 'MH': 'Mental health',
  'PT': 'Physical therapy', 'AD': 'Occupational therapy', 'AF': 'Speech therapy',
  '5': 'Diagnostic lab', '4': 'Diagnostic X-ray', '30': 'Health benefit plan',
};

/**
 * Resolve a single procedure code to its STC using the EXPLICIT map only — no
 * range guessing or category fallback. Any code not in the map returns null
 * (e.g. the invalid "99999", HCPCS letter codes, junk); the caller then runs a
 * plan-level (STC 30) check and flags the code as unmapped rather than guessing.
 */
export function stcForProcedure(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return EXACT[c] || null; // explicit mappings only — no range/category fallback
}

export function stcLabel(stc) {
  return STC_LABEL[stc] || stc;
}

/**
 * Map a list of procedure codes to the STCs to request.
 * @returns {{ stcs: string[], resolved: {code,stc,label}[], unmapped: string[] }}
 */
export function stcsForProcedures(codes = []) {
  const resolved = [];
  const unmapped = [];
  const stcs = new Set();
  for (const raw of codes) {
    const code = String(raw || '').trim();
    if (!code) continue;
    const stc = stcForProcedure(code);
    if (stc) { resolved.push({ code, stc, label: stcLabel(stc) }); stcs.add(stc); }
    else unmapped.push(code);
  }
  return { stcs: [...stcs], resolved, unmapped };
}

/** Common SNF Part B procedures for the UI picker (code + description + STC). */
export const COMMON_PROCEDURES = [
  { code: '99306', desc: 'Initial nursing facility visit' },
  { code: '99308', desc: 'Subsequent SNF visit (expanded)' },
  { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
  { code: '99310', desc: 'Subsequent SNF visit (complex)' },
  { code: '99315', desc: 'Nursing facility discharge' },
  { code: '99497', desc: 'Advance care planning' },
  { code: '99483', desc: 'Cognitive assessment & care plan' },
  { code: '90792', desc: 'Psychiatric diagnostic evaluation' },
  { code: '97110', desc: 'Therapeutic exercise (PT)' },
  { code: '97530', desc: 'Therapeutic activities (PT)' },
  { code: '97165', desc: 'Occupational therapy evaluation' },
  { code: '92507', desc: 'Speech/language treatment' },
  { code: '11042', desc: 'Wound debridement' },
  { code: '20610', desc: 'Major joint injection/aspiration' },
].map((p) => ({ ...p, stc: stcForProcedure(p.code), stcLabel: stcLabel(stcForProcedure(p.code)) }));
