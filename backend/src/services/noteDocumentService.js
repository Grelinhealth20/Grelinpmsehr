import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from 'docx';
import { uploadPatientObject, s3Enabled, listPatientKeys, ensurePatientFolder } from './s3Service.js';
import { logger } from '../config/logger.js';

/**
 * Render a signed clinical note to a Word (.docx) document and store it in the
 * patient's S3 folder as `PatientName_EncounterDate.docx`. Best-effort: a storage
 * failure never blocks the sign-off (the note is already finalized in the DB).
 */

export const NOTE_TITLES = {
  // SNF provider-focused note types.
  hp: 'SNF Admission History & Physical',
  soap: 'SNF SOAP Note',
  discharge: 'SNF Discharge Summary',
  hp_admission: 'History & Physical / Admission Note',
  progress: 'Progress Note',
  acute_visit: 'Acute / Sick Visit Note',
  change_in_condition: 'Change in Condition Note',
  follow_up: 'Follow-Up Note',
  regulatory: 'Regulatory / Periodic Visit Note',
  post_hospital: 'Post-Hospital / Readmission Note',
  medication: 'Medication Management Note',
  lab_imaging: 'Lab / Imaging Review Note',
  wound_care: 'Wound Care Note',
  advance_care: 'Advance Care Planning Note',
  discharge: 'Discharge Summary',
  procedure_note: 'Procedure Note',
  behavioral_health: 'Behavioral Health / Psychiatric Note',
  cognitive_care: 'Cognitive Assessment & Care Planning Note',
  death: 'Death / Expiration Note',
  // Pain Management
  pain_consult: 'Initial Pain Consultation',
  pain_followup: 'Pain Management Follow-Up Note',
  pain_med_mgmt: 'Controlled Substance / Medication Management Note',
  pain_esi: 'Epidural Steroid Injection — Procedure Note',
  pain_facet_mbb: 'Facet Injection / Medial Branch Block — Procedure Note',
  pain_rfa: 'Radiofrequency Ablation — Procedure Note',
  pain_si_joint: 'Sacroiliac Joint Injection — Procedure Note',
  pain_tpi: 'Trigger Point Injection — Procedure Note',
  pain_nerve_block: 'Nerve Block — Procedure Note',
  pain_scs: 'Neurostimulator (SCS / PNS) — Procedure Note',
  pain_pump: 'Intrathecal Pump — Procedure Note',
  pain_kypho: 'Vertebral Augmentation (Kyphoplasty / Vertebroplasty) — Procedure Note',
  pain_joint: 'Joint / Bursa Injection — Procedure Note',
  pain_botox: 'Botulinum Toxin Injection — Procedure Note',
  pain_uds: 'Urine Drug Screen / Toxicology Review',
  pain_discharge: 'Pain Management Discharge / Transition Note',
  // Transitional Care Management (TCM 99495 / 99496)
  tcm_face_to_face: 'Transitional Care Management — Face-to-Face Visit',
  tcm_initial_contact: 'TCM Initial Interactive Contact',
  tcm_discharge_review: 'TCM Discharge Information Review',
  tcm_med_reconciliation: 'TCM Medication Reconciliation',
  tcm_care_plan: 'Transitional Care Plan',
  tcm_non_face_to_face: 'TCM Non-Face-to-Face Care Management',
  tcm_follow_up: 'TCM Interim Follow-Up / Care Coordination',
  tcm_closeout: 'TCM 30-Day Service Period Close-Out',
  // SNF added note types.
  acuteChange: 'SNF Acute Change in Condition / Unscheduled Visit',
  acp: 'SNF Advance Care Planning Note',
  annual: 'SNF Annual Assessment / Comprehensive Visit',
  hospice: 'SNF Hospice Attending Physician / NPP Visit',
  telehealth: 'SNF Telehealth Visit Attestation',
  custom: 'Custom Clinical Note',
};

/** Document title for a note — the custom-template NAME for a custom note, else the note-type title. */
export function noteTitle(note = {}) {
  if (note.noteType === 'custom' && note.content?.templateName) return String(note.content.templateName);
  return NOTE_TITLES[note.noteType] || 'Clinical Note';
}

// Canonical section labels (must match the frontend note templates' section keys).
export const SECTION_LABELS = {
  chiefComplaint: 'Chief Complaint / Reason for Encounter',
  subjective: 'Subjective',
  objective: 'Objective',
  // SNF template sections
  skilledNeed: 'Skilled Need & Certification',
  rehabGoals: 'Rehab Goals & Expected Discharge',
  admissionOrders: 'Admission Orders Written',
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
  attestation: 'Attestation & Signature',
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
  // Pain Management
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
  // SNF added note types (acute change / ACP / annual / hospice / telehealth)
  diagnosisReview: 'Diagnosis List Review',
  prevention: 'Prevention & Screening',
  symptomAssessment: 'Symptom Assessment',
  telehealthEligibility: 'Telehealth Eligibility',
  locations: 'Patient & Provider Locations',
  staffPresent: 'Staff Present With Patient',
  examLimitations: 'Exam Performed & Limitations',
  technicalQuality: 'Technical Quality',
  prescriptionOrders: 'Medications / Prescription Orders',
  labOrders: 'Lab Orders',
  imagingOrders: 'Imaging Orders',
};
// Canonical clinical documentation order (Bates'/standard H&P). ROS is the LAST
// subjective element, right before the objective exam; functional status sits with
// the objective data. Used only as a fallback for legacy notes without a stored
// section order — new notes render in their own template order.
const SECTION_ORDER = [
  // Subjective
  'chiefComplaint', 'subjective', 'changeDescription', 'hpi', 'painHistory', 'painScale', 'interval', 'hospitalCourse',
  'dischargeInfo', 'interactiveContact', 'transitionGoals',
  'telehealthEligibility', 'consent', 'locations', 'staffPresent',
  'diagnosisReview', 'pmh', 'psh', 'familyHistory', 'socialHistory', 'psychHistory',
  'medications', 'medChanges', 'allergies', 'adverseEffects', 'priorTreatments',
  'pdmpReview', 'udsResult', 'opioidRisk', 'symptomAssessment', 'ros',
  // Objective
  'vitals', 'objective', 'exam', 'examLimitations', 'technicalQuality', 'mentalStatus', 'cognitiveAssessment', 'neuroPsych',
  'wound', 'treatment', 'results', 'prevention', 'functionalStatus',
  // Procedure body (kept together, in operative-note order)
  'procedureName', 'indication', 'consent', 'procTechnique', 'injectate', 'procFindings', 'specimen', 'ebl', 'complications', 'postProcedure',
  // Assessment
  'prognosis', 'carePlanReview', 'riskAssessment', 'safetyEval', 'caregiver', 'assessment', 'mdm',
  // Plan
  'tcmComplexity', 'plan', 'dementiaPlan', 'prescriptionOrders', 'labOrders', 'imagingOrders', 'orders', 'notifications',
  'pendingFollowUp', 'communityServices', 'caregiverEducation',
  'goals', 'participants', 'decisionsMade', 'codeStatus', 'advanceDirective', 'careCoordination',
  // Discharge block
  'dischargeDiagnoses', 'procedures', 'dischargeMeds', 'disposition', 'followUp', 'dischargeInstructions',
  // Death
  'pronouncement', 'circumstances', 'causeOfDeath',
  // Attestation
  'regulatoryAttestation', 'tcmAttestation', 'timeSpent', 'attestation', 'addendum',
];

// Note-type-specific section headings (mirror the UI templates so the Word
// record reads identically to what the provider saw on screen).
export const NOTE_LABEL_OVERRIDES = {
  // SNF note types — headings match the facility's SNF documentation templates exactly.
  hp: { chiefComplaint: 'Chief Complaint', codeStatus: 'Code Status', hospitalCourse: 'HPI', medications: 'Medications & Allergies', pmh: 'Past Medical History', socialHistory: 'Social History', vitals: 'Vitals', exam: 'Physical Examination', functionalStatus: 'Function & Cognition', results: 'Labs & Imaging', assessment: 'Assessment & Plan', timeSpent: 'Time / Complexity' },
  soap: { chiefComplaint: 'Chief Complaint', codeStatus: 'Code Status', hpi: 'HPI', allergies: 'Allergy', medications: 'Home Medications', results: 'Labs / Imaging / Microbiology', assessment: 'Assessment & Plan', vitals: 'Vitals' },
  progress: { chiefComplaint: 'Reason for Visit', interval: 'Interval History', medChanges: 'Medication Changes', vitals: 'Vitals', exam: 'Focused Exam', results: 'Labs & Results', assessment: 'Assessment & Plan', followUp: 'Follow-Up & Time' },
  discharge: { chiefComplaint: 'Reason for SNF Admission', hospitalCourse: 'Course in Facility', functionalStatus: 'Condition at Discharge', dischargeMeds: 'Discharge Medications', pendingFollowUp: 'Pending Items', followUp: 'Follow-Up Appointments', dischargeInstructions: 'Instructions Given', timeSpent: 'Time Spent on Discharge' },
  // SNF added note types — headings mirror the editor templates EXACTLY (PDF == on-screen note).
  acuteChange: { chiefComplaint: 'Reason for Unscheduled Visit', changeDescription: 'Presenting Change / Event', interval: 'Focused History', vitals: 'Vital Signs', exam: 'Focused Physical Examination', results: 'Labs / Tests', assessment: 'Assessment', disposition: 'Disposition: Treat in Place or Transfer', orders: 'Orders & Monitoring', timeSpent: 'Time / Complexity' },
  acp: { chiefComplaint: 'Reason for Discussion', participants: 'Participants & Capacity', goals: 'Discussion Summary', decisionsMade: 'Decisions & Documents Completed', timeSpent: 'Time Spent (ACP Only)', followUp: 'Follow-Up' },
  annual: { chiefComplaint: 'Reason for Annual Review', interval: 'Interval History (Past 12 Months)', diagnosisReview: 'Diagnosis List Review', medications: 'Medication Review', functionalStatus: 'Function, Cognition, Mood, Behavior', prevention: 'Prevention & Screening', vitals: 'Vital Signs', exam: 'Physical Examination', goals: 'Goals of Care Review', assessment: 'Assessment & Plan', timeSpent: 'Time / Complexity' },
  hospice: { chiefComplaint: 'Reason for Visit & Relation to Terminal Illness', interval: 'Interval History', symptomAssessment: 'Symptom Assessment', vitals: 'Vital Signs', exam: 'Physical Examination', goals: 'Goals of Care', assessment: 'Assessment & Plan', careCoordination: 'Coordination With Hospice & Family', timeSpent: 'Time / Complexity' },
  telehealth: { chiefComplaint: 'Visit This Attestation Attaches To', telehealthEligibility: 'Telehealth Eligibility', consent: 'Patient Consent', locations: 'Patient & Provider Locations', staffPresent: 'Staff Present With Patient', examLimitations: 'Exam Performed & Limitations', technicalQuality: 'Technical Quality', timeSpent: 'Time' },
  hp_admission: { chiefComplaint: 'Reason for Admission', results: 'Diagnostic Data on Admission', medications: 'Admission Medication Reconciliation', functionalStatus: 'Functional / Rehabilitation Status', prognosis: 'Rehabilitation Potential & Prognosis' },
  progress: { chiefComplaint: 'Reason for Visit', interval: 'Interval History (Since Last Visit)', exam: 'Focused Interval Examination' },
  acute_visit: { chiefComplaint: 'Presenting Acute Problem', exam: 'Focused Examination (Problem-Directed)', results: 'Point-of-Care / STAT Data' },
  change_in_condition: { exam: 'Focused Examination', orders: 'Interventions & STAT Orders' },
  follow_up: { chiefComplaint: 'Problem Being Followed Up', interval: 'Response Since Last Evaluation', exam: 'Focused Examination (Targeted to the Problem)', results: 'Repeat / Trending Results' },
  regulatory: { chiefComplaint: 'Purpose of Periodic Visit', interval: 'Interval Since Last Required Visit' },
  post_hospital: { chiefComplaint: 'Reason for Return / Readmission', dischargeDiagnoses: 'Hospital Discharge Diagnoses', medications: 'Medication Reconciliation (Post-Hospital)' },
  medication: { chiefComplaint: 'Reason for Medication Review', medications: 'Current Medication Regimen' },
  lab_imaging: { chiefComplaint: 'Result Being Reviewed', results: 'Result & Interpretation' },
  wound_care: { chiefComplaint: 'Reason for Wound Care', interval: 'Wound Progress Since Last Visit', exam: 'Relevant Physical Examination' },
  advance_care: { chiefComplaint: 'Reason for Advance Care Planning Discussion', timeSpent: 'Total Face-to-Face Time (required for 99497/99498)' },
  discharge: { hospitalCourse: 'Summary of SNF Stay', procedures: 'Significant Treatments / Procedures During Stay', functionalStatus: 'Functional Status at Discharge' },
  procedure_note: { timeSpent: 'Total Procedure Time & Attestation' },
  behavioral_health: { chiefComplaint: 'Reason for Psychiatric Visit', interval: 'Interval / Symptom Status', medications: 'Current Psychotropic Medications', assessment: 'Psychiatric Assessment (DSM-5 / ICD-10)' },
  cognitive_care: { chiefComplaint: 'Reason for Cognitive Assessment', functionalStatus: 'Functional Assessment (ADL / IADL)', medications: 'Medication Reconciliation (High-Risk / Deliriogenic)', timeSpent: 'Total Time (99483 is time-based) & Attestation' },
  death: { exam: 'Examination Findings at Time of Death', notifications: 'Notifications (Family / Attending / Medical Examiner)' },
  // Pain Management — headers mirror the UI templates exactly.
  pain_consult: { chiefComplaint: 'Reason for Pain Consultation', functionalStatus: 'Functional Impact of Pain (ADLs / Sleep / Mood / Work)', results: 'Diagnostic Studies Reviewed (MRI / CT / X-ray / EMG-NCS)', exam: 'Focused Musculoskeletal & Neurologic Examination', assessment: 'Pain Diagnosis & Medical Decision Making (ICD-10)', plan: 'Multimodal Pain Management Plan' },
  pain_followup: { chiefComplaint: 'Reason for Follow-Up', interval: 'Interval History Since Last Visit', exam: 'Focused Examination', assessment: 'Pain Assessment & MDM', plan: 'Pain Management Plan' },
  pain_med_mgmt: { chiefComplaint: 'Reason for Medication Review', interval: 'Interval, Pain Level & Functional Response', medications: 'Current Analgesic Regimen (incl. Controlled Substances)', assessment: 'Assessment & MDM', plan: 'Medication / Treatment Plan' },
  pain_esi: { procedureName: 'Procedure Performed (Epidural Steroid Injection) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Level / Approach / Laterality / Guidance)', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_facet_mbb: { procedureName: 'Procedure Performed (Facet Injection / Medial Branch Block) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Levels / Targets / Laterality / Guidance)', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_rfa: { procedureName: 'Procedure Performed (Radiofrequency Ablation) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'RFA Technique (Guidance / Sensory & Motor Testing / Lesioning)', injectate: 'Local Anesthetic / Steroid Administered', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_si_joint: { procedureName: 'Procedure Performed (Sacroiliac Joint Injection) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Approach / Guidance / Intra-articular Confirmation)', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_tpi: { procedureName: 'Procedure Performed (Trigger Point Injection) + CPT', consent: 'Informed Consent & Time-Out', procTechnique: 'Technique (Muscles & Number of Sites)', injectate: 'Medications Injected', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_nerve_block: { procedureName: 'Procedure Performed (Nerve / Fascial Plane Block) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Target / Guidance / Confirmation)', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_scs: { procedureName: 'Procedure Performed (SCS / PNS — Trial / Implant) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Lead Placement / Guidance / Mapping / Programming)', postProcedure: 'Post-Procedure Condition & Trial Instructions', timeSpent: 'Total Procedure Time & Attestation' },
  pain_pump: { procedureName: 'Procedure Performed (Intrathecal Pump — Trial / Implant / Refill) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Access / Catheter Tip Level / Guidance / Programming)', injectate: 'Intrathecal Medication, Concentration & Dose', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_kypho: { procedureName: 'Procedure Performed (Kyphoplasty / Vertebroplasty) + CPT', consent: 'Informed Consent & Pre-Procedure Time-Out', procTechnique: 'Technique (Approach / Guidance / Cavity Creation / Cement Fill)', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_joint: { procedureName: 'Procedure Performed (Joint / Bursa Injection) + CPT', consent: 'Informed Consent & Time-Out', procTechnique: 'Technique (Site / Approach / Guidance / Aspiration)', injectate: 'Medications Injected', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_botox: { procedureName: 'Procedure Performed (Botulinum Toxin Injection) + CPT', consent: 'Informed Consent & Time-Out', procTechnique: 'Technique (Muscles / Sites / Guidance)', injectate: 'Botulinum Toxin — Product, Total Units & Units per Site', postProcedure: 'Post-Procedure Condition & Plan', timeSpent: 'Total Procedure Time & Attestation' },
  pain_uds: { chiefComplaint: 'Reason for Toxicology Review', medications: 'Prescribed Controlled Substances', assessment: 'Interpretation & Assessment', plan: 'Action & Plan' },
  pain_discharge: { chiefComplaint: 'Reason for Discharge / Transition', interval: 'Summary of Pain Management Course & Functional Status', medications: 'Discharge Medication Reconciliation', assessment: 'Final Pain Assessment', plan: 'Discharge Plan & Instructions', followUp: 'Follow-Up & Care Coordination' },
  // Transitional Care Management (TCM 99495 / 99496) — headers mirror the UI templates exactly.
  tcm_face_to_face: { chiefComplaint: 'Reason for Post-Discharge Visit', interval: 'Status Since Discharge', exam: 'Focused Examination', medications: 'Medication Reconciliation (completed by the F2F date — required)' },
  tcm_initial_contact: { chiefComplaint: 'Purpose of Contact', medChanges: 'Immediate Medication Issues Identified', plan: 'Interim Plan & Next Steps' },
  tcm_discharge_review: { chiefComplaint: 'Purpose of Review', medications: 'Discharge Medication List (as documented)' },
  tcm_med_reconciliation: { chiefComplaint: 'Reason for Reconciliation', medications: 'Reconciled Medication List (Discharge vs Current)' },
  tcm_care_plan: { chiefComplaint: 'Purpose of the Transitional Care Plan', plan: 'Interventions & Coordination', followUp: 'Follow-Up Schedule & Readmission Prevention' },
  tcm_non_face_to_face: { chiefComplaint: 'Non-Face-to-Face Services Provided' },
  tcm_follow_up: { chiefComplaint: 'Reason for Interim Follow-Up', interval: 'Status Since Last Contact', plan: 'Interim Plan & Escalation' },
  tcm_closeout: { chiefComplaint: 'Purpose of Close-Out', interval: 'Summary of the 30-Day Transitional Period', medications: 'Final Reconciled Medication List', followUp: 'Ongoing Care Handoff' },
};

const BLUE = '2753B3';
const DARK = '091121';

// US date formatting. Input is ISO (YYYY-MM-DD); output MM/DD/YYYY (documents,
// display) or MM-DD-YYYY (filenames, where '/' is illegal).
function usDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : (iso || '');
}
function usDateFile(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}-${m[3]}-${m[1]}` : (iso || 'nodate');
}

function heading(text) {
  return new Paragraph({
    spacing: { before: 220, after: 80 },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 20, color: BLUE })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCD6EA' } },
  });
}
function body(text) {
  return (String(text || '').split(/\r?\n/)).map((line) => new Paragraph({
    spacing: { after: 40 }, children: [new TextRun({ text: line || ' ', size: 20, color: '1C2431' })],
  }));
}
function kv(label, value) {
  return new Paragraph({
    spacing: { after: 20 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 20, color: DARK }),
      new TextRun({ text: value || '—', size: 20, color: '1C2431' }),
    ],
  });
}

function rxTable(prescriptions) {
  const cell = (t, header) => new TableCell({
    width: { size: 16, type: WidthType.PERCENTAGE },
    shading: header ? { fill: 'EEF3FC' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(t || ''), bold: !!header, size: 18, color: header ? DARK : '1C2431' })] })],
  });
  const rows = [new TableRow({ tableHeader: true, children: ['Medication', 'Dose', 'Route', 'Frequency', 'Qty', 'Refills'].map((h) => cell(h, true)) })];
  for (const p of prescriptions) {
    rows.push(new TableRow({ children: [cell(p.drug), cell(p.dose), cell(p.route), cell(p.frequency), cell(p.quantity), cell(p.refills)] }));
    if (p.sig) rows.push(new TableRow({ children: [new TableCell({ columnSpan: 6, children: [new Paragraph({ children: [new TextRun({ text: `Sig: ${p.sig}`, italics: true, size: 18, color: '404A5A' })] })] })] }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

export async function buildNoteDocx({ patient, encounterDate, note, codes = { diagnoses: [], procedures: [] }, signerName, signedAt }) {
  const title = noteTitle(note);
  const children = [];

  if (patient.facilityName) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: patient.facilityName, bold: true, size: 24, color: DARK })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: title, bold: true, size: 22, color: BLUE })] }));

  children.push(kv('Patient', patient.name));
  children.push(kv('MRN', patient.mrn));
  if (patient.encounterNo) children.push(kv('Encounter ID', patient.encounterNo));
  if (patient.dob) children.push(kv('Date of Birth', usDate(patient.dob)));
  children.push(kv('Date of Service', usDate(encounterDate)));
  if (note.content?.encounterType?.display) children.push(kv('Encounter Type', `${note.content.encounterType.display} (SNOMED CT ${note.content.encounterType.code})`));
  if (note.reason) children.push(kv('Reason for Encounter', note.reason));

  // Vital signs at the top of the note.
  const vitals = note.content?.vitals || {};
  const VLABELS = { temp: 'Temp (°F)', hr: 'HR (bpm)', bp: 'BP', rr: 'RR', spo2: 'SpO₂ (%)', weight: 'Weight (lb)', pain: 'Pain (0–10)' };
  const vparts = Object.entries(VLABELS).map(([k, l]) => (vitals[k] ? `${l}: ${vitals[k]}` : null)).filter(Boolean);
  if (vparts.length) {
    children.push(heading('Vital Signs'));
    children.push(new Paragraph({ children: [new TextRun({ text: vparts.join('    •    '), size: 20, color: '1C2431' })] }));
  }

  const overrides = NOTE_LABEL_OVERRIDES[note.noteType] || {};
  // A custom template stores its OWN section list — prefer those heading labels so the downloaded
  // document shows exactly the headings the provider wrote. Then note-type overrides, then the canonical
  // dictionary, then the raw key as a last resort (never dropped).
  const customLabels = {};
  for (const s of (note.content?.customSections || [])) if (s && s.key) customLabels[s.key] = s.label || s.key;
  const labelFor = (key) => customLabels[key] || overrides[key] || SECTION_LABELS[key] || key;
  const sections = note.content?.sections || {};
  // Render in the note's OWN template order (matches the editor + the PDF exactly);
  // fall back to the canonical clinical order for legacy notes without a stored order.
  const storedOrder = note.content?.sectionOrder;
  const base = Array.isArray(storedOrder) && storedOrder.length
    ? [...storedOrder, ...SECTION_ORDER.filter((k) => !storedOrder.includes(k))]
    : SECTION_ORDER;
  // Append ANY saved section (text OR ticked checkboxes) not already ordered, so nothing filled in is
  // EVER dropped from the record — even a legacy/unknown key (the PDF's never-drop guarantee).
  const checks = note.content?.checks || {};
  const extraKeys = [...Object.keys(sections), ...Object.keys(checks)].filter((k, i, a) => !base.includes(k) && a.indexOf(k) === i);
  const order = [...base, ...extraKeys];
  for (const key of order) {
    const val = sections[key];
    const ticked = Array.isArray(checks[key]) ? checks[key].filter((x) => x && String(x).trim()) : [];
    const hasText = val && String(val).trim();
    if (!hasText && !ticked.length) continue; // section is empty — skip
    children.push(heading(labelFor(key)));
    if (ticked.length) children.push(new Paragraph({ children: [new TextRun({ text: ticked.map((t) => `☑ ${t}`).join('    '), size: 20, color: '1C2431' })] }));
    if (hasText) children.push(...body(val));
  }

  const rx = note.content?.prescriptions?.filter((p) => p && p.drug) || [];
  if (rx.length) { children.push(heading('Prescriptions')); children.push(rxTable(rx)); }

  // Coded diagnoses & procedures (Medicare Part B) — captured billable codes on the record.
  const dxs = (codes.diagnoses || []).filter((d) => d && d.icd);
  const pxs = (codes.procedures || []).filter((p) => p && p.cpt);
  if (dxs.length || pxs.length) {
    const cell = (t, header, span) => new TableCell({
      ...(span ? { columnSpan: span } : {}),
      children: [new Paragraph({ children: [new TextRun({ text: String(t ?? ''), bold: !!header, size: 18, color: header ? DARK : '1C2431' })] })],
    });
    children.push(heading('Coded Diagnoses & Procedures — Medicare Part B'));
    if (dxs.length) {
      const ordered = [...dxs].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
      const rows = [new TableRow({ tableHeader: true, children: ['', 'ICD-10-CM', 'Diagnosis', 'SNOMED CT'].map((h) => cell(h, true)) })];
      ordered.forEach((d) => rows.push(new TableRow({ children: [cell(d.primary ? 'Primary' : ''), cell(d.icd), cell(d.description), cell(d.snomedCode ? String(d.snomedCode) : '')] })));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
    }
    if (pxs.length) {
      const rows = [new TableRow({ tableHeader: true, children: ['CPT/HCPCS', 'Mod', 'Units', 'Procedure'].map((h) => cell(h, true)) })];
      pxs.forEach((p) => rows.push(new TableRow({ children: [cell(p.cpt), cell(p.modifiers || ''), cell(String(p.units || 1)), cell(p.description)] })));
      if (dxs.length) children.push(new Paragraph({ spacing: { before: 80 }, children: [] }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
    }
  }

  children.push(new Paragraph({ spacing: { before: 320 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCD6EA' } }, children: [] }));
  // System-composed compliance attestation captured on sign-off.
  const att = note?.content?.signedAttestation;
  if (att?.statement) {
    children.push(new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: 'ATTESTATION', bold: true, size: 16, color: '6B7688' })] }));
    children.push(new Paragraph({ children: [new TextRun({ text: att.statement, size: 19, color: DARK })] }));
    if (att.rendering?.name) {
      const rc = att.rendering.creds?.length ? `, ${att.rendering.creds.join(', ')}` : '';
      const rn = att.rendering.npi ? ` · NPI ${att.rendering.npi}` : '';
      children.push(new Paragraph({ children: [new TextRun({ text: `Rendering practitioner: ${att.rendering.name}${rc}${rn}`, size: 18, color: '404A5A' })] }));
    }
  }
  children.push(new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: `Electronically signed by ${signerName || 'Provider'}`, bold: true, size: 20, color: DARK })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: `Signed ${signedAt} · This note is finalized and ready for billing.`, size: 18, color: '404A5A' })] }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function safeName(patientName) {
  return String(patientName || 'Patient').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Patient';
}

/**
 * Generate + store the signed note in the patient's OWN S3 folder as
 * `PatientName_MM-DD-YYYY.docx`. If a note already exists for that patient + DOS
 * the filename is de-duplicated (`_2`, `_3`, …) so a second note NEVER overwrites
 * a prior one. Best-effort: a storage failure never blocks the sign-off.
 */
export async function storeSignedNoteDoc({ patientUuid, patientName, encounterDate, note, codes, signerName, signedAt, patient, s3ctx }) {
  if (!s3Enabled() || !patientUuid) return null;
  try {
    // The patient's hierarchical S3 folder (facility → provider → patient). Fall
    // back to at least the patient uuid if provider/facility context is missing.
    const ctx = s3ctx && s3ctx.patientUuid ? s3ctx : { patientUuid };
    try { await ensurePatientFolder(ctx); } catch { /* folder markers are best-effort */ }
    // Filename: PatientName_EncounterID_MM-DD-YYYY.docx
    const encId = patient?.encounterNo ? `${String(patient.encounterNo).replace(/[^A-Za-z0-9]/g, '')}_` : '';
    const base = `${safeName(patientName)}_${encId}${usDateFile(encounterDate)}`;
    const existing = new Set((await listPatientKeys(ctx, 'notes/')).map((k) => k.split('/').pop().toLowerCase()));
    let fileName = `${base}.docx`;
    for (let n = 2; existing.has(fileName.toLowerCase()); n += 1) fileName = `${base}_${n}.docx`;

    const buffer = await buildNoteDocx({ patient: { ...patient, name: patientName }, encounterDate, note, codes, signerName, signedAt });
    const key = await uploadPatientObject(ctx, `notes/${fileName}`, buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    logger.info({ key }, 'Signed note stored to patient folder');
    return key;
  } catch (e) {
    logger.error({ err: e.message }, 'Failed to store signed note document');
    return null;
  }
}
