/**
 * CMS-compliant SNF MD note templates (US standard). Each template is an ordered
 * list of section keys; the editor renders empty fields with clinical guidance
 * prompts — NO pre-filled or fabricated clinical data. Section keys match the
 * backend Word-document generator (noteDocumentService.js) exactly.
 */

export const NOTE_TYPES = {
  hp_admission: { label: 'H&P / Admission Note', category: 'Initial Nursing Facility Care', cpt: '99304–99306' },
  progress: { label: 'Progress Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310' },
  acute_visit: { label: 'Acute / Sick Visit Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310' },
  change_in_condition: { label: 'Change in Condition Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310' },
  follow_up: { label: 'Follow-Up Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310' },
  regulatory: { label: 'Regulatory / Periodic Visit Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310' },
  post_hospital: { label: 'Post-Hospital / Readmission Note', category: 'Initial or Subsequent (per circumstances)', cpt: '99304–99310' },
  medication: { label: 'Medication Management Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310' },
  lab_imaging: { label: 'Lab / Imaging Review Note', category: 'Subsequent / per service', cpt: '99307–99310' },
  wound_care: { label: 'Wound Care Note', category: 'Subsequent / Specialized service', cpt: '99307–99310' },
  advance_care: { label: 'Advance Care Planning Note', category: 'Separately reportable (ACP)', cpt: '99497–99498' },
  discharge: { label: 'Discharge Summary', category: 'Nursing Facility Discharge', cpt: '99315–99316' },
  death: { label: 'Death / Expiration Note', category: 'As applicable', cpt: '—' },
};

// Simplified provider menu (primary choices) + the rest under "More".
export const NOTE_MENU = ['hp_admission', 'progress', 'acute_visit', 'regulatory', 'post_hospital', 'wound_care', 'discharge'];
export const NOTE_MENU_MORE = ['change_in_condition', 'follow_up', 'medication', 'lab_imaging', 'advance_care', 'death'];

// Reason-for-encounter options for a Progress Note (structured coding data).
export const PROGRESS_REASONS = [
  'Routine follow-up', 'Change in condition', 'Medication management', 'Lab / imaging review',
  'Diabetes management', 'Hypertension', 'CHF', 'COPD', 'Pain management', 'Fall follow-up',
  'Behavioral / psychiatric', 'Anticoagulation', 'Wound follow-up', 'Other',
];

export const SECTION_LABELS = {
  chiefComplaint: 'Chief Complaint / Reason for Encounter',
  changeDescription: 'Description of Change in Condition',
  hpi: 'History of Present Illness',
  interval: 'Interval History',
  hospitalCourse: 'Hospital Course',
  ros: 'Review of Systems',
  pmh: 'Past Medical History',
  psh: 'Past Surgical History',
  familyHistory: 'Family History',
  socialHistory: 'Social History',
  medications: 'Current Medications',
  medChanges: 'Medication Changes',
  allergies: 'Allergies',
  adverseEffects: 'Adverse Effects / Tolerability',
  vitals: 'Vital Signs',
  exam: 'Physical Examination',
  wound: 'Wound Assessment',
  treatment: 'Wound Treatment / Dressing',
  results: 'Labs / Imaging Reviewed',
  carePlanReview: 'Care Plan Review',
  assessment: 'Assessment (Problem List & Status)',
  mdm: 'Medical Decision Making',
  plan: 'Plan',
  orders: 'New / Changed Orders',
  notifications: 'Notifications (Family / NP / Attending)',
  prognosis: 'Prognosis',
  goals: 'Goals of Care Discussion',
  participants: 'Participants in Discussion',
  decisionsMade: 'Decisions Made',
  codeStatus: 'Code Status',
  advanceDirective: 'Advance Directive Status',
  dischargeDiagnoses: 'Discharge Diagnoses',
  procedures: 'Procedures / Treatments During Stay',
  functionalStatus: 'Functional Status',
  dischargeMeds: 'Discharge Medication Reconciliation',
  disposition: 'Disposition',
  followUp: 'Follow-Up Plan',
  dischargeInstructions: 'Discharge Instructions',
  careCoordination: 'Care Coordination',
  pronouncement: 'Pronouncement of Death',
  circumstances: 'Circumstances',
  causeOfDeath: 'Cause of Death',
  regulatoryAttestation: 'Regulatory Attestation',
  timeSpent: 'Total Time & Attestation',
  addendum: 'Additional Notes',
};

export const SECTION_PROMPTS = {
  chiefComplaint: 'Primary reason for this encounter…',
  changeDescription: 'Acute change: onset, severity, associated symptoms, precipitating factors…',
  hpi: 'Onset, location, duration, character, aggravating/relieving factors, timing, severity, associated symptoms…',
  interval: 'Interval events since last visit; status of active problems; new complaints; nursing/therapy reports…',
  hospitalCourse: 'Transferring facility, admission/discharge dates, reason for hospitalization, treatment, and course…',
  ros: 'Constitutional, Eyes, ENT, Cardiovascular, Respiratory, GI, GU, Musculoskeletal, Integumentary, Neurologic, Psychiatric, Endocrine, Heme/Lymph, Allergic/Immunologic…',
  pmh: 'Chronic conditions and past diagnoses (with ICD-10 where known)…',
  psh: 'Prior surgeries with approximate dates…',
  familyHistory: 'Relevant family medical history…',
  socialHistory: 'Tobacco, alcohol, substance use; prior living situation; functional and support status…',
  medications: 'Reconciled current medications — drug, dose, route, frequency…',
  medChanges: 'Medications started, stopped, or adjusted, with clinical rationale…',
  allergies: 'Drug / food / environmental allergies and reactions (or NKDA)…',
  adverseEffects: 'Tolerability, adverse effects, and required monitoring…',
  vitals: 'T, HR, BP, RR, SpO₂, weight, and pain score…',
  exam: 'General, HEENT, Neck, Cardiovascular, Respiratory, Abdomen, Extremities, Skin, Neurologic, Psychiatric…',
  wound: 'Location, etiology, stage/classification, dimensions (L×W×D cm), wound bed, exudate, periwound, odor, signs of infection…',
  treatment: 'Cleansing, debridement, dressing type and change frequency, offloading, and orders…',
  results: 'Pertinent labs, imaging, and diagnostic results reviewed, with interpretation…',
  carePlanReview: 'Interdisciplinary care plan reviewed; goals, interventions, and progress toward goals; revisions ordered…',
  assessment: 'Problem list with clinical status (stable / improving / worsening) and diagnoses (ICD-10)…',
  mdm: 'Number and complexity of problems addressed, data reviewed/analyzed, and risk of complications, morbidity, or mortality…',
  plan: 'Plan per problem — diagnostics, treatment, medications, monitoring, and goals…',
  orders: 'New or changed orders resulting from this visit — medications, labs, diagnostics, treatments, monitoring, diet, activity…',
  notifications: 'Family, nursing, NP, and/or attending physician notified — who, when, and response (SBAR)…',
  prognosis: 'Clinical prognosis and life expectancy considerations discussed…',
  goals: 'Goals-of-care discussion and patient/surrogate preferences…',
  participants: 'Patient, surrogate/POA, family, and staff present for the discussion…',
  decisionsMade: 'Decisions reached regarding treatment intensity and directives…',
  codeStatus: 'Full Code / DNR (per Florida DNRO, DH Form 1896) / DNI / DNH / Comfort-focused…',
  advanceDirective: 'Living Will, Health Care Surrogate designation (FL Ch. 765), and Florida DNRO (DH Form 1896) status…',
  dischargeDiagnoses: 'Principal and secondary discharge diagnoses (ICD-10)…',
  procedures: 'Procedures, therapies, and significant treatments during the stay…',
  functionalStatus: 'Mobility, ADLs, cognition, and rehabilitation progress at discharge…',
  dischargeMeds: 'Reconciled discharge medications — continued, changed, and discontinued…',
  disposition: 'Discharge destination and level of care…',
  followUp: 'Follow-up appointments, pending results, and provider handoff…',
  dischargeInstructions: 'Instructions to patient/caregiver; warning signs; return precautions…',
  careCoordination: 'Coordination with nursing, therapy, pharmacy, family, and the interdisciplinary team…',
  pronouncement: 'Date and time of death; provider who pronounced…',
  circumstances: 'Circumstances and events preceding death…',
  causeOfDeath: 'Immediate and underlying cause(s) of death…',
  regulatoryAttestation: 'This required periodic physician evaluation was personally performed on this date…',
  timeSpent: 'Total time spent on the date of the encounter (for time-based billing) and attestation of personal performance…',
  addendum: 'Any additional clinically relevant information…',
};

// Sections that benefit from a larger text area.
const BIG = new Set(['hpi', 'interval', 'ros', 'exam', 'assessment', 'plan', 'hospitalCourse', 'mdm', 'wound', 'results', 'medications', 'dischargeMeds', 'goals', 'carePlanReview']);

// Build a template. `over` provides note-type-specific section labels/prompts so
// each template reads correctly for its clinical purpose (e.g. "Reason for
// Admission" vs "Reason for Follow-Up") without diluting the shared doc labels.
const T = (keys, over = {}) => keys.map((key) => ({
  key,
  label: over[`${key}Label`] || SECTION_LABELS[key],
  prompt: over[`${key}Prompt`] || SECTION_PROMPTS[key],
  rows: BIG.has(key) ? 4 : 2,
}));

/**
 * Each template carries ONLY the sections clinically required for that note type
 * (CMS SNF E/M documentation). Comprehensive initial vs. focused subsequent vs.
 * procedure/discussion-specific — no filler sections.
 */
export const TEMPLATES = {
  // Comprehensive initial evaluation (99304–99306).
  hp_admission: T(
    ['chiefComplaint', 'hpi', 'pmh', 'psh', 'familyHistory', 'socialHistory', 'medications', 'allergies', 'ros', 'vitals', 'exam', 'results', 'functionalStatus', 'assessment', 'mdm', 'plan', 'codeStatus', 'advanceDirective', 'careCoordination', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Admission', resultsLabel: 'Diagnostic Data on Admission', medicationsLabel: 'Admission Medication Reconciliation', functionalStatusLabel: 'Functional / Rehabilitation Status' },
  ),
  // Routine subsequent visit (99307–99310) — interval-focused, no re-documented history.
  progress: T(
    ['chiefComplaint', 'interval', 'ros', 'vitals', 'exam', 'results', 'assessment', 'mdm', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Visit', rosLabel: 'Focused Review of Systems', examLabel: 'Focused Physical Examination' },
  ),
  // New acute problem — HPI-driven, with notification when indicated.
  acute_visit: T(
    ['chiefComplaint', 'hpi', 'ros', 'vitals', 'exam', 'results', 'assessment', 'mdm', 'orders', 'notifications', 'timeSpent'],
    { chiefComplaintLabel: 'Presenting Problem', rosLabel: 'Focused Review of Systems', examLabel: 'Focused Physical Examination' },
  ),
  // CMS change-in-condition — change description, orders, and SBAR notification.
  change_in_condition: T(
    ['changeDescription', 'hpi', 'vitals', 'exam', 'results', 'assessment', 'mdm', 'orders', 'notifications', 'timeSpent'],
    { examLabel: 'Focused Physical Examination' },
  ),
  // Focused follow-up on a prior problem, result, or intervention.
  follow_up: T(
    ['chiefComplaint', 'interval', 'vitals', 'exam', 'results', 'assessment', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Follow-Up', intervalLabel: 'Interval Since Last Evaluation', examLabel: 'Focused Physical Examination', resultsLabel: 'Results / Findings Followed Up' },
  ),
  // Required periodic physician visit — care-plan review + regulatory attestation.
  regulatory: T(
    ['chiefComplaint', 'interval', 'ros', 'vitals', 'exam', 'results', 'carePlanReview', 'assessment', 'plan', 'regulatoryAttestation', 'timeSpent'],
    { chiefComplaintLabel: 'Purpose of Periodic Visit' },
  ),
  // Return from hospital/ED — hospital course + medication reconciliation.
  post_hospital: T(
    ['chiefComplaint', 'hospitalCourse', 'dischargeDiagnoses', 'medications', 'allergies', 'vitals', 'exam', 'results', 'assessment', 'mdm', 'plan', 'codeStatus', 'careCoordination', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Readmission', dischargeDiagnosesLabel: 'Hospital Discharge Diagnoses', medicationsLabel: 'Medication Reconciliation (Post-Hospital)' },
  ),
  // Medication management — no exam; medication-focused with monitoring.
  medication: T(
    ['chiefComplaint', 'medications', 'medChanges', 'allergies', 'adverseEffects', 'results', 'assessment', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Medication Review', resultsLabel: 'Monitoring Labs / Levels' },
  ),
  // Clinically significant test-result review — result-focused, no exam.
  lab_imaging: T(
    ['chiefComplaint', 'results', 'assessment', 'mdm', 'plan', 'orders', 'notifications', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Review', resultsLabel: 'Results Reviewed & Interpretation' },
  ),
  // Wound care — detailed wound assessment + treatment.
  wound_care: T(
    ['chiefComplaint', 'wound', 'interval', 'vitals', 'exam', 'treatment', 'assessment', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Wound Care', intervalLabel: 'Wound Progress Since Last Visit', examLabel: 'Relevant Physical Examination' },
  ),
  // Advance care planning (99497–99498) — discussion + time-based.
  advance_care: T(
    ['chiefComplaint', 'prognosis', 'goals', 'participants', 'decisionsMade', 'codeStatus', 'advanceDirective', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Advance Care Planning Discussion', timeSpentLabel: 'Total Time Spent (required for 99497/99498)' },
  ),
  // Discharge summary (99315–99316) — summary of stay + transition of care.
  discharge: T(
    ['dischargeDiagnoses', 'hospitalCourse', 'procedures', 'functionalStatus', 'dischargeMeds', 'disposition', 'followUp', 'dischargeInstructions', 'timeSpent'],
    { hospitalCourseLabel: 'Summary of SNF Stay', functionalStatusLabel: 'Functional Status at Discharge' },
  ),
  // Death / expiration documentation.
  death: T(
    ['pronouncement', 'circumstances', 'exam', 'causeOfDeath', 'notifications', 'timeSpent'],
    { examLabel: 'Examination Findings at Time of Death', notificationsLabel: 'Notifications (Family / Attending / Medical Examiner)' },
  ),
};
