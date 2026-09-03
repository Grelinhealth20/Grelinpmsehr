/**
 * CMS-compliant checkbox options per clinical heading — distilled from the facility's SNF provider
 * templates (SNF_Provider_Templates_v2026.1). Keyed by the system's canonical section key, so when a
 * provider adds a heading in the custom-template builder, its ready-made compliance checkboxes appear
 * automatically. Options are discrete and comma-free (the builder stores checks comma-separated).
 *
 * This is REFERENCE DATA for the builder only — it never modifies existing note-type templates or any
 * note already created. A provider can edit, add to, or clear these after they auto-populate.
 */
export const HEADING_CHECKS = {
  codeStatus: ['Full code', 'DNR', 'DNR/DNI', 'Comfort care', 'Discussed with patient/surrogate'],
  allergies: ['NKDA', 'Allergies listed with reactions'],
  medications: ['MAR reviewed today', 'No changes today', 'Changes listed below', 'High-risk: Anticoagulant',
    'High-risk: Insulin', 'High-risk: Opioid', 'High-risk: Antipsychotic', 'High-risk: Benzodiazepine',
    'Antibiotic/antifungal — end date noted'],
  medChanges: ['MAR reviewed today', 'No changes today', 'Changes listed below', 'High-risk: Anticoagulant',
    'High-risk: Insulin', 'High-risk: Opioid', 'High-risk: Antipsychotic', 'High-risk: Benzodiazepine',
    'Antibiotic/antifungal — end date noted'],
  pmh: ['Devices: Foley', 'Ureteral stent', 'PICC/port', 'PEG', 'Pacemaker/ICD', 'Prosthetic joint'],
  psh: ['Prior surgeries listed with dates', 'None', 'Unable to obtain'],
  socialHistory: ['Lived alone', 'Lived with family', 'ALF', 'LTC', 'Prior mobility independent',
    'Cane', 'Walker', 'Wheelchair', 'Tobacco: never', 'Tobacco: former', 'Tobacco: current'],
  familyHistory: ['Reviewed — pertinent findings listed', 'Noncontributory', 'Unable to obtain'],
  ros: ['Fever', 'Weight loss', 'Fatigue', 'Poor intake', 'Chest pain', 'Edema', 'SOB', 'Cough',
    'Nausea', 'Constipation', 'Diarrhea', 'Dysphagia', 'Dysuria', 'Hematuria', 'Urinary retention',
    'Weakness', 'Dizziness', 'Confusion', 'Anxiety', 'Depressed mood', 'Agitation', 'Sleep disturbance',
    'Wound', 'Rash', 'Fall since last visit', 'Remaining systems negative', 'Limited ROS — history from other source'],
  exam: ['No acute distress', 'Distress', 'Oriented', 'Confused', 'Lethargic', 'Lungs clear', 'Crackles',
    'Wheeze', 'Heart regular', 'Irregular rhythm', 'Murmur', 'Abdomen soft/non-tender', 'Tender', 'Distended',
    'No edema', 'Edema present', 'No catheter', 'Foley in place', 'Skin intact', 'Wound(s) present', 'No focal deficit', 'Focal deficit'],
  functionalStatus: ['Mobility independent', 'Setup assist', 'Partial assist', 'Substantial assist', 'Dependent',
    'Device: none', 'Cane', 'Walker', 'Wheelchair', 'Fall risk low', 'Fall risk moderate', 'Fall risk high',
    'Diet regular', 'Mechanical soft', 'Puree', 'Thickened liquids', 'NPO/tube feeding'],
  results: ['Results reviewed and listed with dates', 'No new results since last visit', 'Ordered: BMP',
    'CBC', 'UA/culture', 'Chest X-ray', 'ECG', 'Other'],
  assessment: ['Fall precautions', 'Pressure-injury prevention', 'Aspiration precautions', 'Strict I&O',
    'Wound care', 'PT', 'OT', 'SLP', 'Dietitian', 'Consult ordered'],
  disposition: ['Treat in place', 'Increased monitoring in facility', 'Transfer to ED/hospital',
    'Direct admit', 'Comfort-focused care per goals', 'Family/surrogate notified', 'Handoff given'],
  orders: ['Vitals q shift', 'Neuro checks', 'Strict I&O', 'Oral fluids', 'IV fluids', 'Oxygen', 'Hold medication'],
  followUp: ['Next required visit', 'Sooner — as noted', 'Nursing to call for changes'],
  carePlanReview: ['Care plan reviewed', 'Measurable goals & target dates set', 'Progress toward goals noted',
    'Interventions revised', 'Coordinated with nursing/therapy/dietary/social work'],
  prescriptionOrders: ['Start', 'Change', 'Discontinue', 'Controlled substance — monitoring noted', 'Labs to monitor ordered'],
  labOrders: ['Routine', 'STAT', 'Clinical indication documented'],
  imagingOrders: ['Routine', 'STAT', 'Contrast', 'Clinical indication documented'],
  // Advance Care Planning
  participants: ['Patient', 'Surrogate/POA', 'Family', 'Patient has decision-making capacity',
    'Surrogate decided', 'Discussion was voluntary'],
  goals: ['CPR', 'Intubation', 'Hospital transfer', 'Artificial nutrition', 'Dialysis', 'IV antibiotics', 'Comfort-focused care'],
  decisionsMade: ['Full code', 'DNR', 'DNR/DNI', 'DNH (do not hospitalize)', 'Comfort-focused care',
    'POLST/MOLST completed', 'Healthcare proxy designated', 'Advance directive on file', 'No document changes today'],
  // Hospice
  symptomAssessment: ['Pain', 'Dyspnea', 'Secretions', 'Nausea', 'Constipation', 'Agitation/delirium', 'Anxiety', 'Pruritus'],
  careCoordination: ['Spoke with hospice RN', 'Hospice IDT', 'Family updated', 'Next hospice visit scheduled'],
  // Telehealth
  telehealthEligibility: ['Medically necessary follow-up', 'Not the initial comprehensive visit', 'Not a required periodic visit'],
  consent: ['Verbal consent — patient', 'Verbal consent — surrogate', 'Written consent on file', 'Offered in-person alternative'],
  locations: ['Provider licensed in the state where the patient is located', 'Originating & distant sites documented'],
  technicalQuality: ['Real-time audio-video', 'Audio-only where permitted', 'Quality adequate for clinical decisions'],
  // Annual / comprehensive
  prevention: ['Influenza', 'Pneumococcal', 'COVID-19', 'RSV', 'Tetanus', 'Shingles', 'Dental', 'Vision', 'Hearing', 'Foot', 'Skin'],
  // Discharge
  dischargeInstructions: ['Warning signs / when to call', 'Diet', 'Activity', 'Wound care', 'Catheter care',
    'Medication list', 'Caregiver present', 'Verbalized understanding'],
  homeServices: ['Home health nursing', 'PT', 'OT', 'SLP', 'DME: walker', 'Wheelchair', 'Commode', 'Hospital bed', 'Oxygen'],
  pendingFollowUp: ['Lab results pending', 'Wound not closed', 'Catheter change due', 'Referral not yet scheduled', 'None'],
  // Attestation — CMS billing basis (physician / NPP split-shared)
  attestation: ['Performed by physician in its entirety', 'Split/shared — substantive portion by me',
    'Level by medical decision making', 'Level by total time', 'NPP within state scope — collaborating physician noted'],
};

/** Canonical checks for a heading key (fresh array copy), or null when the heading has no preset. */
export function checksForHeading(key) {
  const c = HEADING_CHECKS[key];
  return c && c.length ? [...c] : null;
}
