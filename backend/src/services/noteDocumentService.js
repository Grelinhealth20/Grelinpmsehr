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
};

// Canonical section labels (must match the frontend note templates' section keys).
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
};
const SECTION_ORDER = [
  'chiefComplaint', 'changeDescription', 'hpi', 'interval', 'hospitalCourse', 'ros',
  'pmh', 'psh', 'familyHistory', 'socialHistory', 'psychHistory',
  'medications', 'medChanges', 'allergies', 'adverseEffects', 'vitals', 'exam',
  'mentalStatus', 'cognitiveAssessment', 'neuroPsych', 'wound', 'treatment', 'results',
  // Procedure body (kept together, in operative-note order)
  'procedureName', 'indication', 'consent', 'procTechnique', 'procFindings', 'specimen', 'ebl', 'complications', 'postProcedure',
  'carePlanReview', 'riskAssessment', 'safetyEval', 'caregiver', 'assessment', 'mdm', 'plan', 'dementiaPlan',
  'orders', 'notifications', 'prognosis',
  'goals', 'participants', 'decisionsMade', 'codeStatus', 'advanceDirective',
  'dischargeDiagnoses', 'procedures', 'functionalStatus', 'dischargeMeds', 'disposition',
  'followUp', 'dischargeInstructions', 'careCoordination', 'pronouncement', 'circumstances',
  'causeOfDeath', 'regulatoryAttestation', 'timeSpent', 'addendum',
];

// Note-type-specific section headings (mirror the UI templates so the Word
// record reads identically to what the provider saw on screen).
const NOTE_LABEL_OVERRIDES = {
  hp_admission: { chiefComplaint: 'Reason for Admission', results: 'Diagnostic Data on Admission', medications: 'Admission Medication Reconciliation', functionalStatus: 'Functional / Rehabilitation Status' },
  progress: { chiefComplaint: 'Reason for Visit', ros: 'Focused Review of Systems', exam: 'Focused Physical Examination' },
  acute_visit: { chiefComplaint: 'Presenting Problem', ros: 'Focused Review of Systems', exam: 'Focused Physical Examination' },
  change_in_condition: { exam: 'Focused Physical Examination' },
  follow_up: { chiefComplaint: 'Reason for Follow-Up', interval: 'Interval Since Last Evaluation', exam: 'Focused Physical Examination', results: 'Results / Findings Followed Up' },
  regulatory: { chiefComplaint: 'Purpose of Periodic Visit' },
  post_hospital: { chiefComplaint: 'Reason for Readmission', dischargeDiagnoses: 'Hospital Discharge Diagnoses', medications: 'Medication Reconciliation (Post-Hospital)' },
  medication: { chiefComplaint: 'Reason for Medication Review', results: 'Monitoring Labs / Levels' },
  lab_imaging: { chiefComplaint: 'Reason for Review', results: 'Results Reviewed & Interpretation' },
  wound_care: { chiefComplaint: 'Reason for Wound Care', interval: 'Wound Progress Since Last Visit', exam: 'Relevant Physical Examination' },
  advance_care: { chiefComplaint: 'Reason for Advance Care Planning Discussion', timeSpent: 'Total Time Spent (required for 99497/99498)' },
  discharge: { hospitalCourse: 'Summary of SNF Stay', functionalStatus: 'Functional Status at Discharge' },
  procedure_note: { timeSpent: 'Total Procedure Time & Attestation' },
  behavioral_health: { chiefComplaint: 'Reason for Psychiatric Visit', interval: 'Interval / Symptom Status', medications: 'Current Psychotropic Medications', assessment: 'Psychiatric Assessment (DSM-5 / ICD-10)' },
  cognitive_care: { chiefComplaint: 'Reason for Cognitive Assessment', functionalStatus: 'Functional Assessment (ADL / IADL)', medications: 'Medication Reconciliation (High-Risk Medications)', timeSpent: 'Total Time (99483 is time-based) & Attestation' },
  death: { exam: 'Examination Findings at Time of Death', notifications: 'Notifications (Family / Attending / Medical Examiner)' },
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

export async function buildNoteDocx({ patient, encounterDate, note, signerName, signedAt }) {
  const title = NOTE_TITLES[note.noteType] || 'Clinical Note';
  const children = [];

  if (patient.facilityName) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: patient.facilityName, bold: true, size: 24, color: DARK })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: title, bold: true, size: 22, color: BLUE })] }));

  children.push(kv('Patient', patient.name));
  children.push(kv('MRN', patient.mrn));
  if (patient.encounterNo) children.push(kv('Encounter ID', patient.encounterNo));
  if (patient.dob) children.push(kv('Date of Birth', usDate(patient.dob)));
  children.push(kv('Date of Service', usDate(encounterDate)));
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
  const sections = note.content?.sections || {};
  for (const key of SECTION_ORDER) {
    const val = sections[key];
    if (val && String(val).trim()) { children.push(heading(overrides[key] || SECTION_LABELS[key] || key)); children.push(...body(val)); }
  }

  const rx = note.content?.prescriptions?.filter((p) => p && p.drug) || [];
  if (rx.length) { children.push(heading('Prescriptions')); children.push(rxTable(rx)); }

  children.push(new Paragraph({ spacing: { before: 320 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCD6EA' } }, children: [] }));
  children.push(new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: `Electronically signed by ${signerName || 'Provider'}`, bold: true, size: 20, color: DARK })] }));
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
export async function storeSignedNoteDoc({ patientUuid, patientName, encounterDate, note, signerName, signedAt, patient, s3ctx }) {
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

    const buffer = await buildNoteDocx({ patient: { ...patient, name: patientName }, encounterDate, note, signerName, signedAt });
    const key = await uploadPatientObject(ctx, `notes/${fileName}`, buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    logger.info({ key }, 'Signed note stored to patient folder');
    return key;
  } catch (e) {
    logger.error({ err: e.message }, 'Failed to store signed note document');
    return null;
  }
}
