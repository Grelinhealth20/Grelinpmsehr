/**
 * CMS-compliant SNF MD note templates (US standard). Each template is an ordered
 * list of section keys; the editor renders empty fields with clinical guidance
 * prompts — NO pre-filled or fabricated clinical data. Section keys match the
 * backend Word-document generator (noteDocumentService.js) exactly.
 */

// Every note type carries a `service` line — 'snf' or 'pain'. A provider sees ONLY
// the templates for their own service line (SNF vs Pain Management); access is also
// enforced server-side, so the two sets can never cross over.
// SNF note types (label source + offline fallback). The BACKEND is authoritative for the
// section structure — the editor fetches it; these mirror the labels. Each is FREE-FORM.
export const NOTE_TYPES = {
  hp: { label: 'H&P', category: 'SNF Admission History & Physical', cpt: '', service: 'snf' },
  soap: { label: 'SOAP Note', category: 'SNF SOAP Note', cpt: '', service: 'snf' },
  progress: { label: 'Progress Note', category: 'SNF Progress Note', cpt: '', service: 'snf' },
  discharge: { label: 'Discharge Summary', category: 'SNF Discharge Summary', cpt: '', service: 'snf' },
};
// The order the type chooser offers them in.
export const NOTE_TYPE_ORDER = ['hp', 'soap', 'progress', 'discharge'];

// Per-service menus — the "Common" primary choices and the rest under "More". The
// provider's service line selects which menu is shown (and access is server-enforced).
export const SERVICE_MENUS = { // templates removed
  snf: { common: [], more: [] },
  pain: { common: [], more: [] },
  tcm: { common: [], more: [] },
};

// Deterministic service line for a provider's specialty NAME. A specialty containing
// "pain" → Pain Management; "tcm"/"transitional care" → TCM; everything else → SNF (the
// default). Mirrors the server (accessScope decisions use the STORED service_line, not this).
export function serviceForSpecialty(specialtyName) {
  const n = String(specialtyName || '');
  if (/\bpain\b/i.test(n)) return 'pain';
  if (/\btcm\b|transitional care/i.test(n)) return 'tcm';
  return 'snf';
}

// Back-compat: the default (SNF) menus, still imported by name elsewhere.
export const NOTE_MENU = SERVICE_MENUS.snf.common;
export const NOTE_MENU_MORE = SERVICE_MENUS.snf.more;

// Reason-for-encounter options for a Progress Note (structured documentation data).
export const PROGRESS_REASONS = [
  'Routine follow-up', 'Change in condition', 'Medication management', 'Lab / imaging review',
  'Diabetes management', 'Hypertension', 'CHF', 'COPD', 'Pain management', 'Fall follow-up',
  'Behavioral / psychiatric', 'Anticoagulation', 'Wound follow-up', 'Other',
];

export const SECTION_LABELS = {
  chiefComplaint: 'Chief Complaint / Reason for Encounter',
  // SNF note-type section keys
  subjective: 'Subjective',
  objective: 'Objective',
  hospitalCourse: 'Hospital Course',
  functionalStatus: 'Function & Cognition',
  skilledNeed: 'Skilled Need & Certification',
  rehabGoals: 'Rehab Goals & Expected Discharge',
  admissionOrders: 'Admission Orders Written',
  pendingFollowUp: 'Pending Items',
  homeServices: 'Home Services & Equipment',
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
  // Transitional Care Management (TCM 99495 / 99496)
  dischargeInfo: 'Discharge Information Reviewed',
  interactiveContact: 'Interactive Contact (≤ 2 Business Days Post-Discharge)',
  pendingFollowUp: 'Pending Tests, Referrals & Treatments',
  communityServices: 'Community & Social Services Coordination',
  caregiverEducation: 'Patient / Family / Caregiver Education',
  tcmComplexity: 'Medical Decision Making & TCM Complexity (99495 / 99496)',
  transitionGoals: 'Transition Goals & Self-Management Plan',
  tcmAttestation: 'TCM Service Period, Timeline & Billing Attestation',
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
  // Transitional Care Management (TCM 99495 / 99496)
  dischargeInfo: 'Discharging facility and setting (inpatient / observation / SNF / partial hospitalization), admit & discharge dates, discharge diagnoses (ICD-10), procedures, and the discharge summary/instructions reviewed — establishes the 30-day TCM period start (day after discharge)…',
  interactiveContact: 'Interactive contact with the patient/caregiver made WITHIN 2 BUSINESS DAYS of discharge — date/time, method (telephone, secure message, or face-to-face), who was reached, issues identified, and needs addressed. Document the ≥2 attempts if the first contacts were unsuccessful…',
  pendingFollowUp: 'Pending diagnostic tests/results, treatments, and specialist referrals from the hospitalization — what is outstanding, who is responsible, and the follow-up arranged (appointments scheduled, results tracked)…',
  communityServices: 'Coordination with community and social services — home health, DME, PT/OT, hospice/palliative, transportation, meals, caregiver supports; agencies engaged and referrals established or re-established…',
  caregiverEducation: 'Education provided to the patient, family, and/or caregiver — diagnosis and warning signs, medication use and self-management, activity and diet, and how/when to seek care; support for self-management and independent living and activities of daily living…',
  tcmComplexity: 'Complexity of medical decision making during the service period — problems addressed, data reviewed, and risk — which selects the code: MODERATE MDM → 99495; HIGH MDM → 99496. Note that the F2F visit must occur ≤14 days (99495) or ≤7 days (99496) of discharge…',
  transitionGoals: 'Individualized transitional care goals — stabilization of active problems, prevention of readmission, restoration/maintenance of function, and the patient/caregiver self-management plan with measurable targets…',
  tcmAttestation: 'TCM timeline & billing: discharge date; date of interactive contact (≤2 business days); date of the face-to-face visit (≤7 or ≤14 days); date medication reconciliation completed (no later than the F2F date). TCM is reported ONCE per 30-day period with the date of service = the F2F visit; not billable if the patient is readmitted during the period (report a separate E/M instead). Attest personal performance…',
};

// Sections that benefit from a larger text area.
const BIG = new Set(['hpi', 'interval', 'ros', 'exam', 'assessment', 'plan', 'hospitalCourse', 'mdm', 'wound', 'results', 'medications', 'dischargeMeds', 'goals', 'carePlanReview',
  'procTechnique', 'procFindings', 'mentalStatus', 'riskAssessment', 'cognitiveAssessment', 'neuroPsych', 'dementiaPlan', 'caregiver',
  'painHistory', 'priorTreatments', 'opioidRisk', 'injectate',
  'dischargeInfo', 'interactiveContact', 'pendingFollowUp', 'communityServices', 'caregiverEducation', 'transitionGoals', 'tcmComplexity', 'tcmAttestation']);

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