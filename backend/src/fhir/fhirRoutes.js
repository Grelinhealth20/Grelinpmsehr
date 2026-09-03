/**
 * FHIR R4 API (US Core foundation) — real, read-only access to the EHR's USCDI-relevant data.
 * Base: /api/fhir/R4. `/metadata` is public (FHIR discovery); all resource endpoints require an
 * authenticated provider session and return only that provider's own patients' data.
 *
 * Implemented: Patient, Practitioner, Encounter, Condition, MedicationRequest, AllergyIntolerance —
 * each with read (by id) and search-type. NOT yet: SMART-on-FHIR OAuth2, Bulk Data $export, write
 * interactions, or the full US Core profile set — those are the next layers toward ONC (g)(10)/Inferno.
 */
import { Router } from 'express';
import { authenticate, requirePasswordSettled } from '../middleware/authenticate.js';
import { authorize as authorizeRole } from '../middleware/authorize.js';
import { csrfProtection } from '../middleware/csrf.js';
import { ROLES, USER_STATUS } from '../config/env.js';
import { findRawByUuid } from '../services/userService.js';
import {
  toPatient, toPractitioner, toEncounter, toCondition, toMedicationRequest, toAllergyIntolerance, toObservation,
  toProcedure, toDocumentReference, toProvenance, searchsetBundle, operationOutcome, fhirInstant,
} from './mappers.js';
import {
  fhirPatients, fhirPatientById, fhirPractitioners, fhirEncounters, fhirConditions, fhirMedications, fhirAllergies,
  fhirObservations, fhirProcedures, fhirDocumentReferences, fhirProvenance,
} from './fhirData.js';
import { smartConfiguration, authorize, token, registerClient, verifySmartToken, scopeAllowsRead } from './smart.js';

const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const send = (res, status, body) => res.status(status).type(FHIR_JSON).send(JSON.stringify(body));
const notFound = (res, type, id) => send(res, 404, operationOutcome('error', 'not-found', `${type}/${id} not found`));

const router = Router();

/* ---- CapabilityStatement (public discovery) ---- */
function capabilityStatement() {
  const resource = (type, profile, params = []) => ({
    type,
    profile: `http://hl7.org/fhir/us/core/StructureDefinition/${profile}`,
    interaction: [{ code: 'read' }, { code: 'search-type' }],
    searchParam: params.map(([name, t]) => ({ name, type: t })),
  });
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: fhirInstant(new Date()),
    kind: 'instance',
    software: { name: 'Grelin PMS/EHR FHIR API' },
    implementation: { description: 'Grelin Health FHIR R4 (US Core foundation)' },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json', 'json'],
    rest: [{
      mode: 'server',
      security: { cors: true, description: 'Provider session (httpOnly cookie via gateway). SMART-on-FHIR OAuth 2.0 planned.' },
      resource: [
        resource('Patient', 'us-core-patient', [['_id', 'token'], ['identifier', 'token'], ['name', 'string'], ['family', 'string'], ['given', 'string'], ['birthdate', 'date'], ['gender', 'token']]),
        resource('Practitioner', 'us-core-practitioner', [['_id', 'token'], ['identifier', 'token']]),
        resource('Encounter', 'us-core-encounter', [['_id', 'token'], ['patient', 'reference']]),
        resource('Condition', 'us-core-condition-encounter-diagnosis', [['patient', 'reference'], ['encounter', 'reference']]),
        resource('MedicationRequest', 'us-core-medicationrequest', [['patient', 'reference'], ['encounter', 'reference']]),
        resource('AllergyIntolerance', 'us-core-allergyintolerance', [['patient', 'reference'], ['encounter', 'reference']]),
        resource('Observation', 'us-core-vital-signs', [['patient', 'reference'], ['encounter', 'reference'], ['category', 'token'], ['code', 'token']]),
        resource('Procedure', 'us-core-procedure', [['patient', 'reference'], ['encounter', 'reference']]),
        resource('DocumentReference', 'us-core-documentreference', [['patient', 'reference'], ['encounter', 'reference']]),
        resource('Provenance', 'us-core-provenance', [['patient', 'reference']]),
      ],
      operation: [{ name: 'export', definition: 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export' }],
    }],
  };
}
router.get('/metadata', (req, res) => send(res, 200, capabilityStatement()));

/* ---- SMART-on-FHIR / OAuth 2.0 ---- */
const fhirBase = (req) => `${req.protocol}://${req.get('host')}${req.baseUrl}`;
// SMART discovery (public).
router.get('/.well-known/smart-configuration', (req, res) => send(res, 200, smartConfiguration(fhirBase(req))));
// Authorization endpoint — the user must have an app session (browser cookie); issues a code + redirects.
router.get('/oauth2/authorize', authenticate, requirePasswordSettled, async (req, res, next) => {
  try {
    const { redirect } = await authorize({ query: req.query, userId: req.authUserId });
    res.redirect(302, redirect);
  } catch (err) {
    if (err.oauthError) return send(res, err.status || 400, operationOutcome('error', 'invalid', `${err.oauthError}: ${err.message}`));
    next(err);
  }
});
// Token endpoint (public; client auth via PKCE or secret).
router.post('/oauth2/token', async (req, res, next) => {
  try {
    const resp = await token({ body: req.body || {}, authHeader: req.headers.authorization });
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json(resp);
  } catch (err) {
    if (err.oauthError) return res.status(err.status || 400).json({ error: err.oauthError, error_description: err.message });
    next(err);
  }
});
// Client registration (super-admin, CSRF-protected).
router.post('/oauth2/register', authenticate, requirePasswordSettled, authorizeRole(ROLES.SUPER_ADMIN), csrfProtection, async (req, res, next) => {
  try {
    const out = await registerClient({ ...req.body, createdBy: req.authUserId });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

/* ---- resource access: SMART Bearer token OR provider session cookie ---- */
async function fhirAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const claims = verifySmartToken(h.slice(7));
    if (!claims) return send(res, 401, operationOutcome('error', 'login', 'Invalid or expired access token'));
    try {
      const u = await findRawByUuid(claims.sub);
      if (!u || u.status === USER_STATUS.DISABLED) return send(res, 401, operationOutcome('error', 'login', 'User no longer valid'));
      req.authUserId = u.id; req.smartScope = claims.scope; req.smartToken = true;
      req.smartPatient = claims.patient || null; // launch/patient context — confines access to one patient
      return next();
    } catch (err) { return next(err); }
  }
  // Fall back to the app session cookie (same identity + gates as the rest of the API).
  return authenticate(req, res, () => requirePasswordSettled(req, res, next));
}
router.use(fhirAuth);
// Scope enforcement (SMART-token callers only; cookie sessions keep full app authority). The resource
// type is the first path segment (/Patient/123 → Patient); reject if the token's scope doesn't grant read.
const FHIR_TYPES = new Set(['Patient', 'Practitioner', 'Encounter', 'Condition', 'MedicationRequest', 'AllergyIntolerance', 'Observation', 'Procedure', 'DocumentReference', 'Provenance']);
router.use((req, res, next) => {
  if (!req.smartToken) return next();
  const type = (req.path.split('/')[1] || '').trim();
  if (FHIR_TYPES.has(type) && !scopeAllowsRead(req.smartScope, type)) {
    return send(res, 403, operationOutcome('error', 'forbidden', `Access token scope does not permit ${type} read`));
  }
  next();
});

const selfUrl = (req) => `${req.baseUrl}${req.path}${req._parsedUrl?.search || ''}`;

/**
 * Effective patient filter for a request — the LEAK-PROOF core. A launch/patient token is CONFINED to
 * its bound patient: any request for a different patient is refused (403). Otherwise the optional
 * ?patient= filter applies. Returns { patientUuid } or { blocked:true } (after sending the 403).
 */
function scopedPatient(req, res) {
  const requested = req.query.patient ? String(req.query.patient).replace(/^Patient\//, '') : null;
  if (req.smartPatient) {
    if (requested && requested !== req.smartPatient) {
      send(res, 403, operationOutcome('error', 'forbidden', 'This access token is scoped to a single patient'));
      return { blocked: true };
    }
    return { patientUuid: req.smartPatient };
  }
  return { patientUuid: requested };
}
const encounterRef = (req) => (req.query.encounter ? String(req.query.encounter).replace(/^Encounter\//, '') : null);
// A patient-scoped token may only see the Patient it is bound to.
const patientVisible = (req, uuid) => !req.smartPatient || req.smartPatient === uuid;

/* ---- Bulk Data $export — registered BEFORE /Patient/:id so "/Patient/$export" isn't caught as id.
   Regex routes: a literal "$" in an Express string path is not matched reliably by path-to-regexp. ---- */
router.get(/^\/\$export$/, bulkExport);          // system/provider-level export (all owned patients)
router.get(/^\/Patient\/\$export$/, bulkExport); // patient-compartment export

/* ---- Patient ---- */
router.get('/Patient/:id', async (req, res, next) => {
  try {
    if (!patientVisible(req, req.params.id)) return notFound(res, 'Patient', req.params.id);
    const row = await fhirPatientById(req.authUserId, req.params.id);
    if (!row) return notFound(res, 'Patient', req.params.id);
    send(res, 200, toPatient(row));
  } catch (err) { next(err); }
});
router.get('/Patient', async (req, res, next) => {
  try {
    let rows = await fhirPatients(req.authUserId);
    if (req.smartPatient) rows = rows.filter((r) => r.uuid === req.smartPatient); // patient-context confinement
    const { _id, identifier, name, family, given, birthdate, gender } = req.query;
    const idval = identifier ? String(identifier).split('|').pop().toLowerCase() : null;
    const nl = (s) => String(s || '').toLowerCase();
    rows = rows.filter((r) => {
      const d = r.demographics || {};
      if (_id && r.uuid !== _id) return false;
      if (idval && nl(r.mrn) !== idval) return false;
      if (gender && d.gender !== String(gender).toLowerCase()) return false;
      if (birthdate && !nl(d.dob).startsWith(nl(String(birthdate).replace(/^(eq|ge|le|gt|lt)/, '')))) return false;
      if (family && !nl(d.lastName).includes(nl(family))) return false;
      if (given && !nl(d.firstName).includes(nl(given)) && !nl(d.middleName).includes(nl(given))) return false;
      if (name) { const hay = nl(`${d.firstName} ${d.middleName} ${d.lastName}`); if (!hay.includes(nl(name))) return false; }
      return true;
    });
    send(res, 200, searchsetBundle(rows.map(toPatient), { baseUrl: selfUrl(req) }));
  } catch (err) { next(err); }
});

/* ---- Practitioner (provider directory — name/NPI, not PHI) ---- */
router.get('/Practitioner/:id', async (req, res, next) => {
  try {
    const [row] = await fhirPractitioners({ uuid: req.params.id });
    if (!row) return notFound(res, 'Practitioner', req.params.id);
    send(res, 200, toPractitioner(row));
  } catch (err) { next(err); }
});
router.get('/Practitioner', async (req, res, next) => {
  try {
    let rows = await fhirPractitioners({});
    if (req.query._id) rows = rows.filter((r) => r.uuid === req.query._id);
    if (req.query.identifier) { const v = String(req.query.identifier).split('|').pop(); rows = rows.filter((r) => String(r.npi) === v); }
    send(res, 200, searchsetBundle(rows.map(toPractitioner), { baseUrl: selfUrl(req) }));
  } catch (err) { next(err); }
});

/* ---- Encounter ---- */
router.get('/Encounter/:id', async (req, res, next) => {
  try {
    const [row] = await fhirEncounters(req.authUserId, { uuid: req.params.id });
    if (!row) return notFound(res, 'Encounter', req.params.id);
    if (!patientVisible(req, row.patient_uuid)) return notFound(res, 'Encounter', req.params.id);
    send(res, 200, toEncounter(row));
  } catch (err) { next(err); }
});
router.get('/Encounter', async (req, res, next) => {
  try {
    const sp = scopedPatient(req, res); if (sp.blocked) return;
    const rows = await fhirEncounters(req.authUserId, { patientUuid: sp.patientUuid });
    send(res, 200, searchsetBundle(rows.map(toEncounter), { baseUrl: selfUrl(req) }));
  } catch (err) { next(err); }
});

/* ---- clinical resources (patient- and encounter-scoped) ---- */
const searchRoute = (path, fetch, map, extra) => router.get(path, async (req, res, next) => {
  try {
    const sp = scopedPatient(req, res); if (sp.blocked) return;
    if (extra && extra(req, res) === false) return;
    const rows = await fetch(req.authUserId, { patientUuid: sp.patientUuid, encounterUuid: encounterRef(req) });
    send(res, 200, searchsetBundle(rows.map(map).filter(Boolean), { baseUrl: selfUrl(req) }));
  } catch (err) { next(err); }
});
searchRoute('/Condition', fhirConditions, toCondition);
searchRoute('/MedicationRequest', fhirMedications, toMedicationRequest);
searchRoute('/AllergyIntolerance', fhirAllergies, toAllergyIntolerance);
searchRoute('/Procedure', fhirProcedures, toProcedure);
searchRoute('/DocumentReference', fhirDocumentReferences, toDocumentReference);
searchRoute('/Provenance', fhirProvenance, toProvenance);
searchRoute('/Observation', fhirObservations, toObservation, (req, res) => {
  const cat = req.query.category ? String(req.query.category).split('|').pop() : null;
  if (cat && cat !== 'vital-signs') { send(res, 200, searchsetBundle([], { baseUrl: selfUrl(req) })); return false; }
  return true;
});

/* ---- Bulk Data $export (Flat FHIR, provider- and patient-context scoped) ---- */
async function bulkExport(req, res, next) {
  try {
    const sp = scopedPatient(req, res); if (sp.blocked) return;
    const opts = { patientUuid: sp.patientUuid };
    const want = new Set(String(req.query._type || '').split(',').map((s) => s.trim()).filter(Boolean));
    const include = (t) => want.size === 0 || want.has(t);
    const lines = [];
    if (include('Patient')) {
      const pts = await fhirPatients(req.authUserId);
      for (const p of pts) if (patientVisible(req, p.uuid)) lines.push(JSON.stringify(toPatient(p)));
    }
    const add = async (type, fetch, map) => { if (!include(type)) return; const rows = await fetch(req.authUserId, opts); for (const r of rows) { const m = map(r); if (m) lines.push(JSON.stringify(m)); } };
    await add('Encounter', fhirEncounters, toEncounter);
    await add('Condition', fhirConditions, toCondition);
    await add('MedicationRequest', fhirMedications, toMedicationRequest);
    await add('AllergyIntolerance', fhirAllergies, toAllergyIntolerance);
    await add('Observation', fhirObservations, toObservation);
    await add('Procedure', fhirProcedures, toProcedure);
    await add('DocumentReference', fhirDocumentReferences, toDocumentReference);
    await add('Provenance', fhirProvenance, toProvenance);
    // Synchronous Flat-FHIR NDJSON (one resource per line). Spec-conformant async kick-off (202 +
    // polling manifest) is the next refinement; the data + scoping here are production-real.
    res.status(200).type('application/fhir+ndjson; charset=utf-8').send(lines.join('\n') + (lines.length ? '\n' : ''));
  } catch (err) { next(err); }
}
// FHIR-shaped 404 for unknown resource types / paths under the base.
router.use((req, res) => send(res, 404, operationOutcome('error', 'not-found', 'Unknown FHIR interaction')));

export default router;
