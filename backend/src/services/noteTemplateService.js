import { pool, execute } from '../db/pool.js';
import { providerServiceLines } from './accessScope.js';

/**
 * Note-template REGISTRY (the separate DB table that governs Pain vs SNF templates).
 *
 * Every clinical note template belongs to a SERVICE LINE — 'snf' or 'pain'. The
 * registry (persisted in `note_templates`) is the single source of truth for which
 * templates a provider may use: a provider whose specialty is Pain Management sees
 * ONLY the Pain templates, an SNF provider sees ONLY the SNF templates, and the two
 * sets can never cross over. Access is enforced here on the server — the UI filter is
 * advisory. Notes themselves still live in `encounter_notes`, so every existing note
 * behaviour (draft/sign/amend, PDF/Word, pagination, isolation) is unchanged.
 */

// The canonical registry — kept in sync with the frontend note templates. `menuGroup`
// splits the picker into "Common" vs "More"; `sortOrder` orders within a group.
export const NOTE_TEMPLATE_REGISTRY = []; // all templates removed

// Fast in-memory map: note_type -> service_line (the registry is small & static).
const SERVICE_BY_TYPE = new Map(NOTE_TEMPLATE_REGISTRY.map((r) => [r[0], r[1]]));

/**
 * Deterministic service line for a provider's specialty NAME. A specialty containing
 * the word "pain" → Pain Management; everything else → SNF (the default). Mirrors the
 * frontend exactly so the two never disagree.
 */
export function serviceForSpecialty(specialtyName) {
  const n = String(specialtyName || '');
  if (/\bpain\b/i.test(n)) return 'pain';
  if (/\btcm\b|transitional care/i.test(n)) return 'tcm';
  return 'snf';
}

/** Resolve a provider's PRIMARY service line (first of their assigned lines) — display only.
 *  Access decisions use the full set via providerServiceLines / providerCanUseNoteType. */
export async function providerServiceLine(providerId) {
  const lines = await providerServiceLines(providerId);
  return lines[0] || null; // no fallback — null when the provider has no specialty
}

// Re-export the authoritative multi-line resolver so callers have one template API surface.
export { providerServiceLines };

/** The service line a note type belongs to (null if unknown). */
export function serviceForNoteType(noteType) {
  return SERVICE_BY_TYPE.get(noteType) || null;
}

/** True iff this provider may create/edit a note of this type — i.e. the note type's
 *  service line is among the provider's granted specialties (multi-specialty aware). */
// The universal, provider-focused SNF note types every provider may write.
const UNIVERSAL_NOTE_TYPES = new Set(['hp', 'soap', 'progress', 'discharge',
  'acuteChange', 'acp', 'hospice', 'telehealth', 'custom']);

/**
 * BACKEND-AUTHORITATIVE note-type templates — the single source of truth for the note
 * section structure. Modeled on the facility's SNF documentation templates (Admission
 * H&P, SOAP, Progress, Discharge Summary). The editor FETCHES this (GET
 * /encounters/note-templates); the same section keys drive the signed document. Every
 * section is FREE-FORM (an open writing area). `group` is the SOAP division for layout;
 * `rows>=4` renders a taller box.
 */
const SEC_GROUP = {
  // Subjective
  chiefComplaint: 'subjective', subjective: 'subjective', hospitalCourse: 'subjective', hpi: 'subjective',
  interval: 'subjective', medications: 'subjective', medChanges: 'subjective', allergies: 'subjective',
  pmh: 'subjective', psh: 'subjective', socialHistory: 'subjective', familyHistory: 'subjective', ros: 'subjective',
  // Objective
  vitals: 'objective', exam: 'objective', objective: 'objective', functionalStatus: 'objective', results: 'objective',
  // Objective (new SNF note-type sections)
  symptomAssessment: 'objective', examLimitations: 'objective', technicalQuality: 'objective', prevention: 'objective',
  // Subjective (new SNF note-type sections)
  changeDescription: 'subjective', diagnosisReview: 'subjective', telehealthEligibility: 'subjective',
  locations: 'subjective', staffPresent: 'subjective', consent: 'subjective', participants: 'subjective',
  // Assessment & Plan
  codeStatus: 'ap', assessment: 'ap', plan: 'ap', attestation: 'ap', skilledNeed: 'ap', rehabGoals: 'ap', admissionOrders: 'ap',
  timeSpent: 'ap', dischargeDiagnoses: 'ap', dischargeMeds: 'ap', pendingFollowUp: 'ap', followUp: 'ap',
  homeServices: 'ap', dischargeInstructions: 'ap', disposition: 'ap', orders: 'ap', goals: 'ap',
  decisionsMade: 'ap', careCoordination: 'ap', results: 'objective', exam: 'objective', vitals: 'objective',
  prescriptionOrders: 'ap', labOrders: 'ap', imagingOrders: 'ap', carePlanReview: 'ap',
};
// A section is FREE-FORM by default; `checks` adds a set of discrete clinical checkboxes ABOVE the text
// area (the provider ticks what applies and can still type detail). Every key is explicitly grouped above.
const sec = (key, label, prompt = '', rows = 3, checks = null) => ({
  key, label, prompt, rows, group: SEC_GROUP[key] || 'subjective', ...(checks ? { checks } : {}),
});
export const NOTE_TYPE_TEMPLATES = [
  {
    noteType: 'hp', label: 'H&P', category: 'SNF Admission H&P · Physician E/M (Part B)',
    sections: [
      sec('chiefComplaint', 'Chief Complaint', 'One line — the problem you are evaluating at this initial visit (e.g. post-hospital hypoxia, uncontrolled diabetes, delirium).', 2),
      sec('codeStatus', 'Code Status', 'Full code / DNR / DNR-DNI / comfort care; who it was discussed with; healthcare proxy if known.', 2),
      sec('hospitalCourse', 'HPI', 'History of present illness / hospital course — why the patient went to the hospital, what was found and done (procedures with dates), complications, medication changes, and how they were on arrival; end with what is still active or unresolved.', 4),
      sec('medications', 'Medications & Allergies', 'Current medication list reviewed and reconciled; any change you made today and why; drugs needing lab monitoring; antibiotic/antifungal end dates; allergies with reaction.', 3),
      sec('pmh', 'Past Medical History', 'Conditions and surgeries with dates where they matter; devices present — pacemaker, stents, catheter, PEG, prosthetic joints.', 3),
      sec('socialHistory', 'Social History', 'Where and with whom the patient lived and how they got around before the hospital (independent, cane, walker, ADL help); tobacco, alcohol; family contact.', 3),
      sec('familyHistory', 'Family History', 'What was asked and answered; if the patient cannot answer, say so and who you asked.', 2),
      sec('ros', 'Review of Systems', 'Positives for this patient first, then “remaining systems negative”; if the patient cannot answer, name who gave the history.', 3),
      sec('exam', 'Physical Examination', 'Findings by system; every wound with site, side, stage, size, drainage, and whether present on admission; lines and tubes; a clear statement of orientation and mental status.', 4),
      sec('functionalStatus', 'Function & Cognition', 'Orientation or a cognitive screen; current mobility and ADLs; swallow/diet; fall risk.', 3),
      sec('results', 'Labs & Imaging', 'Hospital discharge summary reviewed (date); each lab and image with date and result that matters today; what you ordered and when.', 3),
      sec('assessment', 'Assessment & Plan', 'One paragraph per problem, most important first — full diagnosis, status (new/improving/stable/worsening), cause, and the plan (meds, monitoring, consults, return-to-hospital criteria). Name the intervention rather than “continue current care”.', 4),
      sec('carePlanReview', 'Care Plan Review', 'Interdisciplinary care plan established/reviewed — measurable goals & target dates, interventions, progress toward goals, and revisions ordered; coordination with nursing, therapy, dietary, and social services.', 3),
      sec('prescriptionOrders', 'Medications / Prescription Orders', 'Medications ordered at this visit — start / change / discontinue, with drug, dose, route, frequency, duration, and the clinical reason; controlled-substance and monitoring notes. Free text (scripts sent to the pharmacy are managed on the Prescriptions tab).', 3),
      sec('labOrders', 'Lab Orders', 'Laboratory tests ordered at this visit — panel / test name, priority (routine / STAT), and the clinical indication. Attach resulted lab reports for this encounter below.', 2),
      sec('imagingOrders', 'Imaging Orders', 'Imaging ordered at this visit — study, body region, contrast, priority, and the clinical indication. Attach imaging reports / films for this encounter below.', 2),
      sec('timeSpent', 'Time / Complexity', 'Total time today (including record review, exam, med reconciliation, orders, and discussion) or one line on why the admission was complex.', 2),
      sec('attestation', 'Attestation & Signature', '“I personally performed this initial comprehensive visit in its entirety on the date of service.” (The initial SNF visit is physician-performed — not a split/shared service.) Add your credentials (MD/DO) and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'soap', label: 'SOAP Note', category: 'SNF Follow-Up (SOAP) · Physician E/M (Part B)',
    sections: [
      sec('chiefComplaint', 'Chief Complaint', 'The conditions you came to manage today — name them; not “routine visit”.', 2),
      sec('codeStatus', 'Code Status', 'Full code / DNR / DNR-DNI / DNH / comfort care; who it was discussed with; healthcare proxy if known.', 2),
      sec('hpi', 'HPI', 'History of present illness — the story of today’s problem(s): onset and what changed since the last visit, response to treatment, associated symptoms, intake/weight trend, falls; who gave the history if not the patient.', 4),
      sec('allergies', 'Allergy', 'Drug / food / environmental allergies with reaction and severity, or NKDA — or reviewed in EMR.', 2),
      sec('medications', 'Home Medications', 'Current home / facility medications reviewed and reconciled; drugs needing monitoring; psychotropic indication / dose-reduction — or reviewed in EMR.', 3),
      sec('pmh', 'Past Medical History', 'Chronic conditions and past diagnoses (with ICD-10 where known) — or reviewed in EMR.', 2),
      sec('psh', 'Past Surgical History', 'Prior surgeries with approximate dates — or reviewed in EMR.', 2),
      sec('familyHistory', 'Family History', 'Relevant family history reviewed with the patient, or noncontributory / not obtainable (say why).', 2),
      sec('ros', 'Review of Systems', 'Positives for this patient first, then the pertinent-negative statement (e.g. “11-point ROS negative except as above”); note if ROS is limited by the patient’s neurological condition.', 3),
      sec('exam', 'Physical Examination', 'Vitals reviewed; General and by system (HEENT, Neck, Respiratory, Cardiovascular, GI, GU, Musculoskeletal, Skin, Neuro) — each wound with site / side / stage / size / drainage and whether present on admission; a clear statement of orientation and mental status.', 4),
      sec('results', 'Labs / Imaging / Microbiology', 'Labs, imaging, and microbiology reviewed — each with date and the result that matters today, or reviewed in EMR.', 3),
      sec('assessment', 'Assessment & Plan', 'Numbered by problem, most important first — each the full diagnosis with status and cause, then the plan (meds started/stopped/changed and why, monitoring, consults, orders, return criteria); include stable chronic conditions you are managing, plus fall prevention and wound care, and the total time / MDM supporting the E/M level.', 4),
      sec('prescriptionOrders', 'Medications / Prescription Orders', 'Medications ordered at this visit — start / change / discontinue, with drug, dose, route, frequency, duration, and the clinical reason; controlled-substance and monitoring notes. Free text (scripts sent to the pharmacy are managed on the Prescriptions tab).', 3),
      sec('labOrders', 'Lab Orders', 'Laboratory tests ordered at this visit — panel / test name, priority (routine / STAT), and the clinical indication. Attach resulted lab reports for this encounter below.', 2),
      sec('imagingOrders', 'Imaging Orders', 'Imaging ordered at this visit — study, body region, contrast, priority, and the clinical indication. Attach imaging reports / films for this encounter below.', 2),
      sec('attestation', 'Attestation & Signature', '“I personally performed the substantive portion of this evaluation and management service on the date of service.” For a split/shared or NPP visit, name the other practitioner and the collaborating/supervising physician. Add your credentials and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'progress', label: 'Progress Note', category: 'SNF Progress Note · Physician E/M (Part B)',
    sections: [
      sec('chiefComplaint', 'Reason for Visit', 'The problems you are here to manage today — name the conditions.', 2),
      sec('interval', 'Interval History', 'Since the last visit: symptoms, response to treatment, ED/hospital transfers with dates, response to treatment, intake and weight trend, sleep, behavior, falls; who gave the history if not the patient.', 4),
      sec('medChanges', 'Medication Changes', 'What you started, stopped, or changed and why; courses ending (stewardship review); psychotropic indication and any dose reduction; PRNs expiring; anything needing lab monitoring.', 3),
      sec('exam', 'Focused Exam', 'Systems relevant to today’s problems; wounds with site, side, stage, size, drainage; one clear statement of orientation and mental status; one line on mobility and function.', 3),
      sec('results', 'Labs & Results', 'Each result with date and value, trended against the previous value; what you ordered and when.', 3),
      sec('assessment', 'Assessment & Plan', 'Numbered by problem — full diagnosis, status (improving/stable/worsening/resolved), and what you are doing (drug, dose, monitoring, consult, return criteria). Name the intervention rather than “continue current care”.', 4),
      sec('carePlanReview', 'Care Plan Review', 'Interdisciplinary care plan reviewed at this visit — measurable goals & target dates, interventions, progress toward goals, and any revisions ordered; coordination with nursing, therapy, dietary, and social services.', 3),
      sec('prescriptionOrders', 'Medications / Prescription Orders', 'Medications ordered at this visit — start / change / discontinue, with drug, dose, route, frequency, duration, and the clinical reason; controlled-substance and monitoring notes. Free text (scripts sent to the pharmacy are managed on the Prescriptions tab).', 3),
      sec('labOrders', 'Lab Orders', 'Laboratory tests ordered at this visit — panel / test name, priority (routine / STAT), and the clinical indication. Attach resulted lab reports for this encounter below.', 2),
      sec('imagingOrders', 'Imaging Orders', 'Imaging ordered at this visit — study, body region, contrast, priority, and the clinical indication. Attach imaging reports / films for this encounter below.', 2),
      sec('followUp', 'Follow-Up & Time', 'When you will next see the patient and what nursing should call you for; total time on the date of the encounter or the complexity of medical decision making for the E/M level.', 2),
      sec('attestation', 'Attestation & Signature', '“I personally performed the substantive portion of this evaluation and management service on the date of service.” For a split/shared or NPP visit, name the other practitioner and the collaborating/supervising physician. Add your credentials and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'discharge', label: 'Discharge Summary', category: 'SNF Discharge · Physician E/M (Part B)',
    sections: [
      sec('chiefComplaint', 'Reason for SNF Admission', 'One or two lines — the hospitalization that led to this stay and the problems managed here.', 2),
      sec('hospitalCourse', 'Course in Facility', 'By problem, what happened during the stay — treatments, complications, hospital transfers with dates, consults, and the clinical trajectory. The next provider reads this first.', 4),
      sec('functionalStatus', 'Condition at Discharge', 'Vitals today; focused exam including any wounds with current stage and size; orientation and cognition; function achieved vs goals (transfers, walking distance, device, ADLs).', 3),
      sec('dischargeDiagnoses', 'Discharge Diagnoses', 'Numbered, most important first, each written fully with its status at discharge (resolved / improved / stable / ongoing).', 3),
      sec('dischargeMeds', 'Discharge Medications', 'Final reconciled list — mark clearly what is NEW, CHANGED (with old and new dose), and STOPPED compared with admission, and why; note courses still running and their end dates.', 3),
      sec('pendingFollowUp', 'Pending Items', 'Results not yet back, wounds still healing, catheter or line still in place and who manages it, referrals not yet scheduled.', 3),
      sec('followUp', 'Follow-Up Appointments', 'Who, when, and why — PCP, specialists, labs due; appointments already booked and those the patient must arrange.', 3),
      sec('homeServices', 'Home Services & Equipment', 'Home health (nursing, physical/occupational therapy), DME ordered (walker, commode, oxygen), and who arranged them.', 2),
      sec('dischargeInstructions', 'Instructions Given', 'What you told the patient and caregiver — warning signs, when to call, diet, activity, wound and catheter care; who was present and whether they understood.', 3),
      sec('timeSpent', 'Time Spent on Discharge', 'Total minutes on the discharge day — exam, medication reconciliation, instructions, coordination with home health and family, paperwork.', 2),
      sec('attestation', 'Attestation & Signature', '“I personally performed this discharge-day evaluation and management service.” For a split/shared or NPP visit, name the collaborating/supervising physician. Add your credentials and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'acuteChange', label: 'Acute Change / Unscheduled', category: 'SNF Acute Change in Condition · Unscheduled Visit (Part B)',
    sections: [
      sec('chiefComplaint', 'Reason for Unscheduled Visit', 'One line — the acute problem (fall, fever, new confusion, chest pain, low blood pressure, bleeding, respiratory distress).', 2),
      sec('changeDescription', 'Presenting Change / Event', 'What changed and WHEN — who reported it and the time the facility called you, the time you saw the patient; onset, severity, associated symptoms, and precipitating factors. Be specific to this patient today.', 4),
      sec('interval', 'Focused History', 'Relevant history for this acute problem — baseline status, related active diagnoses, recent medication or condition changes, code status.', 3),
      sec('exam', 'Focused Physical Examination', 'Problem-directed exam with the findings that drove your decision; a clear statement of orientation and mental status.', 4),
      sec('results', 'Labs / Tests', 'Point-of-care or STAT data reviewed with time and result; what you ordered and when.', 3),
      sec('assessment', 'Assessment', 'The working diagnosis for this change, its likely cause, and severity — named fully. Include the active problems it affects.', 3),
      sec('disposition', 'Disposition: Treat in Place or Transfer', 'State the decision AND why — what makes it safe to treat here, or what made transfer necessary; if transferred, where, how, and the time the transfer left.', 3,
        ['Treat in place', 'Increased monitoring in facility', 'Transfer to ED / hospital', 'Discussed with family / surrogate', 'Discussed with attending / on-call']),
      sec('orders', 'Orders & Monitoring', 'New or STAT orders — medications, labs, imaging, treatments, vitals frequency, and the parameters nursing should call you for.', 3),
      sec('prescriptionOrders', 'Medications / Prescription Orders', 'Medications ordered at this visit — start / change / discontinue, with drug, dose, route, frequency, duration, and the clinical reason; controlled-substance and monitoring notes. Free text (scripts sent to the pharmacy are managed on the Prescriptions tab).', 3),
      sec('labOrders', 'Lab Orders', 'Laboratory tests ordered at this visit — panel / test name, priority (routine / STAT), and the clinical indication. Attach resulted lab reports for this encounter below.', 2),
      sec('imagingOrders', 'Imaging Orders', 'Imaging ordered at this visit — study, body region, contrast, priority, and the clinical indication. Attach imaging reports / films for this encounter below.', 2),
      sec('timeSpent', 'Time / Complexity', 'Total time on the date of service, or one line on why the medical decision making was high complexity (unscheduled, acute, risk of deterioration).', 2),
      sec('attestation', 'Attestation & Signature', '"I personally performed this medically necessary unscheduled evaluation and management service on the date of service." Add your credentials (MD/DO/NPP) and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'acp', label: 'Advance Care Planning', category: 'SNF Advance Care Planning · Physician / NPP Service (Part B)',
    sections: [
      sec('chiefComplaint', 'Reason for Discussion', 'Why this conversation is happening now — new diagnosis, change in condition, patient/family request, or routine review.', 2),
      sec('participants', 'Participants & Capacity', 'Who took part (patient, surrogate/POA, family, staff) and the patient’s decision-making capacity. This is a voluntary discussion.', 3,
        ['Patient participated', 'Surrogate / POA participated', 'Family participated', 'Patient has decision-making capacity', 'Patient lacks capacity — surrogate decided', 'Discussion was voluntary']),
      sec('goals', 'Discussion Summary', 'What was actually discussed in this patient’s own situation — prognosis, values, and treatment preferences (CPR, intubation, hospitalization, artificial nutrition, comfort care). A real conversation, not a form.', 4),
      sec('decisionsMade', 'Decisions & Documents Completed', 'What was decided or deliberately left open, and which documents were completed or updated.', 3,
        ['Full code', 'DNR', 'DNR / DNI', 'DNH (do not hospitalize)', 'Comfort-focused care', 'POLST / MOLST completed', 'Healthcare surrogate designated', 'Living will on file', 'No decision reached today']),
      sec('timeSpent', 'Time Spent (ACP Only)', 'Total minutes spent on THIS advance-care-planning conversation alone (separate from any same-day visit) — required for 99497 (first 30 min) / +99498 (each additional 30 min).', 2),
      sec('followUp', 'Follow-Up', 'What happens next — documents to complete, who will be informed, and when this will be revisited.', 2),
      sec('attestation', 'Attestation & Signature', '"I personally performed this advance care planning discussion." Note whether it was separate from, or in addition to, a same-day E/M visit. Add your credentials and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'hospice', label: 'Hospice Attending Visit', category: 'SNF Hospice Attending Physician / NPP Visit (Part B)',
    sections: [
      sec('chiefComplaint', 'Reason for Visit & Relation to Terminal Illness', 'Why you saw the patient today, and whether this visit is RELATED or UNRELATED to the terminal illness — say so explicitly (it determines billing).', 3,
        ['Related to terminal illness', 'Unrelated to terminal illness', 'Designated attending (not hospice-employed)']),
      sec('interval', 'Interval History', 'Changes since the last visit — symptom trajectory, function, intake, and any events; who gave the history.', 3),
      sec('symptomAssessment', 'Symptom Assessment', 'Comfort-focused symptom review — pain, dyspnea, nausea, agitation, secretions, bowel function; severity and response to current measures.', 4),
      sec('exam', 'Physical Examination', 'Focused, comfort-directed exam; a clear statement of orientation and mental status; any wounds.', 3),
      sec('goals', 'Goals of Care', 'Current goals and preferences; code status; any changes in the patient’s or family’s wishes.', 3),
      sec('assessment', 'Assessment & Plan', 'Problem by problem — comfort-focused plan, medication changes, and whether each problem relates to the terminal illness. Coordinate so two teams are not prescribing in parallel.', 4),
      sec('prescriptionOrders', 'Medications / Prescription Orders', 'Comfort-focused medications ordered at this visit — start / change / discontinue, with drug, dose, route, frequency, and the clinical reason; coordinate with the hospice team so orders do not conflict. Free text (scripts sent to the pharmacy are managed on the Prescriptions tab).', 3),
      sec('labOrders', 'Lab Orders', 'Laboratory tests ordered at this visit — panel / test name, priority, and the clinical indication (kept comfort-focused for hospice). Attach resulted lab reports for this encounter below.', 2),
      sec('imagingOrders', 'Imaging Orders', 'Imaging ordered at this visit — study, region, priority, and the clinical indication (kept comfort-focused for hospice). Attach imaging reports for this encounter below.', 2),
      sec('careCoordination', 'Coordination With Hospice & Family', 'Who ordered what — record coordination with the hospice team and nurse, and what the family was told, so the attending and hospice plans do not conflict.', 3),
      sec('timeSpent', 'Time / Complexity', 'Total time on the date of service, or the medical decision making supporting the E/M level.', 2),
      sec('attestation', 'Attestation & Signature', '"I am the patient’s designated attending physician (not employed by the hospice) and personally performed this visit." Add your credentials and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
  {
    noteType: 'telehealth', label: 'Telehealth Attestation', category: 'SNF Telehealth Visit Attestation · Addendum (Part B)',
    sections: [
      sec('chiefComplaint', 'Visit This Attestation Attaches To', 'The date and type of the visit note this attaches to (Progress / SOAP). Telehealth is allowed only for medically necessary follow-up — not the initial or required periodic visits.', 2),
      sec('telehealthEligibility', 'Telehealth Eligibility', 'Confirm this is a medically necessary follow-up visit eligible for telehealth (not the initial comprehensive or a federally required in-person visit).', 2,
        ['Medically necessary follow-up', 'Not the initial comprehensive visit', 'Not a required periodic (in-person) visit']),
      sec('consent', 'Patient Consent', 'Consent to a telehealth encounter obtained for this visit.', 2,
        ['Verbal consent obtained', 'Written consent on file', 'Consent by surrogate / representative']),
      sec('locations', 'Patient & Provider Locations', 'Where the patient was (facility / room) and where you were during the encounter (originating and distant site).', 2),
      sec('staffPresent', 'Staff Present With Patient', 'Facility staff present with the patient during the encounter, if any (name and role), and their assisting role.', 2),
      sec('examLimitations', 'Exam Performed & Limitations', 'What of the assessment/exam was possible over video (or audio) and any limitations; the visit itself is documented in the attached note.', 3),
      sec('technicalQuality', 'Technical Quality', 'Audio-video quality adequate for the clinical decisions made; any interruptions or fallback to audio-only.', 2,
        ['Real-time audio-video', 'Audio-only (where permitted)', 'Quality adequate for clinical decisions']),
      sec('timeSpent', 'Time', 'Total time of the telehealth encounter on the date of service, if time-based.', 2),
      sec('attestation', 'Attestation & Signature', '"This service was furnished via telehealth as attested above; the billing team applies the telehealth modifier and place of service." Add your credentials and NPI. Your electronic signature and date are captured automatically.', 2),
    ],
  },
];
/** Fresh, immutable copies of the note-type templates (no shared reference). */
export function listNoteTypeTemplates() {
  return NOTE_TYPE_TEMPLATES.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, ...(s.checks ? { checks: [...s.checks] } : {}) })) }));
}
export async function providerCanUseNoteType(providerId, noteType) {
  if (UNIVERSAL_NOTE_TYPES.has(noteType)) return true; // H&P / SOAP / Progress — open to all
  const typeLine = serviceForNoteType(noteType);
  if (!typeLine) return false;
  const lines = await providerServiceLines(providerId);
  return lines.includes(typeLine);
}

// Pre-built, per-service-line template lists (immutable static reference data). Built
// ONCE at module load from the registry so the hot path (every note-picker open,
// potentially thousands of concurrent providers) is served from MEMORY with zero DB
// round-trips. The note_templates DB table remains the durable/seeded source of truth;
// it and this const are populated from the SAME registry, so they never disagree.
const TEMPLATES_BY_LINE = (() => {
  const by = { snf: [], pain: [], tcm: [] };
  for (const r of NOTE_TEMPLATE_REGISTRY) {
    by[r[1]].push({ noteType: r[0], serviceLine: r[1], label: r[2], category: r[3], cpt: r[4], menuGroup: r[5], sortOrder: r[6] });
  }
  for (const k of Object.keys(by)) {
    by[k].sort((a, b) => (Number(b.menuGroup === 'common') - Number(a.menuGroup === 'common')) || a.sortOrder - b.sortOrder);
    Object.freeze(by[k]);
  }
  return by;
})();

/**
 * Templates available to a service line, ordered for the picker. Served from the
 * in-memory registry (no DB query) — a fresh array copy per call so a caller can never
 * mutate the shared list (no cross-request leakage of the reference data).
 */
export function listTemplatesForServiceLine(serviceLine) {
  const line = ['snf', 'pain', 'tcm'].includes(serviceLine) ? serviceLine : 'snf';
  return (TEMPLATES_BY_LINE[line] || []).map((t) => ({ ...t }));
}

/**
 * Templates available across a SET of service lines (a multi-specialty provider) — the
 * de-duplicated UNION, ordered common-first then by sort order. Fresh copies (no shared
 * reference). A provider granted SNFs + Pain sees both lines' templates in one picker.
 */
export function listTemplatesForServiceLines(lines) {
  const set = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
  // NO FALLBACK: an empty set (provider with no specialty) yields NO templates.
  const wanted = [...new Set(set)];
  const seen = new Set();
  const out = [];
  for (const line of wanted) {
    for (const t of listTemplatesForServiceLine(line)) {
      if (seen.has(t.noteType)) continue;
      seen.add(t.noteType);
      out.push(t);
    }
  }
  // Common group first, then by the registry sort order — stable across lines.
  out.sort((a, b) => (Number(b.menuGroup === 'common') - Number(a.menuGroup === 'common')) || a.sortOrder - b.sortOrder);
  return out;
}

/** Idempotently seed/refresh the registry table (called on migration/boot). */
export async function seedNoteTemplates() {
  // Templates removed: the registry is empty, so the note_templates table is cleared
  // (no rows seeded). Existing clinical notes in encounter_notes are untouched.
  if (!NOTE_TEMPLATE_REGISTRY.length) {
    await pool.query('DELETE FROM note_templates');
    return 0;
  }
  await pool.query(
    `INSERT INTO note_templates (note_type, service_line, label, category, cpt, menu_group, sort_order, active)
       VALUES ?
     ON DUPLICATE KEY UPDATE
       service_line = VALUES(service_line), label = VALUES(label), category = VALUES(category),
       cpt = VALUES(cpt), menu_group = VALUES(menu_group), sort_order = VALUES(sort_order), active = 1`,
    [NOTE_TEMPLATE_REGISTRY.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], 1])],
  );
  return NOTE_TEMPLATE_REGISTRY.length;
}
