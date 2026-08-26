/**
 * CMS-compliant SNF MD note templates (US standard). Each template is an ordered
 * list of section keys; the editor renders empty fields with clinical guidance
 * prompts — NO pre-filled or fabricated clinical data. Section keys match the
 * backend Word-document generator (noteDocumentService.js) exactly.
 */

// Every note type carries a `service` line — 'snf' or 'pain'. A provider sees ONLY
// the templates for their own service line (SNF vs Pain Management); access is also
// enforced server-side, so the two sets can never cross over.
export const NOTE_TYPES = {
  // ---- Skilled Nursing Facility (SNF) ----
  hp_admission: { label: 'H&P / Admission Note', category: 'Initial Nursing Facility Care', cpt: '99304–99306', service: 'snf' },
  progress: { label: 'Progress Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310', service: 'snf' },
  acute_visit: { label: 'Acute / Sick Visit Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310', service: 'snf' },
  change_in_condition: { label: 'Change in Condition Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310', service: 'snf' },
  follow_up: { label: 'Follow-Up Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310', service: 'snf' },
  regulatory: { label: 'Regulatory / Periodic Visit Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310', service: 'snf' },
  post_hospital: { label: 'Post-Hospital / Readmission Note', category: 'Initial or Subsequent (per circumstances)', cpt: '99304–99310', service: 'snf' },
  medication: { label: 'Medication Management Note', category: 'Subsequent Nursing Facility Care', cpt: '99307–99310', service: 'snf' },
  lab_imaging: { label: 'Lab / Imaging Review Note', category: 'Subsequent / per service', cpt: '99307–99310', service: 'snf' },
  wound_care: { label: 'Wound Care Note', category: 'Subsequent / Specialized service', cpt: '99307–99310', service: 'snf' },
  advance_care: { label: 'Advance Care Planning Note', category: 'Separately reportable (ACP)', cpt: '99497–99498', service: 'snf' },
  discharge: { label: 'Discharge Summary', category: 'Nursing Facility Discharge', cpt: '99315–99316', service: 'snf' },
  procedure_note: { label: 'Procedure Note', category: 'Part B Procedure', cpt: 'Per procedure (11042–11047 · 20610 · 97597…)', service: 'snf' },
  behavioral_health: { label: 'Behavioral Health / Psychiatric Note', category: 'Behavioral Health (Part B)', cpt: '90792 · 99307–99310 (+90833/90836)', service: 'snf' },
  cognitive_care: { label: 'Cognitive Assessment & Care Planning', category: 'Cognitive Care Planning (Part B)', cpt: '99483', service: 'snf' },
  death: { label: 'Death / Expiration Note', category: 'As applicable', cpt: '—', service: 'snf' },
  // ---- Pain Management ----
  pain_consult: { label: 'Initial Pain Consultation', category: 'Pain Management — Evaluation', cpt: '99204–99205 · 99244–99245', service: 'pain' },
  pain_followup: { label: 'Pain Follow-Up Note', category: 'Pain Management — Subsequent', cpt: '99212–99215', service: 'pain' },
  pain_med_mgmt: { label: 'Controlled Substance / Medication Management', category: 'Pain Management — Monitoring', cpt: '99213–99215', service: 'pain' },
  pain_esi: { label: 'Epidural Steroid Injection', category: 'Pain Management — Interventional', cpt: '62321–62323 · 64479–64484', service: 'pain' },
  pain_facet_mbb: { label: 'Facet Injection / Medial Branch Block', category: 'Pain Management — Interventional', cpt: '64490–64495', service: 'pain' },
  pain_rfa: { label: 'Radiofrequency Ablation', category: 'Pain Management — Interventional', cpt: '64633–64636', service: 'pain' },
  pain_si_joint: { label: 'Sacroiliac Joint Injection', category: 'Pain Management — Interventional', cpt: '27096 · 64451', service: 'pain' },
  pain_tpi: { label: 'Trigger Point Injection', category: 'Pain Management — Interventional', cpt: '20552–20553', service: 'pain' },
  pain_nerve_block: { label: 'Peripheral / Sympathetic Nerve Block', category: 'Pain Management — Interventional', cpt: '64400–64530', service: 'pain' },
  pain_scs: { label: 'Spinal Cord Stimulator (Trial / Implant)', category: 'Pain Management — Neuromodulation', cpt: '63650 · 63685', service: 'pain' },
  pain_uds: { label: 'Urine Drug Screen / Toxicology Review', category: 'Pain Management — Monitoring', cpt: '80305–80307 (review)', service: 'pain' },
  pain_discharge: { label: 'Pain Management Discharge / Transition', category: 'Pain Management — Transition', cpt: 'Transition of care', service: 'pain' },
};

// Per-service menus — the "Common" primary choices and the rest under "More". The
// provider's service line selects which menu is shown (and access is server-enforced).
export const SERVICE_MENUS = {
  snf: {
    common: ['hp_admission', 'progress', 'acute_visit', 'regulatory', 'post_hospital', 'wound_care', 'discharge'],
    more: ['change_in_condition', 'follow_up', 'medication', 'lab_imaging', 'procedure_note', 'behavioral_health', 'cognitive_care', 'advance_care', 'death'],
  },
  pain: {
    common: ['pain_consult', 'pain_followup', 'pain_med_mgmt', 'pain_esi', 'pain_facet_mbb', 'pain_rfa'],
    more: ['pain_si_joint', 'pain_tpi', 'pain_nerve_block', 'pain_scs', 'pain_uds', 'pain_discharge'],
  },
};

// Deterministic service line for a provider's specialty NAME. A specialty containing
// "pain" → Pain Management; everything else → SNF (the default). Mirrors the server.
export function serviceForSpecialty(specialtyName) {
  return /\bpain\b/i.test(String(specialtyName || '')) ? 'pain' : 'snf';
}

// Back-compat: the default (SNF) menus, still imported by name elsewhere.
export const NOTE_MENU = SERVICE_MENUS.snf.common;
export const NOTE_MENU_MORE = SERVICE_MENUS.snf.more;

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
  // Procedure note
  procedureName: 'Procedure Performed',
  indication: 'Indication',
  consent: 'Informed Consent',
  procTechnique: 'Technique / Description of Procedure',
  procFindings: 'Findings',
  specimen: 'Specimens / Cultures Sent',
  ebl: 'Estimated Blood Loss',
  complications: 'Complications',
  postProcedure: 'Post-Procedure Condition & Plan',
  // Behavioral health / psychiatric
  psychHistory: 'Psychiatric History',
  mentalStatus: 'Mental Status Examination',
  riskAssessment: 'Risk Assessment (SI / HI / Safety)',
  // Cognitive assessment & care planning (99483)
  cognitiveAssessment: 'Cognitive Assessment (Standardized Instrument)',
  neuroPsych: 'Neuropsychiatric & Behavioral Symptoms',
  safetyEval: 'Safety Evaluation',
  caregiver: 'Caregiver Assessment & Support',
  dementiaPlan: 'Care Plan (Cognitive / Dementia)',
  // Pain Management (evaluation, monitoring & interventional procedures)
  painHistory: 'History of Present Pain',
  painScale: 'Pain Intensity & Character',
  priorTreatments: 'Prior & Conservative Treatments',
  pdmpReview: 'PDMP Review & Morphine-Equivalent Dose',
  opioidRisk: 'Opioid Risk Assessment',
  udsResult: 'Urine Drug Screen / Toxicology',
  injectate: 'Medications Administered (Injectate)',
};

export const SECTION_PROMPTS = {
  chiefComplaint: 'Primary reason for this encounter…',
  changeDescription: 'Acute change: onset, severity, associated symptoms, precipitating factors…',
  hpi: 'Onset, location, duration, character, aggravating/relieving factors, timing, severity, associated symptoms…',
  interval: 'Interval events since last visit; status of active problems; new complaints; nursing/therapy reports…',
  hospitalCourse: 'Transferring facility, admission/discharge dates, reason for hospitalization, treatment, and course…',
  ros: 'Pertinent systems (≥10 for a comprehensive admission; focused systems for a subsequent visit): Constitutional, Eyes, ENT, Cardiovascular, Respiratory, GI, GU, Musculoskeletal, Integumentary, Neurologic, Psychiatric, Endocrine, Heme/Lymph, Allergic/Immunologic…',
  pmh: 'Chronic conditions and past diagnoses (with ICD-10 where known)…',
  psh: 'Prior surgeries with approximate dates…',
  familyHistory: 'Relevant family medical history…',
  socialHistory: 'Tobacco, alcohol, substance use; prior living situation; functional and support status…',
  medications: 'Reconciled current medications — drug, dose, route, frequency…',
  medChanges: 'Medications started, stopped, or adjusted, with clinical rationale…',
  allergies: 'Drug / food / environmental allergies with reaction and severity, or NKDA (no known drug allergies)…',
  adverseEffects: 'Tolerability, adverse effects, and required monitoring…',
  vitals: 'T, HR, BP, RR, SpO₂, weight, and pain score…',
  exam: 'General, HEENT, Neck, Cardiovascular, Respiratory, Abdomen, Extremities, Skin, Neurologic, Psychiatric…',
  wound: 'Location, etiology, stage/classification, dimensions (L×W×D cm), wound bed, exudate, periwound, odor, signs of infection…',
  treatment: 'Cleansing, debridement, dressing type and change frequency, offloading, and orders…',
  results: 'Pertinent labs, imaging, and diagnostic results reviewed, with interpretation…',
  carePlanReview: 'Interdisciplinary care plan reviewed — measurable goals & target dates, interventions, progress toward goals, and revisions ordered; coordination with nursing, therapy, dietary, and social services…',
  assessment: 'Numbered problem list — each problem with clinical status (stable / improving / worsening / resolved) and ICD-10 code, linked to its plan…',
  mdm: 'Three MDM elements (2023 E/M): (1) problems addressed — number & complexity; (2) data reviewed — labs, notes, independent interpretation, discussion with other providers; (3) risk of complications/morbidity/mortality, including medication management. Supports the E/M level billed…',
  plan: 'Plan per problem — diagnostics, treatment, medications, monitoring parameters, patient/goal-directed targets, and follow-up…',
  orders: 'New or changed orders from this visit — medications, labs, diagnostics, treatments, monitoring, diet, activity, therapy, and consults…',
  notifications: 'Family, nursing, NP, and/or attending physician notified — who, when, and response (SBAR: Situation, Background, Assessment, Recommendation)…',
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
  regulatoryAttestation: 'Required physician/NPP visit personally performed (42 CFR §483.30): reviewed the total program of care, documented progress, made decisions to continue or change treatment, and reviewed & signed all orders…',
  timeSpent: 'Total time on the date of service (face-to-face + non-face-to-face). Subsequent NF: 99308 ~20m · 99309 ~30m · 99310 ~45m; Initial: 99305 ~35m · 99306 ~50m; add prolonged 99418 per additional 15m. Attest personal performance…',
  addendum: 'Any additional clinically relevant information…',
  // Procedure note
  procedureName: 'Exact procedure(s) performed (e.g. selective debridement, joint aspiration/injection, I&D, laceration repair) with CPT…',
  indication: 'Clinical indication and medical necessity for the procedure…',
  consent: 'Informed consent obtained — risks, benefits, alternatives discussed; patient/surrogate agreement; time-out performed…',
  procTechnique: 'Site prep and anesthesia; step-by-step technique; instruments/materials; for debridement: tissue type, depth, and surface area (cm²) removed…',
  procFindings: 'Intra-procedure findings (wound bed, fluid, joint, mass, etc.)…',
  specimen: 'Specimens, cultures, or pathology sent (and to where)…',
  ebl: 'Estimated blood loss…',
  complications: 'Complications encountered, or “none”…',
  postProcedure: 'Patient tolerance and condition; dressing/immobilization; post-procedure orders, monitoring, and follow-up…',
  // Behavioral health / psychiatric
  psychHistory: 'Psychiatric diagnoses, prior hospitalizations, substance use, trauma, and relevant history…',
  mentalStatus: 'Appearance, behavior, speech, mood/affect, thought process/content, perception, cognition, insight, judgment…',
  riskAssessment: 'Suicidal / homicidal ideation, plan, intent; self-harm; elopement; and the safety plan / precautions ordered…',
  // Cognitive assessment & care planning (99483)
  cognitiveAssessment: 'Standardized cognitive instrument used and score (e.g. MoCA, MMSE, Mini-Cog); staging of impairment…',
  neuroPsych: 'Neuropsychiatric and behavioral symptoms (agitation, psychosis, depression, sleep) and validated severity where used…',
  safetyEval: 'Safety concerns — wandering/elopement, falls, driving, home/room hazards, medication self-administration…',
  caregiver: 'Caregiver identity, knowledge, willingness, and needs; caregiver strain and support resources…',
  dementiaPlan: 'Individualized care plan: interventions, referrals, non-pharmacologic strategies, medication plan, and goals shared with patient/caregiver…',
  // Pain Management
  painHistory: 'Onset, location, radiation, quality (aching / burning / shooting), timing & duration, aggravating & relieving factors, associated symptoms (weakness, numbness, bowel/bladder), and mechanism (nociceptive vs neuropathic)…',
  painScale: 'Pain now / average / worst / least (0–10 NRS); scale used (NRS, VAS, or PAINAD if nonverbal); patient-acceptable pain goal…',
  priorTreatments: 'Conservative and prior therapies tried and response — physical therapy, medications (NSAIDs, neuropathics, opioids), prior injections/procedures, surgery, chiropractic, home exercise…',
  pdmpReview: 'State PDMP checked (date & findings — corroborating vs discrepant prescriptions); total Morphine Milligram Equivalents (MME/day); any concurrent benzodiazepine…',
  opioidRisk: 'Risk stratification (ORT / DIRE / SOAPP-R score), history of substance use, aberrant drug-related behaviors, and controlled-substance agreement status…',
  udsResult: 'Urine drug screen date & result — expected vs unexpected findings, presence/absence of prescribed and non-prescribed substances, and the clinical action taken…',
  injectate: 'Medications injected per level — corticosteroid (agent & mg), local anesthetic (agent, %, mL), contrast, and any adjuncts; total volumes…',
};

// Sections that benefit from a larger text area.
const BIG = new Set(['hpi', 'interval', 'ros', 'exam', 'assessment', 'plan', 'hospitalCourse', 'mdm', 'wound', 'results', 'medications', 'dischargeMeds', 'goals', 'carePlanReview',
  'procTechnique', 'procFindings', 'mentalStatus', 'riskAssessment', 'cognitiveAssessment', 'neuroPsych', 'dementiaPlan', 'caregiver',
  'painHistory', 'priorTreatments', 'opioidRisk', 'injectate']);

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
/**
 * Lean, necessary-and-sufficient templates. Each carries ONLY the sections required
 * for that note's CMS E/M level + medical necessity + its clinical purpose — the
 * comprehensive history/exam for an initial H&P, focused interval + exam for
 * subsequent visits, and the note-type-specific essentials (wound, procedure,
 * psych, cognitive, discharge). Optional/foldable sections (family/surgical history,
 * social history, redundant orders/notifications) were removed to keep providers
 * focused without losing compliance.
 */
export const TEMPLATES = {
  // Comprehensive initial evaluation (99304–99306) — comprehensive Hx + exam + MDM.
  hp_admission: T(
    // Vitals lead as a quick-reference header (standard EHR layout), then the H&P
    // narrative: CC → HPI → PMH → Meds → Allergies → ROS (last subjective, before the
    // exam) → Exam → Data → Functional status → A → MDM → Plan → Code status →
    // Advance directive → Attestation.
    ['vitals', 'chiefComplaint', 'hpi', 'pmh', 'medications', 'allergies', 'ros', 'exam', 'results', 'functionalStatus', 'assessment', 'mdm', 'plan', 'codeStatus', 'advanceDirective', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Admission', resultsLabel: 'Diagnostic Data on Admission', medicationsLabel: 'Admission Medication Reconciliation', functionalStatusLabel: 'Functional / Rehabilitation Status' },
  ),
  // Routine subsequent visit (99307–99310) — focused interval, exam, A/MDM/P.
  progress: T(
    ['vitals', 'chiefComplaint', 'interval', 'exam', 'assessment', 'mdm', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Visit', examLabel: 'Focused Physical Examination' },
  ),
  // New acute problem — HPI-driven, with SBAR notification.
  acute_visit: T(
    ['vitals', 'chiefComplaint', 'hpi', 'exam', 'assessment', 'mdm', 'plan', 'notifications', 'timeSpent'],
    { chiefComplaintLabel: 'Presenting Problem', examLabel: 'Focused Physical Examination' },
  ),
  // CMS change-in-condition — change description, exam, and REQUIRED SBAR notification.
  change_in_condition: T(
    ['vitals', 'changeDescription', 'hpi', 'exam', 'assessment', 'mdm', 'plan', 'notifications', 'timeSpent'],
    { examLabel: 'Focused Physical Examination' },
  ),
  // Focused follow-up on a prior problem, result, or intervention.
  follow_up: T(
    ['vitals', 'chiefComplaint', 'interval', 'exam', 'assessment', 'mdm', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Follow-Up', intervalLabel: 'Interval Since Last Evaluation', examLabel: 'Focused Physical Examination' },
  ),
  // Required periodic physician visit — care-plan review + regulatory attestation.
  regulatory: T(
    ['vitals', 'chiefComplaint', 'interval', 'exam', 'carePlanReview', 'assessment', 'plan', 'regulatoryAttestation', 'timeSpent'],
    { chiefComplaintLabel: 'Purpose of Periodic Visit' },
  ),
  // Return from hospital/ED — hospital course + medication reconciliation.
  post_hospital: T(
    ['vitals', 'chiefComplaint', 'hospitalCourse', 'dischargeDiagnoses', 'medications', 'allergies', 'exam', 'assessment', 'mdm', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Readmission', dischargeDiagnosesLabel: 'Hospital Discharge Diagnoses', medicationsLabel: 'Medication Reconciliation (Post-Hospital)' },
  ),
  // Medication management — no exam; medication-focused.
  medication: T(
    ['chiefComplaint', 'medications', 'medChanges', 'allergies', 'assessment', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Medication Review' },
  ),
  // Clinically significant test-result review — result-focused, no exam.
  lab_imaging: T(
    ['chiefComplaint', 'results', 'assessment', 'mdm', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Review', resultsLabel: 'Results Reviewed & Interpretation' },
  ),
  // Wound care — wound assessment + treatment (the wound IS the focused exam).
  wound_care: T(
    // Vitals header → reason → interval progress → wound assessment (the focused
    // exam) → treatment → A → plan → time.
    ['vitals', 'chiefComplaint', 'interval', 'wound', 'treatment', 'assessment', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Wound Care', intervalLabel: 'Wound Progress Since Last Visit' },
  ),
  // Advance care planning (99497–99498) — discussion + directives + time.
  advance_care: T(
    ['chiefComplaint', 'goals', 'decisionsMade', 'codeStatus', 'advanceDirective', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Advance Care Planning Discussion', timeSpentLabel: 'Total Time Spent (required for 99497/99498)' },
  ),
  // Discharge summary (99315–99316) — summary of stay + transition of care.
  discharge: T(
    ['dischargeDiagnoses', 'hospitalCourse', 'functionalStatus', 'dischargeMeds', 'disposition', 'followUp', 'dischargeInstructions', 'timeSpent'],
    { hospitalCourseLabel: 'Summary of SNF Stay', functionalStatusLabel: 'Functional Status at Discharge' },
  ),
  // Bedside procedure (Part B) — operative-note essentials.
  procedure_note: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    { timeSpentLabel: 'Total Procedure Time & Attestation' },
  ),
  // Behavioral health / psychiatric visit (Part B) — MSE + risk are the core.
  behavioral_health: T(
    ['chiefComplaint', 'interval', 'medications', 'mentalStatus', 'riskAssessment', 'assessment', 'mdm', 'plan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Psychiatric Visit', intervalLabel: 'Interval / Symptom Status', medicationsLabel: 'Current Psychotropic Medications', assessmentLabel: 'Psychiatric Assessment (DSM-5 / ICD-10)' },
  ),
  // Cognitive assessment & care planning (99483) — CMS mandates these elements.
  cognitive_care: T(
    ['chiefComplaint', 'cognitiveAssessment', 'functionalStatus', 'medications', 'neuroPsych', 'safetyEval', 'caregiver', 'advanceDirective', 'dementiaPlan', 'timeSpent'],
    { chiefComplaintLabel: 'Reason for Cognitive Assessment', functionalStatusLabel: 'Functional Assessment (ADL / IADL)', medicationsLabel: 'Medication Reconciliation (High-Risk Medications)', timeSpentLabel: 'Total Time (99483 is time-based) & Attestation' },
  ),
  // Death / expiration documentation.
  death: T(
    ['pronouncement', 'circumstances', 'exam', 'causeOfDeath', 'notifications'],
    { examLabel: 'Examination Findings at Time of Death', notificationsLabel: 'Notifications (Family / Attending / Medical Examiner)' },
  ),

  /* ===================== Pain Management ===================== */
  // Each template carries ONLY the sections a coder/payer needs — comprehensive Hx +
  // exam + MDM for an E/M visit; the operative essentials for a procedure. Pain scale
  // and functional impact live inside the pain history; guidance/sedation/contrast
  // live inside the procedure technique — no filler sections.

  // Comprehensive initial pain evaluation (99204–99205 / 99244–99245).
  pain_consult: T(
    ['chiefComplaint', 'painHistory', 'functionalStatus', 'pmh', 'medications', 'allergies', 'priorTreatments', 'results', 'exam', 'assessment', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Pain Consultation',
      painHistoryPrompt: 'Onset, location, radiation, quality; pain intensity now/average/worst (0–10 NRS); timing, aggravating & relieving factors; associated symptoms; and mechanism (nociceptive / neuropathic)…',
      functionalStatusLabel: 'Functional Impact of Pain (ADLs / Sleep / Mood / Work)',
      resultsLabel: 'Diagnostic Studies Reviewed (MRI / CT / X-ray / EMG-NCS)',
      resultsPrompt: 'Pertinent imaging (MRI/CT/X-ray) and electrodiagnostics (EMG/NCS) reviewed, correlated to the pain generator…',
      examLabel: 'Focused Musculoskeletal & Neurologic Examination',
      examPrompt: 'Inspection, palpation, range of motion, provocative maneuvers (SLR, facet loading, FABER), motor, sensory, reflexes, and gait…',
      assessmentLabel: 'Pain Diagnosis & Medical Decision Making (ICD-10)',
      assessmentPrompt: 'Numbered pain diagnoses with ICD-10 (e.g. M54.16 radiculopathy, M47.816 spondylosis), the pain generator, mechanism, and MDM complexity supporting the E/M level…',
      planLabel: 'Multimodal Pain Management Plan',
      planPrompt: 'Planned interventional procedure & level, pharmacologic, physical therapy, behavioral, and measurable functional goals…',
    },
  ),
  // Subsequent pain visit (99212–99215).
  pain_followup: T(
    ['chiefComplaint', 'interval', 'painScale', 'medications', 'exam', 'assessment', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Follow-Up',
      intervalLabel: 'Interval History Since Last Visit',
      intervalPrompt: 'Response to prior treatment/injection (percent and duration of relief), interval events, new symptoms, adherence, side effects, and functional progress…',
      examLabel: 'Focused Examination',
      assessmentLabel: 'Pain Assessment & MDM',
      planLabel: 'Pain Management Plan',
    },
  ),
  // Controlled-substance / medication management (CDC & state monitoring elements).
  pain_med_mgmt: T(
    ['chiefComplaint', 'interval', 'medications', 'pdmpReview', 'udsResult', 'opioidRisk', 'assessment', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Medication Review',
      intervalLabel: 'Interval, Pain Level & Functional Response',
      medicationsLabel: 'Current Analgesic Regimen (incl. Controlled Substances)',
      medicationsPrompt: 'Reconciled analgesics — drug, dose, route, frequency; controlled substances flagged with DEA schedule and total daily MME…',
      assessmentLabel: 'Assessment & MDM',
      planLabel: 'Medication / Treatment Plan',
      planPrompt: 'Continue / titrate / taper with rationale, monitoring interval, next PDMP & UDS date, controlled-substance agreement status, and safety measures (naloxone offered)…',
    },
  ),
  // Epidural steroid injection (62321–62323 · 64479–64484).
  pain_esi: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Epidural Steroid Injection) + CPT',
      procedureNamePrompt: 'Epidural steroid injection — approach (interlaminar / transforaminal / caudal), region (cervical / thoracic / lumbar), level(s) and laterality, with CPT…',
      indicationPrompt: 'Radicular pain / stenosis with concordant imaging; failed conservative therapy (≥6 weeks); prior injection response if a repeat…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      consentPrompt: 'Risks/benefits/alternatives discussed & consented; time-out (correct patient, site, side, level); allergies; anticoagulation status/held; baseline pain & vitals…',
      procTechniqueLabel: 'Technique (Level / Approach / Laterality / Guidance)',
      procTechniquePrompt: 'Sterile prep & drape; sedation (none/local/moderate); level and side; approach; imaging guidance (fluoroscopy/US); needle; and live-contrast confirmation of epidural spread…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Facet joint injection / medial branch block (64490–64495).
  pain_facet_mbb: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Facet Injection / Medial Branch Block) + CPT',
      procedureNamePrompt: 'Facet (zygapophyseal) joint injection or medial branch block — region, level(s) (e.g. L4-5, L5-S1), laterality, and number of levels, with CPT…',
      indicationPrompt: 'Axial (facetogenic) pain with positive facet loading; diagnostic vs therapeutic; if pre-RFA, note diagnostic block #1 or #2 and percent relief…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Levels / Targets / Laterality / Guidance)',
      procTechniquePrompt: 'Sterile prep; sedation; targets per level & side; fluoroscopic guidance; needle placement and confirmation…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Radiofrequency ablation of medial branch nerves (64633–64636).
  pain_rfa: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Radiofrequency Ablation) + CPT',
      procedureNamePrompt: 'RFA of the medial branch nerves — region, level(s), laterality, and number of levels, with CPT (64633–64636)…',
      indicationPrompt: 'Facetogenic pain confirmed by ≥2 diagnostic medial branch blocks with ≥80% concordant relief — document block dates & percent relief…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'RFA Technique (Guidance / Sensory & Motor Testing / Lesioning)',
      procTechniquePrompt: 'Sterile prep; sedation; cannula placement per level under fluoroscopy; sensory (concordant ≤0.5 V) and motor (no radicular contraction) testing; lesion temperature (~80 °C) and duration…',
      injectateLabel: 'Local Anesthetic / Steroid Administered',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Sacroiliac joint injection (27096 · 64451).
  pain_si_joint: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Sacroiliac Joint Injection) + CPT',
      procedureNamePrompt: 'Sacroiliac joint injection — laterality; image-guided (fluoroscopy 27096) with CPT…',
      indicationPrompt: 'SI-joint pain with ≥3 positive provocation tests (FABER, thigh thrust, compression, Gaenslen); failed conservative therapy…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Approach / Guidance / Intra-articular Confirmation)',
      procTechniquePrompt: 'Sterile prep; sedation; approach and side; fluoroscopic guidance; live-contrast confirmation of intra-articular placement…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Trigger point injection (20552–20553) — no imaging guidance.
  pain_tpi: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Trigger Point Injection) + CPT',
      procedureNamePrompt: 'Trigger point injection — muscle(s) injected and number of muscles (1–2 muscles 20552, ≥3 muscles 20553)…',
      indicationPrompt: 'Palpable taut band / trigger point with referred pain; myofascial pain; failed conservative therapy…',
      consentLabel: 'Informed Consent & Time-Out',
      procTechniqueLabel: 'Technique (Muscles & Number of Sites)',
      injectateLabel: 'Medications Injected',
      injectatePrompt: 'Local anesthetic (agent, %, mL) ± corticosteroid per site; total number of injections…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Peripheral / sympathetic nerve block (64400–64530).
  pain_nerve_block: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Nerve Block) + CPT',
      procedureNamePrompt: 'Peripheral or sympathetic nerve block — specific nerve/plexus (e.g. stellate ganglion, lumbar sympathetic, genicular, occipital, intercostal), laterality, and CPT…',
      indicationPrompt: 'Diagnostic and/or therapeutic block for the named neuropathic / sympathetically-mediated pain; failed conservative therapy…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Target / Guidance / Confirmation)',
      procTechniquePrompt: 'Sterile prep; sedation; target nerve/plexus and side; imaging guidance (fluoroscopy/US); needle placement and confirmation…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Spinal cord stimulator trial / implant (63650 · 63685).
  pain_scs: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Spinal Cord Stimulator — Trial / Implant) + CPT',
      procedureNamePrompt: 'SCS percutaneous trial (63650) or permanent implant (63685) — lead level(s), target, and device / manufacturer…',
      indicationPrompt: 'FBSS / CRPS / refractory neuropathic pain; failed conservative & interventional therapy; psychological clearance; (implant) trial ≥50% relief…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Lead Placement / Guidance / Mapping / Programming)',
      procTechniquePrompt: 'Sterile prep; sedation; epidural access; lead advancement to target level under fluoroscopy; paresthesia mapping / coverage; anchoring (implant); programming parameters…',
      postProcedureLabel: 'Post-Procedure Condition & Trial Instructions',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Urine drug screen / toxicology review (monitoring).
  pain_uds: T(
    ['chiefComplaint', 'udsResult', 'medications', 'pdmpReview', 'assessment', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Toxicology Review',
      medicationsLabel: 'Prescribed Controlled Substances',
      assessmentLabel: 'Interpretation & Assessment',
      assessmentPrompt: 'Consistency of the UDS with the prescribed regimen and the PDMP; explanation of any unexpected or absent results…',
      planLabel: 'Action & Plan',
      planPrompt: 'Continue / modify / taper; confirmatory testing if indicated; counseling; referral; and any change to the controlled-substance agreement…',
    },
  ),
  // Pain management discharge / transition of care.
  pain_discharge: T(
    ['chiefComplaint', 'interval', 'medications', 'assessment', 'plan', 'followUp', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Discharge / Transition',
      intervalLabel: 'Summary of Pain Management Course & Functional Status',
      medicationsLabel: 'Discharge Medication Reconciliation',
      assessmentLabel: 'Final Pain Assessment',
      planLabel: 'Discharge Plan & Instructions',
      followUpLabel: 'Follow-Up & Care Coordination',
    },
  ),
};
