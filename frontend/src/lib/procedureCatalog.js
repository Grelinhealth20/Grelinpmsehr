/**
 * Specialty-focused procedure (CPT/HCPCS) catalog for the appointment procedure
 * picker. The list shown is driven in real time by the rendering provider's
 * specialty. Every code here is also mapped to a Service Type Code on the backend
 * (procedureStc.js) so the eligibility check targets the right benefit category.
 */

const SETS = [
  {
    key: 'pain', label: 'Pain Management',
    kw: ['pain'],
    procs: [
      { code: '20610', desc: 'Major joint injection/aspiration' },
      { code: '20605', desc: 'Intermediate joint injection' },
      { code: '20600', desc: 'Small joint injection' },
      { code: '20552', desc: 'Trigger point injection (1–2 muscles)' },
      { code: '20553', desc: 'Trigger point injection (3+ muscles)' },
      { code: '62321', desc: 'Epidural injection, cervical/thoracic (w/ imaging)' },
      { code: '62323', desc: 'Epidural injection, lumbar/sacral (w/ imaging)' },
      { code: '64483', desc: 'Transforaminal epidural, lumbar (single level)' },
      { code: '64493', desc: 'Facet joint injection, lumbar (single level)' },
      { code: '64405', desc: 'Greater occipital nerve block' },
      { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
    ],
  },
  {
    key: 'snf', label: 'SNF / Nursing Facility',
    kw: ['snf', 'snfs', 'skilled nursing', 'nursing facility', 'geriatric', 'geriatrics', 'internal medicine', 'family medicine', 'hospitalist'],
    procs: [
      { code: '99304', desc: 'Initial nursing facility visit (low)' },
      { code: '99305', desc: 'Initial nursing facility visit (moderate)' },
      { code: '99306', desc: 'Initial nursing facility visit (high)' },
      { code: '99307', desc: 'Subsequent SNF visit (straightforward)' },
      { code: '99308', desc: 'Subsequent SNF visit (expanded)' },
      { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
      { code: '99310', desc: 'Subsequent SNF visit (complex)' },
      { code: '99315', desc: 'Nursing facility discharge (≤30 min)' },
      { code: '99316', desc: 'Nursing facility discharge (>30 min)' },
      { code: '99483', desc: 'Cognitive assessment & care plan' },
      { code: '99497', desc: 'Advance care planning' },
    ],
  },
  {
    key: 'tcm', label: 'Transitional / Chronic Care',
    kw: ['tcm', 'transitional care', 'chronic care', 'ccm'],
    procs: [
      { code: '99495', desc: 'Transitional care mgmt (moderate)' },
      { code: '99496', desc: 'Transitional care mgmt (high)' },
      { code: '99490', desc: 'Chronic care mgmt (20 min staff)' },
      { code: '99491', desc: 'Chronic care mgmt (30 min physician)' },
      { code: '99487', desc: 'Complex chronic care mgmt' },
      { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
    ],
  },
  {
    key: 'pt', label: 'Physical Therapy',
    kw: ['physical therapy', 'pt', 'physiotherapy', 'rehab', 'rehabilitation'],
    procs: [
      { code: '97161', desc: 'PT evaluation (low complexity)' },
      { code: '97162', desc: 'PT evaluation (moderate)' },
      { code: '97163', desc: 'PT evaluation (high)' },
      { code: '97110', desc: 'Therapeutic exercise' },
      { code: '97112', desc: 'Neuromuscular re-education' },
      { code: '97116', desc: 'Gait training' },
      { code: '97140', desc: 'Manual therapy' },
      { code: '97530', desc: 'Therapeutic activities' },
    ],
  },
  {
    key: 'ot', label: 'Occupational Therapy',
    kw: ['occupational therapy', 'ot'],
    procs: [
      { code: '97165', desc: 'OT evaluation (low complexity)' },
      { code: '97166', desc: 'OT evaluation (moderate)' },
      { code: '97167', desc: 'OT evaluation (high)' },
      { code: '97535', desc: 'Self-care/home management training' },
      { code: '97110', desc: 'Therapeutic exercise' },
    ],
  },
  {
    key: 'slp', label: 'Speech Therapy',
    kw: ['speech', 'slp', 'language pathology'],
    procs: [
      { code: '92507', desc: 'Speech/language treatment' },
      { code: '92508', desc: 'Speech/language treatment (group)' },
      { code: '92523', desc: 'Speech sound & language evaluation' },
      { code: '92526', desc: 'Swallowing/feeding treatment' },
      { code: '92610', desc: 'Swallowing evaluation' },
    ],
  },
  {
    key: 'psych', label: 'Behavioral Health',
    kw: ['psychiatry', 'psychology', 'behavioral', 'mental health', 'psych'],
    procs: [
      { code: '90792', desc: 'Psychiatric diagnostic eval (w/ medical)' },
      { code: '90791', desc: 'Psychiatric diagnostic eval' },
      { code: '90832', desc: 'Psychotherapy, 30 min' },
      { code: '90834', desc: 'Psychotherapy, 45 min' },
      { code: '90837', desc: 'Psychotherapy, 60 min' },
      { code: '96130', desc: 'Psychological testing eval' },
    ],
  },
  {
    key: 'wound', label: 'Wound Care',
    kw: ['wound'],
    procs: [
      { code: '11042', desc: 'Debridement, skin/subcutaneous' },
      { code: '11043', desc: 'Debridement, muscle/fascia' },
      { code: '11044', desc: 'Debridement, bone' },
      { code: '97597', desc: 'Wound debridement (≤20 sq cm)' },
      { code: '97598', desc: 'Wound debridement (>20 sq cm)' },
    ],
  },
  {
    key: 'podiatry', label: 'Podiatry',
    kw: ['podiatry', 'podiatric', 'foot', 'ankle'],
    procs: [
      { code: '11055', desc: 'Pare/cut hyperkeratotic lesion (1)' },
      { code: '11056', desc: 'Pare/cut lesions (2–4)' },
      { code: '11720', desc: 'Debride nails (1–5)' },
      { code: '11721', desc: 'Debride nails (6+)' },
      { code: '11730', desc: 'Avulsion of nail plate' },
    ],
  },
];

// Shown when the provider's specialty has no curated set (or no specialty on file).
const GENERAL = [
  { code: '99308', desc: 'Subsequent SNF visit (expanded)' },
  { code: '99309', desc: 'Subsequent SNF visit (detailed)' },
  { code: '99310', desc: 'Subsequent SNF visit (complex)' },
  { code: '99306', desc: 'Initial nursing facility visit (high)' },
  { code: '99315', desc: 'Nursing facility discharge' },
  { code: '99497', desc: 'Advance care planning' },
  { code: '99483', desc: 'Cognitive assessment & care plan' },
];

const matchKw = (name, k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(name);

/**
 * Procedures to offer for a given specialty name (real-time from the selected
 * rendering provider). Returns { label, matched, procedures }.
 */
export function specialtyProcedures(specialtyName) {
  const n = String(specialtyName || '').trim();
  if (n) {
    for (const set of SETS) {
      if (set.kw.some((k) => matchKw(n, k))) {
        return { label: set.label, matched: true, procedures: set.procs };
      }
    }
  }
  return { label: 'General SNF Part B', matched: false, procedures: GENERAL };
}
