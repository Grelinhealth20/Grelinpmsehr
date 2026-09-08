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
  if (/\bpi\b|\bpip\b|\bbi\b|personal injury|bodily injury|\bmva\b|auto accident/i.test(n)) return 'pi';
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

/** The service line a note type belongs to. Prefix-authoritative (pi_/pain_/tcm_ → that line;
 *  anything else → SNF, the residual), consistent with the access-scope note predicate so a
 *  provider's create/edit gate and their read scope agree exactly. */
export function serviceForNoteType(noteType) {
  return lineForNoteType(noteType);
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
const sec = (key, label, prompt = '', rows = 3, checks = null, group = null) => ({
  key, label, prompt, rows, group: group || SEC_GROUP[key] || 'subjective', ...(checks ? { checks } : {}),
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

// ================= FLORIDA PERSONAL INJURY (PIP / BI) — service line 'pi' =========================
// Free-form section templates modeled on the SNF pattern; note types are prefixed `pi_` so the
// access-scope service-line filter (accessScope.lineNotePredicate) isolates them exactly like pain/tcm.
// Checkbox sets are the EXACT options from the source documents (no fabricated fields).
const O = 'objective', S = 'subjective', A = 'ap';
export const PI_NOTE_TEMPLATES = [
  {
    noteType: 'pi_initial', label: 'Initial Exam (MVA/PIP)', category: 'Initial Examination — Motor Vehicle Accident (Florida PIP · §627.736)', serviceLine: 'pi',
    sections: [
      sec('piInsurance', 'Patient, Visit & Insurance Details', 'Patient/DOB/sex/MRN; date & time of service; date of accident and days since; PIP carrier, claim #, policy #, adjuster; Med-Pay; attorney/firm; LOP on file; referral source and whether referred by attorney under LOP; health coverage at time of treatment; rendering & supervising provider.', 4, null, S),
      sec('piFirstVisitChecklist', 'First-Visit Compliance Checklist', 'Complete BEFORE the patient leaves — Florida PIP prerequisites (§627.736).', 3,
        ['Initial care within 14 days of the accident (§627.736(1)(a)) — else document first-care date & reason', 'Standard Disclosure & Acknowledgment (OIR-B1-1571) signed by patient & provider, copy retained', 'Assignment of Benefits (AOB) executed and retained', 'Photo ID + auto insurance card copied to chart', 'Crash report / exchange-of-information obtained or requested', 'EMC determination status addressed (Section: EMC)', 'Patient advised massage therapy & acupuncture are not PIP-reimbursable (§627.736(1)(a)5.)', 'If LOP: attorney-referral source & health-coverage status captured (§768.0427)'], S),
      sec('piMechanism', 'Mechanism of Injury', 'How the accident happened — date/time, location, patient role, vehicle type, impact direction, speed, seatbelt, airbag, head strike, loss of consciousness, body position, vehicle damage, towed, EMS/ER, police report #.', 4, null, S),
      sec('piComplaints', 'Complaints Today', 'What hurts now — each region with onset relative to the crash, severity (0–10), quality, radiation, aggravating/relieving factors, and effect on function/sleep.', 4, null, S),
      sec('piPrior', 'Prior Injuries & Conditions', 'Anything before this accident affecting the same regions — prior injuries, treatment, baseline status; degenerative/pre-existing conditions relevant to causation and apportionment.', 3, null, S),
      sec('piHistoryROS', 'Medical History & Review of Systems', 'PMH/PSH, medications, allergies, social history; pertinent review of systems (positives first).', 3, null, S),
      sec('piExam', 'Examination', 'Objective findings by region — inspection, palpation, ROM (with degrees), orthopedic/neurologic tests, motor/sensory/reflex, gait; documented deficits that support the diagnoses.', 4, null, O),
      sec('piImaging', 'Imaging & Tests — Reviewed and Ordered', 'Studies reviewed today (modality, date, facility, result) and studies ordered today with the clinical indication.', 3, null, O),
      sec('piDiagnoses', 'Diagnoses & Clinical Reasoning', 'Working diagnoses (ICD-10) with the reasoning linking exam/imaging findings to each; identify the pain generator(s).', 4, null, A),
      sec('piEmc', 'Emergency Medical Condition (EMC)', 'EMC determined, referred, or pending. If determined here, state the basis and conclusion.', 3,
        ['EMC determined at this visit', 'Referred for EMC determination', 'EMC pending — to be addressed'], A),
      sec('piCausation', 'Causation Opinion', 'Within a reasonable degree of medical probability, whether the accident caused the injuries; address aggravation of any pre-existing condition and apportionment.', 3, null, A),
      sec('piPlanWork', 'Treatment Plan & Work Status', 'Multimodal plan (frequency/duration), referrals, procedures, re-exam interval; work status and any restrictions.', 4, null, A),
      sec('piPrognosis', 'Prognosis & Patient Education', 'Expected course; what you explained to the patient (activity, home care, follow-up, return precautions).', 3, null, A),
      sec('piAttest', 'Sign & Attest', '"I personally performed this initial evaluation on the date of service." Credentials (MD/DO) and NPI; electronic signature and date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_soap', label: 'Daily Treatment (SOAP)', category: 'Daily Treatment SOAP Note — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piVisit', 'Visit Details', 'Date/time in–out, provider, treating diagnoses addressed today, visit number in the plan of care.', 2, null, S),
      sec('piSubjective', 'Subjective — Reported Today', 'Interval change since last visit — pain levels, functional change, new complaints, adherence to home program.', 3, null, S),
      sec('piObjective', 'Objective — Found Today', 'Exam/measures today; regions treated; objective response to prior treatment.', 3, null, O),
      sec('piServicesTimed', 'Services Rendered (record times for timed services)', 'Each service/modality with CPT and START/STOP or total minutes for timed codes; supervision as required.', 3, null, A),
      sec('piAssessment', 'Assessment — Progressing?', 'Is the patient progressing toward goals? Objective evidence; barriers.', 3, null, A),
      sec('piPlan', 'Plan — Next Steps', 'Continue/modify plan, next visit, any new orders or referrals; re-exam due.', 3, null, A),
    ],
  },
  {
    noteType: 'pi_reexam', label: 'Re-Examination / Progress', category: 'Re-Examination & Progress Evaluation — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piVisit', 'Visit Details', 'Date, provider, period covered since the last formal exam.', 2, null, S),
      sec('piInterval', 'Interval Report & Gaps in Care', 'Patient report since the last exam; document any gap in care with the reason.', 3, null, S),
      sec('piThenVsNow', 'Then vs. Now — Objective Comparison', 'Side-by-side objective comparison (ROM, strength, neuro, functional tests) versus baseline.', 4, null, O),
      sec('piOutcomeScores', 'Outcome Questionnaire Scores', 'Validated outcome measures (ODI / NDI / VAS / PSFS) with dates and change from baseline.', 2, null, O),
      sec('piUpdatedDx', 'Updated Diagnoses & Need for Continued Care', 'Updated diagnoses and the medical necessity rationale for continued treatment.', 3, null, A),
      sec('piUpdatedPlan', 'Updated Plan & Work Status', 'Revised plan, frequency/duration, work status/restrictions, next re-exam.', 3, null, A),
    ],
  },
  {
    noteType: 'pi_emc', label: 'EMC Determination', category: 'Emergency Medical Condition Determination (Florida PIP · §627.732/627.736)', serviceLine: 'pi',
    sections: [
      sec('piClaim', 'Patient & Claim Details', 'Patient, date of accident, PIP carrier, claim #, date of this determination.', 2, null, S),
      sec('piEmcDeterminer', 'Who Is Making This Determination? (check one — required)', 'Only a qualified provider type may render an EMC determination under Florida law.', 2,
        ['Physician, M.D. (Ch. 458)', 'Osteopathic Physician, D.O. (Ch. 459)', 'Dentist (Ch. 466)', 'Physician Assistant (Ch. 458/459)', 'Advanced Practice Registered Nurse (Ch. 464)'], S),
      sec('piEmcBasis', 'Basis of the Determination', 'What the determination rests on.', 2,
        ['In-person history and examination performed this date', 'Determination based on examination plus review of the records identified'], O),
      sec('piEmcDetermination', 'Determination — Is This an EMC?', 'State the conclusion. If EMC exists, check the qualifying criteria; if not, give the rationale below.', 3,
        ['EMC EXISTS', 'Serious jeopardy to patient health', 'Serious impairment to bodily functions', 'Serious dysfunction of a body organ or part', 'EMC DOES NOT EXIST'], A),
      sec('piEmcBenefits', 'What This Means for Benefits (billing team)', 'Effect on the PIP benefit level (EMC → up to $10,000; no EMC → up to $2,500). Note for the billing team.', 2, null, A),
      sec('piAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; electronic signature and date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_mri', label: 'Advanced Imaging / MRI Necessity', category: 'Advanced Imaging (MRI) Referral & Medical Necessity', serviceLine: 'pi',
    sections: [
      sec('piClaim', 'Patient & Claim Details', 'Patient, accident date, carrier/claim #, ordering provider.', 2, null, S),
      sec('piStudyOrdered', 'Study Ordered', 'Modality, body region/level, with or without contrast; laterality. Prior imaging of this region checked (none duplicative); MRI contraindications screened (implants, pacemaker, claustrophobia, renal function if contrast, pregnancy).', 3, null, O),
      sec('piMriReasons', 'Clinical Reasons (check all that apply)', 'The findings that justify advanced imaging.', 3,
        ['Radicular pain / paresthesia (dermatomal)', 'Objective neurologic deficit (motor/DTR/sensory)', 'Progressive neurologic deficit', 'Failed conservative care (weeks documented)', 'Persistent significant functional limitation', 'Suspected internal joint derangement', 'Suspected disc herniation with clinical correlation', 'Red flag: suspected fracture', 'Red flag: progressive weakness', 'Red flag: bowel/bladder change', 'Red flag: saddle anesthesia', 'Red flag: night pain / constitutional', 'Pre-procedural / surgical planning at specialist request'], A),
      sec('piMriSupport', 'Findings, Failed Care & Expected Impact', 'Exam/imaging findings, the conservative care already tried (duration and response), and how the MRI result will change management.', 4, null, A),
      sec('piAttest', 'Sign & Attest', 'Ordering provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_narrative', label: 'Final Narrative (MMI / LOP / BI)', category: 'Final Narrative — MMI, Discharge, LOP & Bodily-Injury Report', serviceLine: 'pi',
    sections: [
      sec('piReportDetails', 'Report Details', 'Patient, date of report, date of accident, claim/attorney reference.', 2, null, S),
      sec('piQualifications', 'Your Qualifications', 'Your training, licensure, board status and experience relevant to this opinion.', 2, null, S),
      sec('piRecordsReviewed', 'Records Reviewed', 'Every record relied on for this report (source and date).', 3, null, S),
      sec('piAccidentPresentation', 'Accident & Initial Presentation', 'The accident and how the patient first presented for care.', 3, null, S),
      sec('piImagingResults', 'Imaging & Test Results', 'Key imaging/test results with dates and relevance.', 3, null, O),
      sec('piTreatmentProvided', 'Treatment Provided — Start to Finish', 'The full course of care chronologically, with response.', 4, null, A),
      sec('piFinalExam', 'Final Examination — What Remains', 'Date and findings of the final exam; residual objective deficits.', 3, null, O),
      sec('piFinalDx', 'Final Diagnoses & Status at Discharge', 'Final diagnoses and each one’s status at discharge.', 3, null, A),
      sec('piMmi', 'Maximum Medical Improvement', 'MMI status.', 2,
        ['Patient reached MMI on the date stated (no further significant recovery reasonably expected)', 'Patient discharged prior to MMI — reason stated below'], A),
      sec('piImpairmentRating', 'Permanent Impairment Rating', 'Whole-person or regional impairment rating with the guide/edition used and the calculation.', 3, null, A),
      sec('piPermanency', 'Permanency Opinion (check the categories that apply)', 'Within a reasonable degree of medical probability.', 3,
        ['Significant & permanent loss of an important bodily function', 'Permanent injury (reasonable medical probability), other than scarring/disfigurement', 'Significant & permanent scarring or disfigurement', 'None of the above — no permanent injury within a reasonable degree of medical probability'], A),
      sec('piCausation', 'Causation', 'Whether the accident caused the injuries within a reasonable degree of medical probability; aggravation/apportionment of any pre-existing condition.', 3, null, A),
      sec('piFutureCare', 'Future Care & Estimated Cost', 'Anticipated future care and its estimated cost (for the demand package).', 3, null, A),
      sec('piRestrictions', 'Restrictions', 'What the patient can and cannot do (permanent restrictions).', 3, null, A),
      sec('piPrognosis', 'Prognosis', 'Long-term prognosis.', 2, null, A),
      sec('piBillingSummary', 'Billing Summary (LOP accounting / demand)', 'Itemized summary for the LOP ledger / demand package (coding/billing team prepares the CPT/HCPCS-coded ledger).', 3, null, A),
      sec('piLopDisclosure', 'LOP Litigation Disclosure Checklist (§768.0427)', 'Required disclosures where care was under a Letter of Protection.', 3,
        ['Copy of the LOP (or equivalent payment-from-settlement arrangement) included', 'Itemized CPT/HCPCS-coded billing ledger included', 'Whether AR was sold to a factoring company / third party disclosed (name, amount, discount)', 'Patient health-coverage status at time of treatment documented (and identity if covered)', 'Whether patient was referred for treatment under the LOP, and referrer identity, documented', 'Billing team aware: paid past medical expenses limited to amounts actually paid'], A),
      sec('piCertify', 'Sign & Certify', 'Certification of the opinions to a reasonable degree of medical probability; signature, credentials, NPI, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_procedure', label: 'Interventional Pain Procedure', category: 'Interventional Pain Procedure Note — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piClaim', 'Patient, Visit & Claim Details', 'Patient, date of service, accident date, carrier/claim #, provider.', 2, null, S),
      sec('piProcIndication', 'Indication', 'Why this procedure — diagnosis, failed conservative care, target level/joint, laterality.', 3, null, S),
      sec('piConsentTimeout', 'Consent & Time-Out (before needle)', 'Informed consent obtained; pre-procedure time-out completed.', 2,
        ['Informed consent obtained and documented', 'Time-out: correct patient, procedure, site/side, position confirmed'], A),
      sec('piProcDetails', 'Procedure Details', 'What was done — technique, level(s)/target, guidance (fluoro/US), needle, medication/agent and dose, contrast, images.', 4, null, A),
      sec('piProcResponse', 'Response & Complications', 'Immediate response (pain before/after), any complications, post-procedure neuro check.', 3, null, A),
      sec('piAftercare', 'Aftercare & Next Steps', 'Post-procedure instructions, expected course, follow-up / response assessment plan.', 3, null, A),
      sec('piAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_imaging', label: 'Imaging Result Review', category: 'Imaging Result Review & Plan Update — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piStudyDetails', 'Patient & Study Details', 'Patient, study modality/region, date performed, facility, reading radiologist.', 2, null, S),
      sec('piKeyFindings', 'Key Findings', 'The findings that matter clinically (your review, not just the filed report).', 3, null, O),
      sec('piCorrelation', 'Clinical Correlation', 'Does the study match the exam and complaints? Correlate to the pain generator.', 3, null, A),
      sec('piPlanUpdate', 'Plan Update', 'What changes as a result — treatment, referral, or procedure.', 3, null, A),
      sec('piPatientNotified', 'Patient Notified', 'How/when the patient was informed of results and the plan.', 2, null, A),
      sec('piAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_workstatus', label: 'Work Status Certificate', category: 'Work Status Certificate — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piExamDetails', 'Patient & Examination Details', 'Patient, date examined, diagnoses, employer/occupation if known.', 2, null, S),
      sec('piWorkStatus', 'Work Status (check one)', 'The certified work status and effective dates.', 2,
        ['FULL DUTY (no restrictions) as of the date stated', 'MODIFIED / LIGHT DUTY for the dates stated, subject to the restrictions below', 'UNABLE TO WORK for the dates stated — clinical basis below'], A),
      sec('piRestrictions', 'Restrictions (for modified duty)', 'Lifting limit; bending/twisting; standing/sitting tolerances with position-change intervals; climbing/driving; other specific restrictions.', 3, null, A),
      sec('piBasis', 'Basis for Certification', 'Objective clinical basis for the work status and restrictions.', 2, null, A),
      sec('piCertify', 'Sign & Certify', 'Provider signature, credentials, NPI, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_gap', label: 'Missed Appt / Gap in Care', category: 'Missed Appointment & Gap-in-Care Note — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piClaim', 'Patient & Claim Details', 'Patient, accident date, carrier/claim #, plan of care.', 2, null, S),
      sec('piMissedLog', 'Missed Appointment Log', 'Each missed/cancelled/no-show appointment with date and reason if known.', 3, null, S),
      sec('piGapExplain', 'Gap in Care — Explanation', 'Explain the gap (patient factors, scheduling, external) so the record shows continuity was pursued.', 3, null, A),
      sec('piComplianceCounsel', 'Compliance Counseling', 'What the patient was told about the importance of continued care and the risk of a care gap.', 2, null, A),
      sec('piAttest', 'Sign & Attest', 'Provider signature, credentials, NPI, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_referral', label: 'Referral / Consultation Request', category: 'Referral & Consultation Request — Personal Injury', serviceLine: 'pi',
    sections: [
      sec('piClaim', 'Patient & Claim Details', 'Patient, accident date, carrier/claim #, referring provider.', 2, null, S),
      sec('piReferredTo', 'Referred To', 'Consultant/specialty, facility, contact/fax, NPI.', 2, null, S),
      sec('piClinicalQuestion', 'Clinical Question & Summary', 'The specific question for the consultant and a concise clinical summary.', 3, null, A),
      sec('piRecordsSent', 'Records Sent With This Referral', 'Which records/imaging accompany the referral.', 2, null, A),
      sec('piLoopBack', 'Loop-Back (referring clinic use)', 'Consultant reply received / date; how findings were incorporated into the plan.', 2, null, A),
      sec('piSendAttest', 'Sign & Send', 'Referring provider signature, credentials, NPI, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pi_vob', label: 'PIP Benefits Verification (VOB)', category: 'PIP Benefits Verification / Verification of Benefits', serviceLine: 'pi',
    sections: [
      sec('piAccidentDetails', 'Patient & Accident Details', 'Patient, date of accident, state, vehicles/parties.', 2, null, S),
      sec('piCoveragePriority', 'Whose Policy Pays? (coverage priority)', 'Determine the priority PIP policy — patient’s own, resident relative, owner/operator of the vehicle, etc.', 3, null, S),
      sec('piVerificationCall', 'Verification Call / Portal Details', 'Carrier, phone/portal, reference #, representative, date/time of verification.', 2, null, O),
      sec('piBenefitDetails', 'Benefit Details (get every item)', 'PIP limit, deductible, % payable, EMC status effect, exhausted amount to date, remaining benefits, coordination with Med-Pay/health.', 3, null, A),
      sec('piClaimFlags', 'Claim-Status Flags (ask directly)', 'Any investigation, EUO requested, IME scheduled, denial/reduction, or benefits-exhausted flag.', 2, null, A),
      sec('piOtherPayers', 'Other Payers (after/alongside PIP)', 'Med-Pay, health insurance, third-party/BI order of payment.', 2, null, A),
      sec('piBiSnapshot', 'Third-Party / BI Snapshot (for the file)', 'At-fault carrier, BI limits if known, adjuster/claim # for the bodily-injury claim.', 2, null, A),
      sec('piReVerification', 'Re-Verification Log', 'Subsequent re-verifications with dates (benefits change as care accrues).', 2, null, A),
      sec('piVerifiedBy', 'Verified By', 'Staff who verified, signature/initials, date.', 2, null, A),
    ],
  },
];

// ================= PAIN MANAGEMENT — service line 'pain' ==========================================
// Free-form section templates; note types prefixed `pain_` for the access-scope service-line filter.
export const PAIN_NOTE_TEMPLATES = [
  {
    noteType: 'pain_initial', label: 'Initial Pain Consultation', category: 'Initial Pain Consultation — Comprehensive E/M', serviceLine: 'pain',
    sections: [
      sec('pnVisit', 'Patient & Visit Details', 'Patient, date/time, referral source, chief complaint.', 2, null, S),
      sec('pnPainStory', 'The Pain Story', 'Onset, location(s), radiation, quality, severity (0–10), timing, aggravating/relieving factors, functional impact, sleep.', 4, null, S),
      sec('pnPriorTx', 'Prior Treatment & Response', 'What has been tried (meds, PT, injections, surgery) and the response to each.', 3, null, S),
      sec('pnBackground', 'Medical Background', 'PMH/PSH, medications, allergies, relevant social/family history, substance history.', 3, null, S),
      sec('pnScreens', 'Screening Scores (mind & function)', 'Validated screens — pain/function (PEG, ODI/NDI), mood (PHQ/GAD), and any risk tools.', 2, null, O),
      sec('pnOpioidRisk', 'Opioid Risk & PDMP', 'Opioid risk stratification (e.g., ORT/DIRE), PDMP checked (date/state/findings), prior UDT.', 3, null, O),
      sec('pnExam', 'Examination', 'Focused musculoskeletal & neurologic exam — inspection, ROM, provocative tests, motor/sensory/reflex, gait.', 4, null, O),
      sec('pnImaging', 'Imaging & Tests Reviewed', 'Studies reviewed with dates and pertinent findings.', 3, null, O),
      sec('pnDiagnoses', 'Diagnoses & Pain Generators', 'Diagnoses (ICD-10) and the identified pain generator(s) with reasoning.', 3, null, A),
      sec('pnPlan', 'Multimodal Plan', 'Multimodal plan — non-opioid meds, PT/rehab, interventional options, behavioral, referrals; goals and follow-up.', 4, null, A),
      sec('pnEducation', 'Patient Education', 'What you told the patient — risks/benefits, expectations, self-management, safety.', 2, null, A),
      sec('pnEmLevel', 'Visit Level Support (MDM or Time — 2021 E/M)', 'Support the E/M level by MDM (problems/data/risk) or total time on the date of service.', 2, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_followup', label: 'Follow-Up / Medication Mgmt', category: 'Follow-Up Medication Management — Pain', serviceLine: 'pain',
    sections: [
      sec('pnVisit', 'Visit Details', 'Date/time, interval since last visit, treating diagnoses.', 2, null, S),
      sec('pnFiveAs', 'Since Last Visit — The Five A’s', 'Analgesia, Activities of daily living, Adverse effects, Aberrant behavior, Affect — with objective support.', 3, null, S),
      sec('pnRefillSafety', 'Refill Safety Checks (before any prescription)', 'PDMP reviewed, UDT status, agreement adherence, MME calculation, concurrent benzodiazepine/CNS check.', 3, null, O),
      sec('pnExam', 'Focused Examination', 'Focused exam pertinent to the pain complaint and therapy.', 3, null, O),
      sec('pnAssessment', 'Assessment — Is the Plan Working?', 'Function/analgesia vs. goals; is current therapy justified.', 3, null, A),
      sec('pnPlanRx', 'Plan & Prescriptions', 'Medication changes with rationale, dose/MME, quantity, monitoring; non-pharmacologic plan; follow-up.', 3, null, A),
      sec('pnEmLevel', 'Visit Level Support (MDM or Time)', 'Support the E/M level by MDM or total time.', 2, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_controlled', label: 'Controlled Substance Management', category: 'Controlled Substance Management — Opioid Stewardship', serviceLine: 'pain',
    sections: [
      sec('pnPrescriber', 'Patient & Prescriber Details', 'Patient, prescriber, DEA context, date.', 2, null, S),
      sec('pnRightTool', 'Is an Opioid the Right Tool?', 'Indication, prior non-opioid trials, expected benefit vs. risk, goals of therapy.', 3, null, S),
      sec('pnRiskStrat', 'Risk Stratification', 'Risk tools, PDMP, history of misuse/SUD, mental health, concurrent sedatives.', 3, null, O),
      sec('pnConsent', 'Informed Consent & Treatment Agreement', 'Consent and controlled-substance agreement signed; expectations, single-prescriber/pharmacy, UDT, refill rules.', 3, null, A),
      sec('pnPdmp', 'PDMP Check', 'State, date checked, findings, discrepancies addressed.', 2, null, O),
      sec('pnRx', 'The Prescription — Dose, MME & Safeguards', 'Drug, dose, quantity, MME/day, naloxone co-prescription, taper/limits, safeguards.', 3, null, A),
      sec('pnMonitoring', 'Monitoring Plan (written down)', 'UDT schedule, PDMP cadence, visit interval, functional goals monitored.', 3, null, A),
      sec('pnExit', 'Exit Criteria', 'Conditions that would trigger dose reduction, discontinuation, or referral.', 2, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_procedure', label: 'Interventional Procedure (LCD)', category: 'Interventional Procedure Note — LCD-Aligned', serviceLine: 'pain',
    sections: [
      sec('pnProcDetails', 'Patient & Procedure Details', 'Patient, date, procedure, target level(s)/joint, laterality, side.', 2, null, S),
      sec('pnLcdCase', 'Why This Procedure — Build the LCD Case', 'Diagnosis, conservative care and duration, prior response, indications meeting the applicable LCD/coverage policy.', 4, null, A),
      sec('pnConsentTimeout', 'Consent & Time-Out (before the needle)', 'Informed consent; time-out.', 2,
        ['Informed consent obtained and documented', 'Time-out: correct patient, procedure, site/side, position confirmed'], A),
      sec('pnDone', 'What Was Done', 'Technique, guidance (fluoro/US/CT), needle, medication/agent and dose, contrast, images, levels.', 4, null, A),
      sec('pnResponse', 'How the Patient Did', 'Immediate response (pre/post pain scores), complications, post-procedure neuro check.', 3, null, A),
      sec('pnNext', 'Counting & What Comes Next', 'Needle/sponge/instrument count if applicable; aftercare and follow-up/response assessment plan.', 3, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_udt', label: 'UDT Order & Review', category: 'Urine Drug Testing — Order & Result Review', serviceLine: 'pain',
    sections: [
      sec('pnTestDetails', 'Patient & Test Details', 'Patient, date, current controlled medications.', 2, null, S),
      sec('pnUdtNecessity', 'Why This Test — Medical Necessity', 'Risk-based rationale for testing at this interval (baseline/random/for-cause).', 3, null, A),
      sec('pnUdtOrdered', 'What You Ordered', 'Presumptive/definitive, specific analytes, and why.', 2, null, A),
      sec('pnUdtResult', 'The Result — Reviewed, Not Filed', 'Result, expected vs. unexpected findings, consistency with the prescribed regimen.', 3, null, O),
      sec('pnUdtAction', 'What You Did About It', 'Actions taken for any discrepancy (discussion, plan change, referral).', 3, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_reeval', label: 'Periodic Re-Evaluation', category: 'Periodic Re-Evaluation — Pain', serviceLine: 'pain',
    sections: [
      sec('pnVisit', 'Visit Details', 'Date, provider, period covered.', 2, null, S),
      sec('pnLookBack', 'What the Last Period Delivered', 'Objective function/analgesia change over the period; adherence; adverse effects.', 3, null, S),
      sec('pnStillEarning', 'Is Current Therapy Still Justified?', 'Benefit vs. risk of continuing current therapy; the hard question, answered with evidence.', 3, null, A),
      sec('pnExam', 'Focused Examination', 'Focused re-exam.', 3, null, O),
      sec('pnUpdatedDx', 'Updated Diagnoses', 'Updated problem list.', 2, null, A),
      sec('pnPlanAhead', 'The Plan Ahead', 'Continue/modify/taper/refer; goals and monitoring for the next period.', 3, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_postproc', label: 'Post-Procedure Block Response', category: 'Post-Procedure / Block Response — Pain', serviceLine: 'pain',
    sections: [
      sec('pnVisit', 'Visit Details', 'Date, prior procedure and date, target.', 2, null, S),
      sec('pnResponseNumbers', 'The Response Numbers', 'Pre/post pain scores, % relief, duration of relief, functional change (the numbers that drive coverage of a repeat/next step).', 3, null, O),
      sec('pnInterval', 'Interval Status & Focused Exam', 'Interval report and focused exam since the procedure.', 3, null, O),
      sec('pnAssessment', 'What It Means — Assessment', 'Interpretation of the response (diagnostic/therapeutic) and implications.', 3, null, A),
      sec('pnPlan', 'Plan', 'Next step — repeat, escalate, refer, or change modality.', 3, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_telehealth', label: 'Telehealth Visit', category: 'Telehealth Visit Note — Pain', serviceLine: 'pain',
    sections: [
      sec('pnTechDetails', 'Visit & Technology Details', 'Date/time, patient location, provider location, platform/modality.', 2, null, S),
      sec('pnTeleCompliance', 'Telehealth Compliance (check before you start)', 'Telehealth eligibility & consent for this encounter.', 2,
        ['Patient consent to telehealth obtained', 'Patient identity and location confirmed', 'Real-time audio-video (or audio-only where permitted)'], S),
      sec('pnVisitBody', 'The Visit — Same Standards as In-Person', 'History, observed exam within telehealth limits, and clinical decisions.', 4, null, O),
      sec('pnAssessPlan', 'Assessment & Plan', 'Assessment and plan; any need for in-person follow-up.', 3, null, A),
      sec('pnEmLevel', 'Visit Level Support (MDM or Time)', 'Support the E/M level by MDM or total time.', 2, null, A),
      sec('pnAttest', 'Sign & Attest', '"This service was furnished via telehealth." Credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_scs', label: 'SCS Trial & Outcome', category: 'Spinal Cord Stimulator Trial & Outcome', serviceLine: 'pain',
    sections: [
      sec('pnDeviceDetails', 'Patient & Device Details', 'Patient, date, device/system, indication.', 2, null, S),
      sec('pnCandidacy', 'Candidacy (complete BEFORE the trial)', 'Diagnosis, failed conservative/interventional care, psychological evaluation clearance, absence of contraindications.', 3, null, A),
      sec('pnTrial', 'The Trial — Placed & Programmed', 'Lead placement level(s), programming parameters, trial duration.', 3, null, A),
      sec('pnOutcome', 'Outcome — The Numbers That Decide', '% pain relief, functional change, medication change, patient satisfaction — the criteria for permanent implant.', 3, null, O),
      sec('pnCoordination', 'Plan & Coordination', 'Proceed to implant vs. not; coordination with surgeon/psych; next steps.', 3, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_telephone', label: 'Telephone / Portal Encounter', category: 'Telephone / Portal Encounter — Pain', serviceLine: 'pain',
    sections: [
      sec('pnContact', 'Contact Details', 'Date/time, who initiated, patient identity confirmed, duration.', 2, null, S),
      sec('pnRequest', 'What Was Requested / Reported', 'The patient’s request or report.', 3, null, S),
      sec('pnSafetyReview', 'Safety Review Before Any Action', 'PDMP/agreement/med-safety review before any medication action.', 2, null, O),
      sec('pnDecision', 'Decision & Action', 'Decision, advice, any prescription/order, and follow-up.', 3, null, A),
      sec('pnSignoff', 'Sign-Off', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_replyletter', label: 'Consultation Reply Letter', category: 'Consultation Reply Letter — Pain', serviceLine: 'pain',
    sections: [
      sec('pnRef', 'Reference Details', 'Referring provider, patient, date, reason for consult.', 2, null, S),
      sec('pnLetter', 'The Letter', 'The consultation reply — findings, impression, recommendations, and plan communicated to the referrer.', 6, null, A),
    ],
  },
  {
    noteType: 'pain_incidentto', label: 'Incident-To Supervision Attestation', category: 'Incident-To Supervision Attestation', serviceLine: 'pain',
    sections: [
      sec('pnEncounter', 'Encounter Details', 'Patient, date, rendering staff, supervising physician.', 2, null, S),
      sec('pnIncidentToTest', 'The Incident-To Test (every box, every time)', 'Incident-to requirements for this encounter.', 3,
        ['Established patient with an established plan of care', 'No new problem addressed at this visit', 'Supervising physician present in the office suite and immediately available', 'Service integral to the physician’s plan and personally initiated by the physician'], A),
      sec('pnAttestations', 'Attestations', 'Rendering-provider and supervising-physician attestations, credentials, NPIs, date.', 3, null, A),
    ],
  },
  {
    noteType: 'pain_abn', label: 'ABN Issuance Record', category: 'Advance Beneficiary Notice — Issuance Record', serviceLine: 'pain',
    sections: [
      sec('pnAbnService', 'Patient & Service Details', 'Patient, date, service/item that may be non-covered.', 2, null, S),
      sec('pnAbnReason', 'Why Medicare May Not Pay (check the genuine reason)', 'The specific coverage reason.', 2,
        ['Not medically necessary for this diagnosis/frequency', 'Experimental / investigational', 'Frequency limit exceeded', 'Other statutory non-coverage'], A),
      sec('pnAbnDelivery', 'Proper Delivery (confirm each element)', 'ABN delivered correctly.', 2,
        ['Delivered in advance, before the service', 'Reason and estimated cost stated', 'Patient chose an option and signed', 'Copy given to patient; original retained'], A),
      sec('pnAbnBilling', 'Billing Instruction to Coding Team', 'Modifier guidance (GA/GX/GY/GZ) for the coding team.', 2, null, A),
      sec('pnSignoff', 'Sign-Off', 'Staff/provider signature, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_priorauth', label: 'Medical Necessity / Prior-Auth Letter', category: 'Medical Necessity / Prior-Authorization Letter', serviceLine: 'pain',
    sections: [
      sec('pnRef', 'Reference Details', 'Payer, member/claim #, requested service/CPT, ordering provider.', 2, null, S),
      sec('pnLetter', 'The Letter — Build It in This Order', 'Diagnosis → failed conservative care → objective findings/imaging → guideline/LCD support → requested service → expected benefit.', 6, null, A),
      sec('pnEnclosures', 'Enclosures Checklist', 'Supporting documents attached (notes, imaging, prior treatment records).', 2, null, A),
      sec('pnSendAttest', 'Sign & Send', 'Provider signature, credentials, NPI, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_taper', label: 'Opioid Taper Plan', category: 'Opioid Taper Plan', serviceLine: 'pain',
    sections: [
      sec('pnBaseline', 'Patient & Baseline', 'Patient, current regimen and MME/day, duration of therapy.', 2, null, S),
      sec('pnTaperDriver', 'Why We Are Tapering (document the driver)', 'The clinical reason for tapering (risk, lack of benefit, patient goal, safety).', 3, null, A),
      sec('pnSchedule', 'The Schedule — Gradual by Design', 'Step-wise dose reductions with intervals and target; individualized pace.', 3, null, A),
      sec('pnTaperSupport', 'Support Around the Taper', 'Behavioral support, withdrawal management, naloxone, monitoring and follow-up.', 3, null, A),
      sec('pnAttest', 'Sign & Attest', 'Provider signature, credentials, NPI; date captured automatically.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_dme', label: 'DME Order (SWO + F2F)', category: 'DME Order — Standard Written Order & Face-to-Face', serviceLine: 'pain',
    sections: [
      sec('pnDmeItem', 'Patient & Item Details', 'Patient, date, DME item (HCPCS if known), supplier.', 2, null, S),
      sec('pnSwo', 'Standard Written Order (all elements present)', 'Beneficiary name, item, prescriber name & NPI, order date, prescriber signature — all present.', 2,
        ['Beneficiary name', 'Item of DME', 'Prescriber name & NPI', 'Order date', 'Prescriber signature'], A),
      sec('pnF2f', 'Face-to-Face & Medical Necessity (written for the item)', 'F2F encounter date and the clinical findings establishing medical necessity for THIS item.', 3, null, A),
      sec('pnSignOrder', 'Sign & Order', 'Prescriber signature, credentials, NPI, date.', 2, null, A),
    ],
  },
  {
    noteType: 'pain_discharge', label: 'Discharge / Care Transition', category: 'Discharge Summary & Care Transition — Pain', serviceLine: 'pain',
    sections: [
      sec('pnDischargeDetails', 'Patient & Discharge Details', 'Patient, date, reason category for discharge.', 2, null, S),
      sec('pnWhyEnding', 'Why Care Is Ending', 'Goals met / transfer / non-adherence / other — stated clearly.', 3, null, A),
      sec('pnCourse', 'Course of Care — The Summary', 'Summary of treatment and outcomes over the episode.', 3, null, A),
      sec('pnDischargeMeds', 'Medications at Discharge (handled safely)', 'Final medication list, any controlled-substance handoff/taper, last prescription details.', 3, null, A),
      sec('pnHandoff', 'Hand-Off', 'Receiving provider/PCP, records sent, follow-up arranged, patient instructions.', 3, null, A),
      sec('pnSignClose', 'Sign & Close', 'Provider signature, credentials, NPI, date.', 2, null, A),
    ],
  },
];

// Register the PIP/BI and Pain templates alongside the SNF set (all served through the same pipeline:
// draft/save/sign/PDF, isolation, pagination). Each carries a `serviceLine` so the picker + access scope
// show a provider ONLY their own line's templates — no cross-service-line leakage.
NOTE_TYPE_TEMPLATES.push(...PI_NOTE_TEMPLATES, ...PAIN_NOTE_TEMPLATES);

/** The service line a note type belongs to — prefix-authoritative (pi_/pain_/tcm_), else SNF/universal. */
function lineForNoteType(noteType) {
  if (String(noteType).startsWith('pi_')) return 'pi';
  if (String(noteType).startsWith('pain_')) return 'pain';
  if (String(noteType).startsWith('tcm_')) return 'tcm';
  return 'snf';
}

/**
 * Fresh, immutable copies of the note-type templates, FILTERED to the provider's service line(s). The
 * universal SNF set is always available; a specialty-line template (pi_/pain_/tcm_) is returned ONLY when
 * that line is among the provider's granted service lines — so a Pain provider never sees PI templates and
 * vice-versa (no cross-service-line leakage). Pass no lines → SNF/universal only (safe default).
 */
export function listNoteTypeTemplates(lines = []) {
  const has = new Set(Array.isArray(lines) ? lines : [lines].filter(Boolean));
  return NOTE_TYPE_TEMPLATES
    .filter((t) => { const line = t.serviceLine || lineForNoteType(t.noteType); return line === 'snf' || has.has(line); })
    .map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, ...(s.checks ? { checks: [...s.checks] } : {}) })) }));
}
export async function providerCanUseNoteType(providerId, noteType) {
  if (UNIVERSAL_NOTE_TYPES.has(noteType)) return true; // H&P / SOAP / Progress — open to all
  const typeLine = serviceForNoteType(noteType);
  if (!typeLine) return false;
  const lines = await providerServiceLines(providerId);
  return lines.includes(typeLine);
}

// SINGLE SOURCE OF TRUTH for note-type document metadata (title + section labels), built ONCE from
// NOTE_TYPE_TEMPLATES so the signed DOCX / PDF NEVER show a raw note_type or a raw section key. The
// document builders consult these before their own legacy maps. Pure, in-memory, no DB.
const NOTE_TYPE_TITLE = new Map();       // noteType -> descriptive document title
const NOTE_TYPE_SECTION_LABELS = new Map(); // noteType -> { key: label }
for (const t of NOTE_TYPE_TEMPLATES) {
  NOTE_TYPE_TITLE.set(t.noteType, t.category || t.label || null);
  const m = {};
  for (const s of t.sections) if (s && s.key) m[s.key] = s.label || s.key;
  NOTE_TYPE_SECTION_LABELS.set(t.noteType, m);
}

/** Descriptive document title for a note type (from its template), or null if unknown. */
export function noteTypeTitle(noteType) {
  return NOTE_TYPE_TITLE.get(noteType) || null;
}

/** Section key→label map for a note type (from its template); {} if unknown. A fresh copy per call
 *  so a caller can never mutate the shared reference. */
export function sectionLabelsForNoteType(noteType) {
  return { ...(NOTE_TYPE_SECTION_LABELS.get(noteType) || {}) };
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
