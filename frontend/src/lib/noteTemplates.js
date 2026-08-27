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
  pain_scs: { label: 'Neurostimulator — SCS / PNS (Trial / Implant)', category: 'Pain Management — Neuromodulation', cpt: '63650 · 63685 · 64555 · 64575', service: 'pain' },
  pain_pump: { label: 'Intrathecal Pump — Trial / Implant / Refill', category: 'Pain Management — Neuromodulation', cpt: '62362 · 62367–62370 · 95990–95991', service: 'pain' },
  pain_kypho: { label: 'Vertebral Augmentation (Kyphoplasty / Vertebroplasty)', category: 'Pain Management — Interventional', cpt: '22510–22515', service: 'pain' },
  pain_joint: { label: 'Peripheral Joint / Bursa Injection', category: 'Pain Management — Interventional', cpt: '20600–20611', service: 'pain' },
  pain_botox: { label: 'Botulinum Toxin Injection', category: 'Pain Management — Interventional', cpt: '64615 · 64642–64647', service: 'pain' },
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
    more: ['pain_si_joint', 'pain_tpi', 'pain_nerve_block', 'pain_scs', 'pain_pump', 'pain_kypho', 'pain_joint', 'pain_botox', 'pain_uds', 'pain_discharge'],
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
  // Initial Nursing Facility Care (99304–99306) — comprehensive Hx + exam + MDM that
  // establishes the skilled need and the individualized plan of care.
  hp_admission: T(
    ['vitals', 'chiefComplaint', 'hpi', 'pmh', 'medications', 'allergies', 'ros', 'exam', 'results', 'functionalStatus', 'assessment', 'mdm', 'plan', 'codeStatus', 'advanceDirective', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Admission',
      chiefComplaintPrompt: 'Reason for SNF admission, the qualifying 3-day inpatient stay (if Part A), and the SKILLED need justifying this level of care (skilled nursing and/or rehabilitation)…',
      hpiPrompt: 'Full narrative of the illness/injury leading to admission — onset and course, the acute hospitalization and treatment, current clinical status, and the specific skilled services required…',
      medicationsLabel: 'Admission Medication Reconciliation',
      medicationsPrompt: 'Complete reconciled admission medication list — drug, dose, route, frequency; flag high-risk medications (anticoagulants, insulin, opioids, antipsychotics) with indication and monitoring…',
      resultsLabel: 'Diagnostic Data on Admission',
      resultsPrompt: 'Hospital/transfer and admission labs, imaging, and diagnostics with interpretation; note pending results and needed follow-up studies…',
      functionalStatusLabel: 'Functional / Rehabilitation Status',
      functionalStatusPrompt: 'Prior baseline vs current mobility, ADLs, cognition, continence, and swallow; rehabilitation potential and the PT/OT/ST plan that supports the skilled stay…',
      assessmentPrompt: 'Numbered problem list — the primary reason for skilled care first; each active/chronic diagnosis with clinical status and ICD-10, linked to its plan…',
      planPrompt: 'Individualized plan of care per problem — skilled interventions, medications, monitoring parameters, diet/activity, therapy orders, consults, and measurable rehab/recovery goals with target dates…',
    },
  ),
  // Subsequent NF Care (99307–99310) — ROUTINE periodic visit reassessing ALL active
  // problems. Distinct from Follow-Up (single problem) and Acute (new problem).
  progress: T(
    ['vitals', 'chiefComplaint', 'interval', 'medChanges', 'exam', 'assessment', 'mdm', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Visit',
      chiefComplaintPrompt: 'Routine scheduled physician/NPP visit — no new acute complaint (if an acute change is present, use the Acute or Change-in-Condition note)…',
      intervalLabel: 'Interval History (Since Last Visit)',
      intervalPrompt: 'Status of EACH active/chronic problem (stable / improving / worsening); nursing & therapy reports, vitals/weight trend, intake & behavior, medication tolerance, and any new nursing concerns…',
      medChangesPrompt: 'Medications started, stopped, titrated, or held since the last visit, with the clinical rationale for each…',
      examLabel: 'Focused Interval Examination',
      examPrompt: 'Problem-directed exam — general appearance, cardiopulmonary, abdomen, extremities/edema, skin, and neuro/mental status as indicated by the active problems…',
      assessmentPrompt: 'Numbered active-problem list — each with current status (stable/improving/worsening/resolved) and ICD-10; note stable chronic problems being continued…',
      mdmPrompt: 'MDM for a subsequent visit: number/complexity of problems reassessed, data reviewed, and risk (esp. ongoing medication management) supporting 99307–99310…',
      planPrompt: 'Plan per active problem — continue vs adjust therapy, monitoring parameters, therapy/nursing orders, and follow-up interval…',
    },
  ),
  // Acute / Sick Visit — a NEW acute complaint arising in the facility. HPI-driven, with
  // SBAR notification of the responsible practitioner/family.
  acute_visit: T(
    ['vitals', 'chiefComplaint', 'hpi', 'exam', 'results', 'assessment', 'mdm', 'plan', 'notifications', 'timeSpent'],
    {
      chiefComplaintLabel: 'Presenting Acute Problem',
      chiefComplaintPrompt: 'The NEW acute symptom or event prompting this visit (e.g. fever, fall, chest pain, shortness of breath, altered mental status)…',
      hpiPrompt: 'OLDCARTS of the new problem — onset, location, duration, character, aggravating/relieving factors, timing, severity, and associated symptoms; pertinent negatives ruling in/out serious causes…',
      examLabel: 'Focused Examination (Problem-Directed)',
      examPrompt: 'Exam focused on the acute problem and the systems needed to exclude serious causes (e.g. cardiopulmonary + neuro for chest pain or a fall)…',
      resultsLabel: 'Point-of-Care / STAT Data',
      resultsPrompt: 'Any STAT labs, POC glucose, EKG, imaging, or vitals obtained for this acute problem, with interpretation…',
      assessmentPrompt: 'Working diagnosis/differential for the acute problem with ICD-10; acuity and whether it can be managed in-house vs requires transfer…',
      planPrompt: 'Acute management — orders, medications, monitoring frequency, return-precautions/parameters, and disposition (treat-in-place vs send-out)…',
      notificationsPrompt: 'SBAR to the covering physician/NPP and family/responsible party — Situation, Background, Assessment, Recommendation; who was notified, when, and their response/orders…',
    },
  ),
  // Change in Condition — CMS-required documentation of a SIGNIFICANT decline: the change,
  // interventions/STAT orders, and MANDATORY notification of family + attending.
  change_in_condition: T(
    ['vitals', 'changeDescription', 'hpi', 'exam', 'assessment', 'orders', 'plan', 'notifications', 'timeSpent'],
    {
      changeDescriptionPrompt: 'The significant change — what changed, when, baseline vs current, severity, precipitating factors, and any red-flag findings (hypotension, hypoxia, new focal deficit, sepsis criteria)…',
      hpiPrompt: 'Evolution of the change since onset — trajectory, prior interventions and response, and pertinent negatives…',
      examLabel: 'Focused Examination',
      examPrompt: 'Exam targeting the changed system(s) plus vital-sign trend, mental status, and perfusion — enough to gauge acuity and stability…',
      assessmentPrompt: 'Clinical impression of the change and its likely cause with ICD-10; stability and risk determination (treat-in-place vs transfer)…',
      ordersLabel: 'Interventions & STAT Orders',
      ordersPrompt: 'Immediate interventions and STAT orders — labs, imaging, O₂, IV fluids/medications, monitoring frequency, and vitals parameters for re-evaluation…',
      planPrompt: 'Ongoing plan, monitoring interval, escalation/transfer criteria, and re-evaluation timing…',
      notificationsPrompt: 'REQUIRED SBAR notification of the attending physician/NPP AND the family/responsible party (42 CFR §483.10) — who, when, what was communicated, and the response/orders given…',
    },
  ),
  // Follow-Up — FOCUSED re-evaluation of ONE prior problem, abnormal result, or
  // intervention (distinct from the routine multi-problem Progress note).
  follow_up: T(
    ['vitals', 'chiefComplaint', 'interval', 'exam', 'results', 'assessment', 'mdm', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Problem Being Followed Up',
      chiefComplaintPrompt: 'The single specific problem, abnormal result, or intervention being re-evaluated (e.g. resolving pneumonia, wound healing, INR/warfarin titration, post-injection response)…',
      intervalLabel: 'Response Since Last Evaluation',
      intervalPrompt: 'Trajectory of THIS problem since it was last evaluated — symptom change, result trend, response to the treatment/intervention, adherence, and any side effects…',
      examLabel: 'Focused Examination (Targeted to the Problem)',
      examPrompt: 'Exam directed at the followed problem only (e.g. lungs for pneumonia, the wound, the injected joint)…',
      resultsLabel: 'Repeat / Trending Results',
      resultsPrompt: 'Repeat or trending labs/imaging for this problem (e.g. repeat INR, CXR, CBC), with interpretation vs the prior value…',
      assessmentPrompt: 'Status of the followed problem — improving / stable / worsening / resolved — with ICD-10 and whether the current management is achieving the goal…',
      planPrompt: 'Continue, adjust, or stop the treatment; next monitoring/recheck interval; and criteria for escalation or resolution…',
    },
  ),
  // Regulatory / Periodic Visit — the physician/NPP visit required at set intervals;
  // its purpose is the interdisciplinary care-plan review + the 42 CFR §483.30 attestation.
  regulatory: T(
    ['vitals', 'chiefComplaint', 'interval', 'exam', 'carePlanReview', 'assessment', 'plan', 'regulatoryAttestation', 'timeSpent'],
    {
      chiefComplaintLabel: 'Purpose of Periodic Visit',
      chiefComplaintPrompt: 'Required periodic physician/NPP visit (42 CFR §483.30) — state the visit interval being satisfied…',
      intervalLabel: 'Interval Since Last Required Visit',
      intervalPrompt: 'Overall interval status across all active problems, significant events, hospitalizations/ED visits, and therapy/nursing progress since the last required visit…',
      examLabel: 'Physical Examination',
      carePlanReviewPrompt: 'Interdisciplinary care plan reviewed — measurable goals and target dates, interventions, progress toward each goal, and revisions ordered; coordination with nursing, therapy, dietary, pharmacy, and social services…',
      planPrompt: 'Decisions to continue or change the program of care per problem, orders reviewed/renewed, and the next required-visit interval…',
    },
  ),
  // Post-Hospital / Readmission — return from hospital/ED. The reconciliation of hospital
  // vs SNF orders is the highest-risk, highest-value element.
  post_hospital: T(
    ['vitals', 'chiefComplaint', 'hospitalCourse', 'dischargeDiagnoses', 'medications', 'allergies', 'exam', 'assessment', 'mdm', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Return / Readmission',
      chiefComplaintPrompt: 'Reason for the transfer out and the return — the acute event, the treating facility, and dates out/in…',
      hospitalCoursePrompt: 'Transferring facility, admit/discharge dates, reason for hospitalization, key treatments/procedures, and the clinical course and stability on return…',
      dischargeDiagnosesLabel: 'Hospital Discharge Diagnoses',
      dischargeDiagnosesPrompt: 'Principal and secondary diagnoses from the hospital discharge summary (ICD-10), including any new diagnoses to add to the SNF problem list…',
      medicationsLabel: 'Medication Reconciliation (Post-Hospital)',
      medicationsPrompt: 'Reconcile hospital discharge medications against the prior SNF list — explicitly note each drug CONTINUED, CHANGED, STOPPED, or NEW, and resolve any discrepancies (esp. anticoagulants, antibiotics, insulin, opioids)…',
      examPrompt: 'Exam focused on the readmitting condition and overall stability on return (cardiopulmonary, the affected system, wounds/lines, mental status)…',
      assessmentPrompt: 'Updated problem list incorporating the hospitalization — status of the acute problem and reconciliation of chronic problems with ICD-10…',
      planPrompt: 'Post-hospital plan — resumed/adjusted skilled services, new orders and monitoring, pending hospital follow-ups, and re-hospitalization risk-reduction…',
    },
  ),
  // Medication Management / Monitoring — medication-focused review; no exam required.
  medication: T(
    ['chiefComplaint', 'medications', 'medChanges', 'adverseEffects', 'allergies', 'assessment', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Medication Review',
      chiefComplaintPrompt: 'Trigger for the review — routine regimen review, monitoring of a high-risk drug (anticoagulant, insulin, antipsychotic), a gradual-dose-reduction (GDR) assessment, or a new symptom/lab prompting a change…',
      medicationsLabel: 'Current Medication Regimen',
      medicationsPrompt: 'Current medications relevant to this review — drug, dose, route, frequency, and indication; highlight the drug(s) under review…',
      medChangesPrompt: 'Medications started, stopped, titrated, or held today with the clinical rationale; for psychotropics document the GDR attempt or the clinical contraindication…',
      adverseEffectsPrompt: 'Tolerability and any adverse effects; required monitoring performed or ordered (e.g. INR, drug level, glucose, renal function, AIMS for antipsychotics)…',
      assessmentPrompt: 'Assessment of medication appropriateness, efficacy, and safety per the indication (ICD-10), including polypharmacy/deprescribing considerations…',
      planPrompt: 'Medication plan — changes made, monitoring labs/parameters and their interval, and the next review date…',
    },
  ),
  // Lab / Imaging Review — physician review of a clinically significant result; no exam.
  lab_imaging: T(
    ['chiefComplaint', 'results', 'assessment', 'mdm', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Result Being Reviewed',
      chiefComplaintPrompt: 'The clinically significant lab or imaging result triggering this review (e.g. critical potassium, supratherapeutic INR, new infiltrate, positive culture)…',
      resultsLabel: 'Result & Interpretation',
      resultsPrompt: 'The specific result with value/finding and reference range, the collection date, comparison to prior, and your clinical interpretation (expected vs unexpected, critical vs actionable)…',
      assessmentPrompt: 'Clinical significance of the result — the diagnosis or problem it reflects (ICD-10) and its urgency…',
      mdmPrompt: 'Independent interpretation of the test and the medical decision making it drives (data reviewed + risk), supporting the E/M level…',
      planPrompt: 'Action taken on the result — orders/medication changes, repeat/confirmatory testing, notifications, and monitoring interval…',
    },
  ),
  // Wound Care — the wound assessment IS the focused exam; treatment specifics drive
  // medical necessity for continued skilled wound care.
  wound_care: T(
    ['vitals', 'chiefComplaint', 'interval', 'wound', 'treatment', 'assessment', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Wound Care',
      chiefComplaintPrompt: 'The wound(s) being managed and the goal (healing, debridement, infection control) — the skilled need for physician wound management…',
      intervalLabel: 'Wound Progress Since Last Visit',
      intervalPrompt: 'Direction of healing since last assessment — improving / stable / deteriorating; change in size/depth, exudate, tissue, and pain; response to the current treatment…',
      woundPrompt: 'For EACH wound: location, etiology (pressure/venous/arterial/diabetic/surgical), stage or classification, measurements L×W×D cm, wound bed (granulation/slough/eschar %), exudate amount & type, periwound skin, odor, and signs of infection…',
      treatmentPrompt: 'Cleansing, debridement performed (type + tissue removed), dressing selected and change frequency, offloading/compression, and adjuncts (NPWT, etc.); orders for nursing…',
      assessmentPrompt: 'Each wound with etiology and stage (ICD-10, e.g. L89.- pressure ulcer with stage), healing trajectory, and any complication (infection, undermining, tunneling)…',
      planPrompt: 'Wound plan — treatment regimen, offloading/nutrition/moisture goals, monitoring interval, and criteria for escalation (culture, imaging, surgical/vascular referral)…',
    },
  ),
  // Advance Care Planning (99497–99498) — the discussion, the decisions, and the TIME.
  advance_care: T(
    ['chiefComplaint', 'prognosis', 'goals', 'participants', 'decisionsMade', 'codeStatus', 'advanceDirective', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Advance Care Planning Discussion',
      chiefComplaintPrompt: 'Why ACP is being addressed now — new diagnosis/prognosis, decline, family request, or routine review; voluntary and no treatment provided during the counseling…',
      prognosisPrompt: 'Clinical condition, trajectory, and prognosis/life-expectancy considerations discussed with the patient/surrogate…',
      goalsPrompt: 'Patient values and goals of care elicited — what matters most, acceptable vs unacceptable outcomes, and preferences for life-sustaining treatment…',
      participantsPrompt: 'Who participated — patient, health care surrogate/POA, family, and staff; decision-making capacity of the patient…',
      decisionsMadePrompt: 'Decisions reached on treatment intensity and specific interventions (CPR, intubation, hospitalization, artificial nutrition/hydration, comfort care)…',
      timeSpentLabel: 'Total Face-to-Face Time (required for 99497/99498)',
      timeSpentPrompt: 'Total time counseling/discussing ACP on this date — 99497 for the first 30 minutes; add 99498 for each additional 30 minutes. Attest personal performance…',
    },
  ),
  // Discharge Summary (99315–99316) — summary of stay + a safe transition of care.
  discharge: T(
    ['dischargeDiagnoses', 'hospitalCourse', 'procedures', 'functionalStatus', 'dischargeMeds', 'disposition', 'followUp', 'dischargeInstructions', 'timeSpent'],
    {
      dischargeDiagnosesPrompt: 'Principal and secondary discharge diagnoses (ICD-10) and the condition of each at discharge (resolved/stable/ongoing)…',
      hospitalCourseLabel: 'Summary of SNF Stay',
      hospitalCoursePrompt: 'Admission reason, significant events and treatments during the stay, response to skilled/rehab services, and clinical status at discharge…',
      proceduresLabel: 'Significant Treatments / Procedures During Stay',
      proceduresPrompt: 'Significant procedures, therapies, and treatments provided during the SNF stay…',
      functionalStatusLabel: 'Functional Status at Discharge',
      functionalStatusPrompt: 'Discharge mobility, ADLs, cognition, continence, and swallow vs admission baseline; rehab goals met/not met and remaining needs…',
      dischargeMedsPrompt: 'Final reconciled discharge medication list — continued, changed, and discontinued, with instructions; ensure equipment/supplies and prescriptions are arranged…',
      dispositionPrompt: 'Discharge destination and level of care (home with services, ALF, home health, hospice), and the responsible receiving provider…',
      followUpPrompt: 'Follow-up appointments, pending results to be tracked, and the provider handoff/communication completed…',
      dischargeInstructionsPrompt: 'Instructions to patient/caregiver — diet, activity, medications, warning signs, and return/ER precautions…',
    },
  ),
  // Procedure Note (Part B) — operative-note essentials for a bedside procedure.
  procedure_note: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'procFindings', 'specimen', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNamePrompt: 'Exact procedure(s) performed with laterality/site and CPT (e.g. selective debridement 97597–97598, joint aspiration/injection 20610, I&D 10060, simple laceration repair 12001)…',
      indicationPrompt: 'Clinical indication and the medical necessity supporting the procedure (diagnosis + failed conservative care where applicable)…',
      consentPrompt: 'Informed consent obtained — risks, benefits, and alternatives discussed; patient/surrogate agreement; and the pre-procedure time-out (correct patient, site, procedure)…',
      procTechniquePrompt: 'Positioning, skin prep and anesthesia (agent, %, mL); step-by-step technique; instruments/materials and any imaging guidance; for debridement: tissue type, depth, and surface area (cm²) removed…',
      procFindingsPrompt: 'Intra-procedure findings — wound bed, fluid/aspirate character, joint, mass, or lesion appearance…',
      specimenPrompt: 'Specimens, cultures, or pathology sent and their destination, or “none”…',
      complicationsPrompt: 'Complications encountered and how managed, or “none”…',
      postProcedurePrompt: 'Patient tolerance and post-procedure condition; dressing/immobilization; and post-procedure orders, monitoring, and follow-up…',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Behavioral Health / Psychiatric (Part B) — the MSE and risk assessment are the core.
  behavioral_health: T(
    ['chiefComplaint', 'interval', 'medications', 'mentalStatus', 'riskAssessment', 'assessment', 'mdm', 'plan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Psychiatric Visit',
      chiefComplaintPrompt: 'Reason for the psychiatric encounter — new evaluation, medication management, behavioral disturbance, or follow-up of a psychiatric diagnosis…',
      intervalLabel: 'Interval / Symptom Status',
      intervalPrompt: 'Course since the last visit — target symptoms (mood, sleep, appetite, agitation, psychosis), response to current treatment, adherence, side effects, and any behavioral events…',
      medicationsLabel: 'Current Psychotropic Medications',
      medicationsPrompt: 'Current psychotropics with dose and indication; for antipsychotics note the target behavior, GDR status, and AIMS/EPS monitoring…',
      mentalStatusPrompt: 'MSE — appearance, behavior, speech, mood & affect, thought process and content, perceptual disturbances, cognition/orientation, insight, and judgment…',
      riskAssessmentPrompt: 'Suicidal/homicidal ideation (with plan/intent), self-harm, elopement, and aggression risk; the safety plan and precautions ordered…',
      assessmentLabel: 'Psychiatric Assessment (DSM-5 / ICD-10)',
      assessmentPrompt: 'Psychiatric diagnoses (DSM-5 / ICD-10) with current severity and the behavioral/medical factors contributing…',
      planPrompt: 'Psychiatric plan — medication changes with rationale, non-pharmacologic/behavioral interventions, monitoring (target behaviors, labs, AIMS), and follow-up interval…',
    },
  ),
  // Cognitive Assessment & Care Planning (99483) — CMS mandates each of these elements.
  cognitive_care: T(
    ['chiefComplaint', 'cognitiveAssessment', 'functionalStatus', 'medications', 'neuroPsych', 'safetyEval', 'caregiver', 'advanceDirective', 'dementiaPlan', 'timeSpent'],
    {
      chiefComplaintLabel: 'Reason for Cognitive Assessment',
      chiefComplaintPrompt: 'Cognitive concern prompting the comprehensive assessment (memory decline, new confusion, dementia staging/care planning)…',
      cognitiveAssessmentPrompt: 'Standardized instrument used and score (MoCA, MMSE, Mini-Cog); staging of impairment and comparison to any prior testing…',
      functionalStatusLabel: 'Functional Assessment (ADL / IADL)',
      functionalStatusPrompt: 'Standardized ADL/IADL assessment and decision-making capacity; the functional impact of the cognitive impairment…',
      medicationsLabel: 'Medication Reconciliation (High-Risk / Deliriogenic)',
      medicationsPrompt: 'Reconcile medications with attention to high-risk/anticholinergic/deliriogenic drugs that impair cognition, and deprescribing opportunities…',
      neuroPsychPrompt: 'Neuropsychiatric and behavioral symptoms (agitation, psychosis, depression, apathy, sleep) with validated severity where used…',
      safetyEvalPrompt: 'Safety evaluation — wandering/elopement, falls, driving, home/room hazards, and medication self-administration…',
      caregiverPrompt: 'Caregiver identity, knowledge, willingness, and needs; caregiver strain and the support/resources arranged…',
      dementiaPlanPrompt: 'Individualized care plan — non-pharmacologic strategies, referrals, medication plan, and goals shared with the patient/caregiver…',
      timeSpentLabel: 'Total Time (99483 is time-based) & Attestation',
      timeSpentPrompt: 'Total time on the date of service performing the required elements (typically ≥60 minutes for 99483). Attest personal performance…',
    },
  ),
  // Death / Expiration — pronouncement, circumstances, exam, cause, and notifications.
  death: T(
    ['pronouncement', 'circumstances', 'exam', 'causeOfDeath', 'notifications'],
    {
      pronouncementPrompt: 'Date and time of death; absence of pulse, respiration, and heart/breath sounds; pupils fixed; and the name of the provider pronouncing…',
      circumstancesPrompt: 'Circumstances and clinical events preceding death — expected vs unexpected, code status honored, and whether death was anticipated (hospice/comfort care)…',
      examLabel: 'Examination Findings at Time of Death',
      examPrompt: 'Confirmatory exam findings supporting the pronouncement (no spontaneous respirations, no heart sounds, no response, fixed pupils)…',
      causeOfDeathPrompt: 'Immediate cause and the underlying/contributing cause(s) of death; whether the medical examiner’s office was notified if required…',
      notificationsLabel: 'Notifications (Family / Attending / Medical Examiner)',
      notificationsPrompt: 'Family/next of kin notified (who, when), attending physician notified, and — where applicable — the medical examiner and organ/tissue procurement organization…',
    },
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
      procedureNameLabel: 'Procedure Performed (Nerve / Fascial Plane Block) + CPT',
      procedureNamePrompt: 'Peripheral, sympathetic, or fascial plane block — specific nerve/plexus/plane (e.g. stellate ganglion, lumbar sympathetic, genicular, occipital, intercostal, ESP, TAP), laterality, and CPT…',
      indicationPrompt: 'Diagnostic and/or therapeutic block for the named neuropathic / sympathetically-mediated / truncal pain; failed conservative therapy…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Target / Guidance / Confirmation)',
      procTechniquePrompt: 'Sterile prep; sedation; target nerve/plexus and side; imaging guidance (fluoroscopy/US); needle placement and confirmation…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Neurostimulator — spinal cord (63650 · 63685) or peripheral nerve (64555 · 64575) trial / implant.
  pain_scs: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (SCS / PNS — Trial / Implant) + CPT',
      procedureNamePrompt: 'Spinal cord stimulator percutaneous trial (63650) or implant (63685), OR peripheral nerve stimulator trial/implant (64555 / 64575) — target nerve/level(s), lead(s), and device / manufacturer…',
      indicationPrompt: 'FBSS / CRPS / refractory neuropathic or peripheral nerve pain; failed conservative & interventional therapy; psychological clearance; (implant) documented trial ≥50% relief…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Lead Placement / Guidance / Mapping / Programming)',
      procTechniquePrompt: 'Sterile prep; sedation; access; lead advancement to target under fluoroscopy / ultrasound; paresthesia mapping / coverage; anchoring (implant); programming parameters…',
      postProcedureLabel: 'Post-Procedure Condition & Trial Instructions',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Intrathecal drug delivery pump — trial / implant / refill (62362 · 62367–62370 · 95990–95991).
  pain_pump: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Intrathecal Pump — Trial / Implant / Refill) + CPT',
      procedureNamePrompt: 'Intrathecal drug delivery — trial (62362), pump/catheter implant (62362 + 62350/62351), or refill & reprogramming (95990–95991) — device / manufacturer, catheter tip level…',
      indicationPrompt: 'Refractory cancer or non-cancer pain (or spasticity) failing systemic therapy; (implant) successful trial; documented goals of intrathecal therapy…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Access / Catheter Tip Level / Guidance / Programming)',
      procTechniquePrompt: 'Sterile prep; sedation; intrathecal access under fluoroscopy; catheter tip level; pocket (implant); pump programming (rate / dose)…',
      injectateLabel: 'Intrathecal Medication, Concentration & Dose',
      injectatePrompt: 'Agent (preservative-free morphine / ziconotide / baclofen / bupivacaine), concentration, daily dose (mcg or mg/day), reservoir volume, and any dose change…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Vertebral augmentation — kyphoplasty / vertebroplasty (22510–22515).
  pain_kypho: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'procFindings', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Kyphoplasty / Vertebroplasty) + CPT',
      procedureNamePrompt: 'Vertebral augmentation — kyphoplasty (balloon) or vertebroplasty; level(s) treated (e.g. T12, L1), approach (uni-/bipedicular), with CPT (22510–22515)…',
      indicationPrompt: 'Painful osteoporotic / neoplastic vertebral compression fracture with concordant point tenderness and MRI/CT edema (acute/subacute); failed conservative therapy…',
      consentLabel: 'Informed Consent & Pre-Procedure Time-Out',
      procTechniqueLabel: 'Technique (Approach / Guidance / Cavity Creation / Cement Fill)',
      procTechniquePrompt: 'Sterile prep; sedation; fluoroscopic guidance; trocar placement per level; (kypho) balloon inflation & cavity; cement (PMMA) volume per level; extravasation check…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Peripheral joint / bursa injection (20600–20611).
  pain_joint: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Joint / Bursa Injection) + CPT',
      procedureNamePrompt: 'Joint or bursa injection — site (shoulder / knee / hip / greater trochanteric bursa / small joint), laterality, and with/without ultrasound guidance (20600–20611)…',
      indicationPrompt: 'Osteoarthritis / bursitis / synovitis with concordant exam; failed conservative therapy (NSAIDs, activity modification, PT)…',
      consentLabel: 'Informed Consent & Time-Out',
      procTechniqueLabel: 'Technique (Site / Approach / Guidance / Aspiration)',
      procTechniquePrompt: 'Sterile prep; site and side; ultrasound or landmark guidance; aspiration if effusion; confirmation of intra-articular / intra-bursal placement…',
      injectateLabel: 'Medications Injected',
      injectatePrompt: 'Corticosteroid (agent & mg), local anesthetic (agent, %, mL), or viscosupplement; total volume…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
      timeSpentLabel: 'Total Procedure Time & Attestation',
    },
  ),
  // Botulinum toxin injection — chronic migraine (64615) / limb spasticity (64642–64647).
  pain_botox: T(
    ['procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'complications', 'postProcedure', 'timeSpent'],
    {
      procedureNameLabel: 'Procedure Performed (Botulinum Toxin Injection) + CPT',
      procedureNamePrompt: 'Botulinum toxin injection — indication & site: chronic migraine (64615, PREEMPT protocol) or limb/muscle spasticity (64642–64647); number of muscles/regions, with CPT…',
      indicationPrompt: 'Chronic migraine (≥15 headache days/month) failing preventives, OR focal spasticity/dystonia; document diagnosis and prior therapy…',
      consentLabel: 'Informed Consent & Time-Out',
      procTechniqueLabel: 'Technique (Muscles / Sites / Guidance)',
      procTechniquePrompt: 'Muscles/sites injected; anatomic vs EMG/ultrasound guidance for spasticity; injection pattern (e.g. PREEMPT for migraine)…',
      injectateLabel: 'Botulinum Toxin — Product, Total Units & Units per Site',
      injectatePrompt: 'Product (onabotulinumtoxinA / others), total units, and units per muscle/site; reconstitution…',
      postProcedureLabel: 'Post-Procedure Condition & Plan',
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
