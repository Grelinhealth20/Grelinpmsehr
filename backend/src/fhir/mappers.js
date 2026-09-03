/**
 * FHIR R4 resource mappers (US Core aligned) — every field comes from REAL EHR data; nothing is mocked.
 * Resource `id` is the domain uuid so references are stable. Where a source record has no uuid (a note's
 * captured diagnosis / prescription), a deterministic composite id is derived from its parent + index.
 *
 * Scope (foundation): Patient, Practitioner, Encounter, Condition, MedicationRequest, AllergyIntolerance.
 * US Core race/ethnicity/birthsex extensions are omitted because this EHR does not collect those data
 * elements — a conformant build would add them with a data-absent-reason. This maps what is truly present.
 */

const UC = 'http://hl7.org/fhir/us/core/StructureDefinition/';
const clean = (v) => (v == null ? undefined : String(v).trim() || undefined);

/** FHIR instant from a DB DATETIME/Date. */
export function fhirInstant(dt) {
  if (!dt) return undefined;
  const d = dt instanceof Date ? dt : new Date(dt);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Drop undefined properties (FHIR must not carry null/undefined leaves). */
function prune(obj) {
  if (Array.isArray(obj)) { const a = obj.map(prune).filter((x) => x !== undefined && !(Array.isArray(x) && !x.length)); return a.length ? a : undefined; }
  if (obj && typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) { const pv = prune(v); if (pv !== undefined) o[k] = pv; }
    return Object.keys(o).length ? o : undefined;
  }
  return obj === undefined || obj === null || obj === '' ? undefined : obj;
}

/** US Core Patient ← patients row (+ decrypted demographics object). */
export function toPatient(p) {
  const d = p.demographics || {};
  const given = [clean(d.firstName), clean(d.middleName)].filter(Boolean);
  return prune({
    resourceType: 'Patient',
    id: p.uuid,
    meta: { profile: [`${UC}us-core-patient`], lastUpdated: fhirInstant(p.updated_at) },
    identifier: [
      p.mrn ? {
        use: 'usual',
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical Record Number' }], text: 'MRN' },
        system: 'urn:grelin:patient-mrn',
        value: String(p.mrn),
      } : undefined,
    ],
    active: true,
    name: [{ use: 'official', family: clean(d.lastName), given: given.length ? given : undefined }],
    telecom: [
      d.phone ? { system: 'phone', value: clean(d.phone), use: 'home' } : undefined,
      d.email ? { system: 'email', value: clean(d.email) } : undefined,
    ],
    gender: ['male', 'female', 'other', 'unknown'].includes(d.gender) ? d.gender : 'unknown',
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(d.dob || '') ? d.dob : undefined,
    address: (d.address || d.city || d.state || d.zip) ? [{
      use: 'home', type: 'physical',
      line: d.address ? [clean(d.address)] : undefined,
      city: clean(d.city), state: clean(d.state), postalCode: clean(d.zip), country: 'US',
    }] : undefined,
  });
}

/** US Core Practitioner ← users row (+ decrypted full name). */
export function toPractitioner(u) {
  const full = clean(u.full_name) || '';
  const parts = full.split(/\s+/).filter(Boolean);
  const family = parts.length > 1 ? parts[parts.length - 1] : full || undefined;
  const given = parts.length > 1 ? parts.slice(0, -1) : undefined;
  return prune({
    resourceType: 'Practitioner',
    id: u.uuid,
    meta: { profile: [`${UC}us-core-practitioner`], lastUpdated: fhirInstant(u.updated_at) },
    identifier: [u.npi ? { system: 'http://hl7.org/fhir/sid/us-npi', value: String(u.npi) } : undefined],
    active: u.status ? u.status === 'active' : true,
    name: [{ use: 'official', text: full || undefined, family, given, suffix: u.credentials ? [clean(u.credentials)] : undefined }],
    qualification: u.taxonomy_code ? [{
      code: { coding: [{ system: 'http://nucc.org/provider-taxonomy', code: String(u.taxonomy_code), display: clean(u.taxonomy) }], text: clean(u.taxonomy) },
    }] : undefined,
  });
}

const ENCOUNTER_STATUS = { not_seen: 'planned', charts_completed: 'finished', cancelled: 'cancelled' };

/** US Core Encounter ← encounters row. */
export function toEncounter(e) {
  return prune({
    resourceType: 'Encounter',
    id: e.uuid,
    meta: { profile: [`${UC}us-core-encounter`], lastUpdated: fhirInstant(e.updated_at) },
    status: ENCOUNTER_STATUS[e.chart_status] || 'unknown',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: e.patient_uuid ? { reference: `Patient/${e.patient_uuid}` } : undefined,
    participant: e.provider_uuid ? [{ individual: { reference: `Practitioner/${e.provider_uuid}` } }] : undefined,
    period: { start: fhirInstant(e.created_at) },
  });
}

/** US Core Condition (encounter diagnosis) ← encounter_note_codes dx row. */
export function toCondition(c) {
  const coding = [];
  if (c.code) coding.push({ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: String(c.code), display: clean(c.description) });
  if (c.snomed_code) coding.push({ system: 'http://snomed.info/sct', code: String(c.snomed_code), display: clean(c.snomed_term) });
  return prune({
    resourceType: 'Condition',
    id: `${c.note_uuid}-dx-${c.seq ?? c.idx ?? 0}`,
    meta: { profile: [`${UC}us-core-condition-encounter-diagnosis`] },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis', display: 'Encounter Diagnosis' }] }],
    code: coding.length ? { coding, text: clean(c.description) || clean(c.snomed_term) } : { text: clean(c.description) || 'Unspecified' },
    subject: c.patient_uuid ? { reference: `Patient/${c.patient_uuid}` } : undefined,
    encounter: c.encounter_uuid ? { reference: `Encounter/${c.encounter_uuid}` } : undefined,
    recordedDate: fhirInstant(c.created_at),
  });
}

/** US Core MedicationRequest ← a prescription object from a note's content. */
export function toMedicationRequest(m) {
  const dosageText = [clean(m.dose), clean(m.route), clean(m.frequency), clean(m.sig)].filter(Boolean).join(' ');
  return prune({
    resourceType: 'MedicationRequest',
    id: `${m.note_uuid}-rx-${m.idx}`,
    meta: { profile: [`${UC}us-core-medicationrequest`] },
    status: m.signed ? 'active' : 'draft',
    intent: 'order',
    medicationCodeableConcept: {
      coding: m.rxcui ? [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: String(m.rxcui), display: clean(m.drug) }] : undefined,
      text: clean(m.drug) || 'Unspecified medication',
    },
    subject: m.patient_uuid ? { reference: `Patient/${m.patient_uuid}` } : undefined,
    encounter: m.encounter_uuid ? { reference: `Encounter/${m.encounter_uuid}` } : undefined,
    authoredOn: fhirInstant(m.authored_on),
    requester: m.provider_uuid ? { reference: `Practitioner/${m.provider_uuid}` } : undefined,
    dosageInstruction: dosageText ? [{ text: dosageText }] : undefined,
  });
}

/** US Core AllergyIntolerance ← a documented allergy term from a note's content. */
export function toAllergyIntolerance(a) {
  return prune({
    resourceType: 'AllergyIntolerance',
    id: `${a.note_uuid}-al-${a.idx}`,
    meta: { profile: [`${UC}us-core-allergyintolerance`] },
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'unconfirmed' }] },
    code: { text: clean(a.text) },
    patient: a.patient_uuid ? { reference: `Patient/${a.patient_uuid}` } : undefined,
    recordedDate: fhirInstant(a.recorded_date),
  });
}

// LOINC + UCUM definitions for the vitals this EHR captures (US Core Vital Signs).
const VITAL_DEFS = {
  temp: { loinc: '8310-5', display: 'Body temperature', unit: 'degF', ucum: '[degF]', profile: 'us-core-body-temperature' },
  hr: { loinc: '8867-4', display: 'Heart rate', unit: 'beats/minute', ucum: '/min', profile: 'us-core-heart-rate' },
  rr: { loinc: '9279-1', display: 'Respiratory rate', unit: 'breaths/minute', ucum: '/min', profile: 'us-core-respiratory-rate' },
  spo2: { loinc: '2708-6', display: 'Oxygen saturation in Arterial blood', unit: '%', ucum: '%', profile: 'us-core-pulse-oximetry' },
  weight: { loinc: '29463-7', display: 'Body weight', unit: 'lb', ucum: '[lb_av]', profile: 'us-core-body-weight' },
  pain: { loinc: '72514-3', display: 'Pain severity - 0-10 verbal numeric rating [Score]', unit: '{score}', ucum: '{score}', profile: 'us-core-pain-severity' },
};
const VITAL_CATEGORY = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }];

/** US Core vital-sign Observation ← one captured vital. `v` = { key, value, note_uuid, idx, patient_uuid, encounter_uuid, effective }.
 *  Blood pressure (key='bp', value like "120/80") maps to the BP panel with systolic/diastolic components. */
export function toObservation(v) {
  const base = {
    resourceType: 'Observation',
    id: `${v.note_uuid}-vital-${v.key}`,
    status: 'final',
    category: VITAL_CATEGORY,
    subject: v.patient_uuid ? { reference: `Patient/${v.patient_uuid}` } : undefined,
    encounter: v.encounter_uuid ? { reference: `Encounter/${v.encounter_uuid}` } : undefined,
    effectiveDateTime: fhirInstant(v.effective),
  };
  if (v.key === 'bp') {
    const m = String(v.value).match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
    if (!m) return undefined;
    return prune({
      ...base,
      meta: { profile: [`${UC}us-core-blood-pressure`] },
      code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel with all children optional' }], text: 'Blood pressure' },
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: { value: Number(m[1]), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: { value: Number(m[2]), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
      ],
    });
  }
  const def = VITAL_DEFS[v.key];
  const num = Number(String(v.value).replace(/[^\d.]/g, ''));
  if (!def || !Number.isFinite(num)) return undefined;
  return prune({
    ...base,
    meta: { profile: [`${UC}${def.profile}`] },
    code: { coding: [{ system: 'http://loinc.org', code: def.loinc, display: def.display }], text: def.display },
    valueQuantity: { value: num, unit: def.unit, system: 'http://unitsofmeasure.org', code: def.ucum },
  });
}

/** Which vitals keys are supported (used by the data layer to expand a note's vitals object). */
export const VITAL_KEYS = ['bp', ...Object.keys(VITAL_DEFS)];

/** US Core Procedure ← encounter_note_codes proc row (CPT). */
export function toProcedure(c) {
  return prune({
    resourceType: 'Procedure',
    id: `${c.note_uuid}-proc-${c.seq ?? c.idx ?? 0}`,
    meta: { profile: [`${UC}us-core-procedure`] },
    status: 'completed',
    code: c.code
      ? { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: String(c.code), display: clean(c.description) }], text: clean(c.description) }
      : { text: clean(c.description) || 'Unspecified procedure' },
    subject: c.patient_uuid ? { reference: `Patient/${c.patient_uuid}` } : undefined,
    encounter: c.encounter_uuid ? { reference: `Encounter/${c.encounter_uuid}` } : undefined,
    performedDateTime: fhirInstant(c.created_at),
  });
}

const DOC_TYPE_LOINC = {
  clinical_note: { code: '34109-9', display: 'Note' },
  license_front: { code: '00000-0', display: 'Identity document' },
  license_back: { code: '00000-0', display: 'Identity document' },
  insurance_front: { code: '64290-0', display: 'Health insurance card' },
  insurance_back: { code: '64290-0', display: 'Health insurance card' },
  other: { code: '34109-9', display: 'Note' },
};

/** US Core DocumentReference ← a signed clinical note OR a stored patient document. */
export function toDocumentReference(d) {
  const t = DOC_TYPE_LOINC[d.doc_type] || DOC_TYPE_LOINC.other;
  return prune({
    resourceType: 'DocumentReference',
    id: d.uuid,
    meta: { profile: [`${UC}us-core-documentreference`] },
    status: 'current',
    docStatus: d.kind === 'note' ? (d.signed ? 'final' : 'preliminary') : undefined,
    type: { coding: [{ system: 'http://loinc.org', code: t.code, display: t.display }], text: clean(d.title) || t.display },
    category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
    subject: d.patient_uuid ? { reference: `Patient/${d.patient_uuid}` } : undefined,
    date: fhirInstant(d.created_at),
    author: d.author_uuid ? [{ reference: `Practitioner/${d.author_uuid}` }] : undefined,
    content: [{
      attachment: prune({
        contentType: clean(d.content_type) || (d.kind === 'note' ? 'text/plain' : undefined),
        title: clean(d.title) || t.display,
        creation: fhirInstant(d.created_at),
        size: d.size_bytes || undefined,
      }),
    }],
    context: d.encounter_uuid ? { encounter: [{ reference: `Encounter/${d.encounter_uuid}` }] } : undefined,
  });
}

/** US Core Provenance ← a signed note's attestation (who signed, when, target document). */
export function toProvenance(p) {
  return prune({
    resourceType: 'Provenance',
    id: `${p.note_uuid}-prov`,
    meta: { profile: [`${UC}us-core-provenance`] },
    target: [{ reference: `DocumentReference/${p.note_uuid}` }],
    recorded: fhirInstant(p.signed_at),
    agent: [{
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author', display: 'Author' }] },
      who: p.signer_uuid ? { reference: `Practitioner/${p.signer_uuid}`, display: clean(p.signed_by_name) } : { display: clean(p.signed_by_name) },
    }],
  });
}

/** A FHIR searchset Bundle wrapping resources, with self/next links. */
export function searchsetBundle(resources, { baseUrl, total } = {}) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: total != null ? total : resources.length,
    link: baseUrl ? [{ relation: 'self', url: baseUrl }] : undefined,
    entry: resources.map((r) => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r, search: { mode: 'match' } })),
  };
}

/** A FHIR OperationOutcome for errors. */
export function operationOutcome(severity, code, diagnostics) {
  return { resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics }] };
}
