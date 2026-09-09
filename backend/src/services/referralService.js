import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { encrypt, decrypt, blindIndex } from '../utils/crypto.js';
import { viewerScope, patientScopeWhere } from './accessScope.js';
import { logger } from '../config/logger.js';
import { sendFax, downloadFaxFile, getFaxRecord, faxAi, faxAiAvailable, faxEnabled, listInbox } from './faxService.js';
import { referralPdf } from './pdfExport.js';
import { s3Enabled, uploadReferralObject, ensureReferralFolder, getObjectBytes, deleteObject } from './s3Service.js';
import { getPatientS3Ctx, createPatient } from './patientService.js';
import { resolveFacilityFax, facilityByIncomingFaxNumber, facilityFaxAutoCreateEnabled } from './facilityFaxService.js';
import { isFaxAutoCreateEnabled } from './settingsService.js';
import { providerPrimaryFacilityId, providerFacilityIds } from './facilityService.js';
import { extractReferralFax } from './referralExtractService.js';
import { ocrEnabled } from './docExtractService.js';
import { createDocumentRecord } from './patientDocumentService.js';

/**
 * READ scope for referrals — identical to the rest of the EHR (patients / encounters): a non-MD provider
 * sees ONLY their own referrals; a facility-wide MD sees referrals for their ASSIGNED facilities, bounded
 * by service line (via the owning provider's specialties). Referrals carry both `facility_id` and
 * `provider_id`, so patientScopeWhere applies verbatim on the `r` alias — guaranteeing FACILITY-SPECIFIC
 * access with NO cross-facility / cross-provider leakage. WRITES stay strictly owner-scoped (provider_id).
 *
 * INBOUND-FAX TRIAGE: an incoming fax is routed by DID to a facility and OWNED by the intake account, so
 * the owner/service-line scope above would hide it from everyone but SNF MDs. To let the receiving
 * facility actually work its inbox, ANY provider ASSIGNED to that facility may READ its incoming referrals
 * — strictly bounded to their own assigned facilities (provider_facilities), so there is still no
 * cross-facility leakage. This applies to `direction='incoming'` only; outgoing/own referrals are
 * unchanged, and WRITES remain owner-scoped.
 */
async function readScope(providerId, alias = 'r') {
  const scope = await viewerScope(providerId);
  const base = patientScopeWhere(scope, providerId, alias); // { sql, params }
  const facIds = await providerFacilityIds(providerId);     // facilities this provider is assigned to
  if (facIds.length) {
    const ph = facIds.map((id, i) => { base.params[`rif${i}`] = id; return `:rif${i}`; }).join(',');
    base.sql = `((${base.sql}) OR (${alias}.direction = 'incoming' AND ${alias}.facility_id IN (${ph})))`;
  }
  return base;
}

/**
 * Referral Management — incoming & outgoing specialist / care-transition referrals for SNF Part B
 * (Medicare Part B physician/NPP E/M, POS 31/32) patients. STRICTLY OWNER-SCOPED: every query is
 * filtered by provider_id, so a provider only ever sees, edits, or generates their OWN referrals —
 * no cross-provider access. Clinical free-text (reason / diagnosis / notes) is PHI and stored
 * AES-256-GCM encrypted; decryption is FAIL-LOUD (a corrupt blob throws, never silently blanks).
 */

export const DIRECTIONS = ['outgoing', 'incoming'];
export const PRIORITIES = ['routine', 'urgent', 'stat'];
// Full status set (both directions). Outgoing lifecycle: draft→sent→accepted→scheduled→completed
// (or declined/cancelled). Incoming lifecycle starts at 'received' (an inbound fax) → accepted→…; a
// received referral is never draft/sent. The UI presents the direction-appropriate subset; the server
// accepts any of these for filtering/validation.
export const STATUSES = ['draft', 'sent', 'received', 'accepted', 'scheduled', 'completed', 'declined', 'cancelled'];
export const OUTGOING_STATUSES = ['draft', 'sent', 'accepted', 'scheduled', 'completed', 'declined', 'cancelled'];
export const INCOMING_STATUSES = ['received', 'accepted', 'scheduled', 'completed', 'declined', 'cancelled'];

/** SNF Part B specialty / service lines a provider refers to (or receives from). Canonical list used
 *  for validation + the UI dropdown; a free-typed value is also accepted (bounded) so the list never
 *  blocks a real referral. */
export const SPECIALTIES = [
  'Cardiology', 'Nephrology', 'Pulmonology', 'Gastroenterology', 'Endocrinology', 'Neurology',
  'Psychiatry / Behavioral Health', 'Wound Care', 'Podiatry', 'Ophthalmology', 'Optometry',
  'Dental / Oral Surgery', 'ENT (Otolaryngology)', 'Urology', 'Orthopedics', 'Pain Management',
  'Physical Therapy', 'Occupational Therapy', 'Speech-Language Pathology', 'Dermatology',
  'Hematology / Oncology', 'Infectious Disease', 'Vascular Surgery', 'General Surgery',
  'Palliative Care / Hospice', 'Nutrition / Dietary', 'Radiology / Imaging',
  'Hospital / Emergency (Higher Level of Care)',
];

function safeParse(buf) { if (!buf) return null; try { return JSON.parse(decrypt(buf)); } catch { return null; } }
/** FAIL-LOUD decrypt of a clinical PHI field: null column = legitimately empty; a present-but-corrupt
 *  blob throws (never silently blanked), so tampered data is surfaced, never hidden. */
function strictText(buf, label) {
  if (!buf) return '';
  try { return decrypt(buf); }
  catch { const e = new Error(`${label} could not be decrypted (possible data corruption).`); e.status = 422; e.code = 'REFERRAL_UNREADABLE'; throw e; }
}
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function toPublicReferral(r, { full = false } = {}) {
  if (!r) return null;
  const demo = r.demographics_enc ? safeParse(r.demographics_enc) : null;
  const fac = r.facility_enc ? safeParse(r.facility_enc) : null;
  return {
    uuid: r.uuid,
    referralNo: r.referral_no,
    direction: r.direction,
    specialty: r.specialty,
    priority: r.priority,
    status: r.status,
    counterpartyName: r.counterparty_name || null,
    counterpartyOrg: r.counterparty_org || null,
    counterpartyFax: r.counterparty_fax || null,
    counterpartyNpi: r.counterparty_npi || null,
    fax: (r.fax_id || r.fax_status || r.fax_s3_key || r.fax_events) ? {
      id: r.fax_id || null, status: r.fax_status || null, pages: r.fax_pages || null,
      error: r.fax_error || null, faxedAt: r.faxed_at_str || null, hasDocument: !!r.fax_s3_key,
      timeline: parseFaxEvents(r.fax_events),
      // Auto-computed (once, cached) Fax.Plus AI triage for an inbound fax — assists the intake provider.
      ai: decodeFaxAi(r.fax_ai),
      aiAt: r.fax_ai_at_str || null,
    } : null,
    reason: strictText(r.reason_enc, 'Referral reason'),
    diagnosis: strictText(r.diagnosis_enc, 'Referral diagnosis'),
    ...(full ? { notes: strictText(r.notes_enc, 'Referral notes') } : {}),
    referralDate: r.referral_date_str || null,
    scheduledDate: r.scheduled_date_str || null,
    // The REFERRING facility this referral sends FROM (null until linked). Drives the fax "sends from"
    // line + the detail-modal facility picker. Populated by SELECTs that join facilities (getReferral).
    referringFacility: r.ref_fac_uuid ? { uuid: r.ref_fac_uuid, name: r.ref_fac_name || null } : null,
    patient: r.patient_uuid ? {
      uuid: r.patient_uuid,
      mrn: r.mrn || null,
      name: demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() || null : null,
      dob: demo?.dob || null,
      sex: demo?.gender || demo?.sex || null,
      facilityName: fac?.facilityName || null,
    } : null,
    updatedAt: r.updated_at,
  };
}

// SELECT joins the OWNED patient (for name / MRN / facility) — the join is itself owner-bounded because
// the referral row is already scoped to the provider; a patient_id always belongs to that provider.
const SELECT = `SELECT r.uuid, r.referral_no, r.direction, r.specialty, r.priority, r.status,
    r.counterparty_name, r.counterparty_org, r.counterparty_fax, r.counterparty_npi, r.reason_enc, r.diagnosis_enc, r.notes_enc,
    r.fax_id, r.fax_status, r.fax_file_id, r.fax_s3_key, r.fax_pages, r.fax_error, r.fax_events, r.fax_ai,
    DATE_FORMAT(r.fax_ai_at, '%Y-%m-%dT%H:%i:%sZ') AS fax_ai_at_str,
    DATE_FORMAT(r.referral_date, '%Y-%m-%d') AS referral_date_str,
    DATE_FORMAT(r.scheduled_date, '%Y-%m-%d') AS scheduled_date_str,
    DATE_FORMAT(r.faxed_at, '%Y-%m-%dT%H:%i:%sZ') AS faxed_at_str, r.updated_at,
    p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
    rf.uuid AS ref_fac_uuid, rf.name AS ref_fac_name
  FROM referrals r LEFT JOIN patients p ON p.id = r.patient_id
    LEFT JOIN facilities rf ON rf.id = r.facility_id`;

/** Parse the fax_events JSON column into a clean timeline array (mysql2 may hand back an array or a
 *  JSON string depending on driver config — handle both; never throw on a malformed value). */
function parseFaxEvents(raw) {
  if (!raw) return [];
  try { const v = Array.isArray(raw) ? raw : JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}
/** Parse a JSON column value (mysql2 may hand back an object or a JSON string) → object, or null. */
function parseJsonCol(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
/** Decode the inbound-fax AI triage column. New rows are an {enc:<base64>} encrypted envelope; decrypt +
 *  parse. Legacy plaintext rows (no `enc`) return as-is. Assist metadata → FAIL SOFT (never block the
 *  referral view on a bad blob). */
function decodeFaxAi(col) {
  const w = parseJsonCol(col);
  if (!w || typeof w !== 'object') return w || null;
  if (!w.enc) return w; // legacy plaintext payload (pre-encryption)
  try { return JSON.parse(decrypt(Buffer.from(String(w.enc), 'base64'))); }
  catch { return null; }
}
/** Append one timestamped event to a referral's fax timeline (bounded to the last 50). */
async function pushFaxEvent(referralId, status, detail = '') {
  const [rows] = await execute('SELECT fax_events FROM referrals WHERE id = :id LIMIT 1', { id: referralId });
  if (!rows[0]) return;
  const events = parseFaxEvents(rows[0].fax_events);
  events.push({ status: String(status).slice(0, 40), detail: detail ? String(detail).slice(0, 200) : null, at: new Date().toISOString() });
  await execute('UPDATE referrals SET fax_events = :e WHERE id = :id', { e: JSON.stringify(events.slice(-50)), id: referralId });
}

/** Resolve the REFERRING facility id for a referral, in priority order:
 *  1) an explicit facility (chosen in the UI), 2) the patient's own facility, 3) the PROVIDER's primary
 *  assigned facility. All are real, provider-authorized sources — never a fabricated/shared default. */
async function resolveReferralFacilityId({ facilityId = null, patientId = null }, providerId) {
  if (facilityId) return Number(facilityId);
  if (patientId) {
    const [pf] = await execute('SELECT facility_id FROM patients WHERE id = :id LIMIT 1', { id: patientId });
    if (pf[0]?.facility_id) return Number(pf[0].facility_id);
  }
  return providerPrimaryFacilityId(providerId);
}

/** An OWNED facility id from its uuid, but only if the PROVIDER is assigned to it (no cross-facility set). */
async function providerFacilityIdByUuid(providerId, facilityUuid) {
  if (!facilityUuid) return null;
  const [rows] = await execute(
    `SELECT f.id FROM facilities f JOIN provider_facilities pf ON pf.facility_id = f.id
      WHERE f.uuid = :u AND pf.provider_id = :pid LIMIT 1`, { u: facilityUuid, pid: providerId });
  return rows[0]?.id ? Number(rows[0].id) : null;
}

/** Resolve an OWNED patient's numeric id from its uuid (null if not owned — no cross-provider linkage). */
async function ownedPatientId(providerId, patientUuid) {
  if (!patientUuid) return { id: null, facilityId: null };
  const [rows] = await execute('SELECT id, facility_id FROM patients WHERE uuid = :u AND provider_id = :p LIMIT 1',
    { u: patientUuid, p: providerId });
  return rows[0] ? { id: rows[0].id, facilityId: rows[0].facility_id } : { id: undefined, facilityId: null };
}

function validateCore({ direction, specialty, priority, status }) {
  if (!DIRECTIONS.includes(direction)) { const e = new Error('Referral direction must be outgoing or incoming.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
  if (!clip(specialty, 100)) { const e = new Error('A referral needs a specialty / service.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
  if (priority && !PRIORITIES.includes(priority)) { const e = new Error('Invalid priority.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
  if (status && !STATUSES.includes(status)) { const e = new Error('Invalid status.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
}
const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);

export async function getReferral(providerId, uuid) {
  const sc = await readScope(providerId);
  const [rows] = await execute(`${SELECT} WHERE r.uuid = :u AND ${sc.sql} LIMIT 1`, { u: uuid, ...sc.params });
  return rows[0] ? toPublicReferral(rows[0], { full: true }) : null;
}

export async function createReferral(providerId, body = {}) {
  const { direction, specialty, priority = 'routine', status = 'draft',
    patientUuid, facilityUuid, counterpartyName, counterpartyOrg, counterpartyFax, reason, diagnosis, notes, referralDate, scheduledDate } = body;
  validateCore({ direction, specialty, priority, status });
  const pat = await ownedPatientId(providerId, patientUuid);
  if (patientUuid && pat.id === undefined) { const e = new Error('Patient not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }

  // Referring facility — resolved from a REAL, provider-authorized source, in priority order:
  //   1) the facility the provider explicitly picked in the UI (validated to a facility they're assigned to),
  //   2) the patient's own facility, 3) the provider's PRIMARY assigned facility. Auto-captured so a referral
  //   is fax-ready by default; never a fabricated/shared default (unresolved → null → send fails loud later).
  let explicitFacId = null;
  if (facilityUuid) {
    explicitFacId = await providerFacilityIdByUuid(providerId, facilityUuid);
    if (!explicitFacId) { const e = new Error('Facility not found or not assigned to you.'); e.status = 400; e.code = 'REFERRAL_FACILITY_INVALID'; throw e; }
  }
  const facId = await resolveReferralFacilityId({ facilityId: explicitFacId, patientId: pat.id ?? null }, providerId);

  const uuid = uuidv4();
  const [ins] = await execute(
    `INSERT INTO referrals (uuid, referral_no, provider_id, patient_id, facility_id, direction, specialty,
        priority, status, counterparty_name, counterparty_org, counterparty_fax, counterparty_npi, reason_enc, diagnosis_enc, notes_enc,
        referral_date, scheduled_date, created_by)
     VALUES (:uuid, :tmpNo, :pid, :patId, :facId, :dir, :spec, :prio, :status, :cpn, :cpo, :cpf, :cnpi,
        :reason, :diag, :notes, :rdate, :sdate, :pid)`,
    {
      uuid, tmpNo: `TMP-${uuid.slice(0, 18)}`, pid: providerId, patId: pat.id ?? null, facId: facId ?? null,
      dir: direction, spec: clip(specialty, 100), prio: priority, status,
      cpn: clip(counterpartyName, 160) || null, cpo: clip(counterpartyOrg, 160) || null,
      cpf: clip(counterpartyFax, 32).replace(/[^\d+]/g, '') || null,
      cnpi: /^\d{10}$/.test(String(body.counterpartyNpi || '').trim()) ? String(body.counterpartyNpi).trim() : null,
      reason: reason ? encrypt(clip(reason, 6000)) : null,
      diag: diagnosis ? encrypt(clip(diagnosis, 2000)) : null,
      notes: notes ? encrypt(clip(notes, 12000)) : null,
      rdate: validDate(referralDate) || new Date().toISOString().slice(0, 10),
      sdate: validDate(scheduledDate),
    },
  );
  // Human-facing sequential number derived from the row id (unique, race-free — the id is authoritative).
  await execute("UPDATE referrals SET referral_no = CONCAT('REF-', LPAD(id, 6, '0')) WHERE id = :id", { id: ins.insertId });
  return getReferral(providerId, uuid);
}

/** Resolve a referral this provider may WRITE: one they OWN, OR an INCOMING referral at a facility they
 *  are assigned to (inbound-fax triage). Returns the row id, or null (no cross-facility write access). */
async function writableReferralId(providerId, uuid) {
  const [rows] = await execute('SELECT id, direction, facility_id, provider_id FROM referrals WHERE uuid = :u LIMIT 1', { u: uuid });
  const r = rows[0];
  if (!r) return null;
  if (Number(r.provider_id) === Number(providerId)) return r.id; // owner
  if (r.direction === 'incoming' && r.facility_id != null) {
    const facIds = (await providerFacilityIds(providerId)).map(Number);
    if (facIds.includes(Number(r.facility_id))) return r.id; // assigned-facility triage of an inbound fax
  }
  return null;
}

export async function updateReferral(providerId, uuid, body = {}) {
  // Owner OR (assigned-facility provider triaging an incoming fax). Bounded — never cross-facility.
  const writableId = await writableReferralId(providerId, uuid);
  if (!writableId) return null;
  const ex = [{ id: writableId }];
  const sets = []; const params = { id: ex[0].id };
  const set = (col, key, val) => { sets.push(`${col} = :${key}`); params[key] = val; };
  if (body.specialty !== undefined) { if (!clip(body.specialty, 100)) { const e = new Error('Specialty required.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; } set('specialty', 'spec', clip(body.specialty, 100)); }
  if (body.priority !== undefined) { if (!PRIORITIES.includes(body.priority)) { const e = new Error('Invalid priority.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; } set('priority', 'prio', body.priority); }
  if (body.status !== undefined) { if (!STATUSES.includes(body.status)) { const e = new Error('Invalid status.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; } set('status', 'st', body.status); }
  if (body.counterpartyName !== undefined) set('counterparty_name', 'cpn', clip(body.counterpartyName, 160) || null);
  if (body.counterpartyOrg !== undefined) set('counterparty_org', 'cpo', clip(body.counterpartyOrg, 160) || null);
  if (body.counterpartyFax !== undefined) set('counterparty_fax', 'cpf', clip(body.counterpartyFax, 32).replace(/[^\d+]/g, '') || null);
  if (body.counterpartyNpi !== undefined) set('counterparty_npi', 'cnpi', /^\d{10}$/.test(String(body.counterpartyNpi || '').trim()) ? String(body.counterpartyNpi).trim() : null);
  if (body.reason !== undefined) set('reason_enc', 'reason', body.reason ? encrypt(clip(body.reason, 6000)) : null);
  if (body.diagnosis !== undefined) set('diagnosis_enc', 'diag', body.diagnosis ? encrypt(clip(body.diagnosis, 2000)) : null);
  if (body.notes !== undefined) set('notes_enc', 'notes', body.notes ? encrypt(clip(body.notes, 12000)) : null);
  if (body.referralDate !== undefined) set('referral_date', 'rdate', validDate(body.referralDate));
  if (body.scheduledDate !== undefined) set('scheduled_date', 'sdate', validDate(body.scheduledDate));
  // Referring facility — provider may set/change it via the UI. Only a facility they're assigned to is
  // accepted (no cross-facility linkage); empty string clears it back to unlinked.
  if (body.facilityUuid !== undefined) {
    let fid = null;
    if (body.facilityUuid) {
      fid = await providerFacilityIdByUuid(providerId, body.facilityUuid);
      if (!fid) { const e = new Error('Facility not found or not assigned to you.'); e.status = 400; e.code = 'REFERRAL_FACILITY_INVALID'; throw e; }
    }
    set('facility_id', 'facId', fid);
  }
  if (!sets.length) return getReferral(providerId, uuid);
  await execute(`UPDATE referrals SET ${sets.join(', ')} WHERE id = :id`, params);
  return getReferral(providerId, uuid);
}

export async function deleteReferral(providerId, uuid) {
  const [res] = await execute('DELETE FROM referrals WHERE uuid = :u AND provider_id = :pid', { u: uuid, pid: providerId });
  return res.affectedRows > 0;
}

export async function listReferrals(providerId, { direction = '', status = '', q = '', page = 1, pageSize = 25 } = {}) {
  const lim = Math.max(1, Math.min(100, Math.floor(Number(pageSize)) || 25));
  const pg = Math.max(1, Math.floor(Number(page)) || 1);
  const off = (pg - 1) * lim;
  const sc = await readScope(providerId); // facility-specific (MD) / own (others) — no cross-facility leak
  const params = { ...sc.params };
  let where = sc.sql;
  if (DIRECTIONS.includes(direction)) { where += ' AND r.direction = :dir'; params.dir = direction; }
  if (STATUSES.includes(status)) { where += ' AND r.status = :st'; params.st = status; }
  const needle = clip(q, 80);
  if (needle) {
    // Plaintext-safe search: referral #, specialty, counterparty, patient MRN (all non-PHI-in-isolation,
    // owner-scoped). Patient NAME is encrypted — matched via the patient name-token blind index (each
    // typed word is a prefix-hash EXISTS, so a name is found without decrypting the table).
    params.like = `%${needle}%`;
    const words = needle.toLowerCase().split(/[\s-]+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    let nameClause = '';
    if (words.length) {
      const conds = words.map((w, i) => { params[`nt${i}`] = blindIndex(w); return `EXISTS (SELECT 1 FROM patient_name_tokens t WHERE t.patient_id = r.patient_id AND t.token_bidx = :nt${i})`; });
      nameClause = ` OR (${conds.join(' AND ')})`;
    }
    where += ` AND (r.referral_no LIKE :like OR r.specialty LIKE :like OR r.counterparty_name LIKE :like
       OR r.counterparty_org LIKE :like OR p.mrn LIKE :like${nameClause})`;
  }
  // COUNT(*) OVER() gives the full-set total in the same round-trip as the page.
  const [rows] = await execute(
    `SELECT r.uuid, r.referral_no, r.direction, r.specialty, r.priority, r.status,
        r.counterparty_name, r.counterparty_org, r.reason_enc, r.diagnosis_enc,
        DATE_FORMAT(r.referral_date, '%Y-%m-%d') AS referral_date_str,
        DATE_FORMAT(r.scheduled_date, '%Y-%m-%d') AS scheduled_date_str, r.updated_at,
        p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
        COUNT(*) OVER() AS _total
      FROM referrals r LEFT JOIN patients p ON p.id = r.patient_id
      WHERE ${where} ORDER BY r.referral_date DESC, r.id DESC LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  const total = rows.length ? Number(rows[0]._total) : 0;
  // Fail-SOFT per row for the LIST: a single corrupt/undecryptable cipher-blob must not 422 the whole
  // page (availability). Surface a clearly-flagged placeholder for the bad row; the single-record fetch
  // (getReferral) stays fail-loud so a specific unreadable record is still reported precisely.
  const referrals = rows.map((r) => {
    try { return toPublicReferral(r); }
    catch (e) {
      logger.error({ uuid: r.uuid, err: e.message }, 'referral row unreadable in list — placeholder returned');
      return { uuid: r.uuid, referralNo: r.referral_no || null, direction: r.direction, status: r.status, unreadable: true };
    }
  });
  return { referrals, total, page: pg, pageSize: lim };
}

/** Per-status counts for one direction (owner-scoped) — powers the tab badges + filter chips. */
export async function referralStats(providerId) {
  const sc = await readScope(providerId); // tab badges reflect exactly what the viewer may see
  const [rows] = await execute(
    `SELECT r.direction, r.status, COUNT(*) AS n FROM referrals r
       LEFT JOIN patients p ON p.id = r.patient_id
      WHERE ${sc.sql} GROUP BY r.direction, r.status`,
    { ...sc.params });
  const out = { outgoing: { total: 0 }, incoming: { total: 0 } };
  for (const s of STATUSES) { out.outgoing[s] = 0; out.incoming[s] = 0; }
  for (const r of rows) { if (out[r.direction]) { out[r.direction][r.status] = Number(r.n); out[r.direction].total += Number(r.n); } }
  return out;
}

/**
 * DETERMINISTIC referral / consultation letter — composed entirely from stored real data (patient
 * demographics, the referral fields, the referring provider's identity). NO AI, no fabrication: every
 * line is a value from the record or fixed Part B boilerplate. Frames the request as a Medicare Part B
 * (POS 31/32) SNF E/M consultation. For an OUTGOING referral the SNF provider is the referrer; for an
 * INCOMING referral the counterparty is the referrer and this provider is the receiving clinician.
 */
export async function generateReferralLetter(providerId, uuid) {
  const sc = await readScope(providerId);
  const [rows] = await execute(
    `SELECT r.uuid, r.referral_no, r.direction, r.specialty, r.priority, r.status,
        r.counterparty_name, r.counterparty_org, r.counterparty_fax, r.counterparty_npi, r.reason_enc, r.diagnosis_enc, r.notes_enc,
        DATE_FORMAT(r.referral_date, '%Y-%m-%d') AS referral_date_str,
        DATE_FORMAT(r.scheduled_date, '%Y-%m-%d') AS scheduled_date_str, r.updated_at,
        r.patient_id AS pat_id, r.facility_id AS fac_id, p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
        u.full_name_enc AS prov_name_enc, u.credentials AS prov_creds, u.npi AS prov_npi, f.name AS fac_name
      FROM referrals r
      LEFT JOIN patients p ON p.id = r.patient_id
      LEFT JOIN users u ON u.id = r.provider_id
      LEFT JOIN facilities f ON f.id = r.facility_id
      WHERE r.uuid = :u AND ${sc.sql} LIMIT 1`,
    { u: uuid, ...sc.params });
  const r = rows[0];
  if (!r) return null;
  const pub = toPublicReferral(r, { full: true });
  let provName = null; try { provName = r.prov_name_enc ? decrypt(r.prov_name_enc) : null; } catch { provName = null; }
  const creds = (() => { try { const c = JSON.parse(r.prov_creds); return Array.isArray(c) ? c.join(', ') : ''; } catch { return String(r.prov_creds || ''); } })();
  const provLine = [provName, creds].filter(Boolean).join(', ') + (r.prov_npi && /^\d{10}$/.test(String(r.prov_npi)) ? ` · NPI ${r.prov_npi}` : '');
  const facName = r.fac_name || pub.patient?.facilityName || '';
  const today = new Date().toISOString().slice(0, 10);
  const pt = pub.patient || {};
  const consultant = ([pub.counterpartyName, pub.counterpartyOrg].filter(Boolean).join(' — ') || '(To be assigned)')
    + (pub.counterpartyNpi ? ` · NPI ${pub.counterpartyNpi}` : '');

  const outgoing = pub.direction === 'outgoing';
  const L = [];
  L.push('REFERRAL / CONSULTATION REQUEST');
  L.push(`Referral #: ${pub.referralNo}    Date: ${pub.referralDate || today}    Priority: ${pub.priority.toUpperCase()}`);
  L.push(`Service Type: ${pub.specialty || '—'}${pub.scheduledDate ? `    Requested/Scheduled: ${pub.scheduledDate}` : ''}`);
  L.push('');
  L.push('FROM (Referring Provider):');
  L.push(outgoing ? `  ${provLine || 'Referring Provider'}` : `  ${consultant}`);
  if (outgoing && facName) L.push(`  ${facName} — Skilled Nursing Facility (POS 31/32)`);
  L.push('');
  L.push('TO (Consultant):');
  L.push(outgoing ? `  ${consultant}` : `  ${provLine || 'Receiving Provider'}${facName ? ` — ${facName}` : ''}`);
  L.push('');
  L.push('PATIENT:');
  L.push(`  ${pt.name || '—'}    DOB: ${pt.dob || '—'}    Sex: ${pt.sex || '—'}`);
  L.push(`  MRN: ${pt.mrn || '—'}${pt.facilityName ? `    Facility: ${pt.facilityName}` : ''}`);
  L.push('');
  L.push('REASON FOR REFERRAL:');
  L.push(`  ${pub.reason || '—'}`);
  L.push('');
  L.push('WORKING DIAGNOSIS:');
  L.push(`  ${pub.diagnosis || '—'}`);
  if (pub.notes) { L.push(''); L.push('CLINICAL NOTES:'); L.push(`  ${pub.notes}`); }
  L.push('');
  L.push('This is a Medicare Part B evaluation & management referral for a skilled nursing facility');
  L.push('resident (POS 31/32). Please evaluate and advise on management; return your consultation');
  L.push('note to the referring provider for the resident’s chart.');
  L.push('');
  L.push(outgoing ? `${provLine || 'Referring Provider'}` : `${consultant}`);
  return {
    letter: L.join('\n'),
    referral: pub,
    provider: { name: provName, credentials: creds, npi: (r.prov_npi && /^\d{10}$/.test(String(r.prov_npi))) ? String(r.prov_npi) : null },
    facilityName: facName,
    patientId: r.pat_id || null,
    facilityId: r.fac_id || null, // the referral's OWN facility — drives the letterhead exactly (no cross-facility brand)
  };
}

/**
 * SEND a referral out by fax (Fax.Plus). Owner-scoped. Generates the deterministic Part B letter,
 * renders it to PDF, faxes it FROM the practice's outgoing number TO the referral's destination fax,
 * and files the sent PDF under Referrals/<facility>/<provider>/<patient>/outgoing/. Fax status +
 * document key are recorded on the referral. Throws (never mock) if fax is not configured/enabled.
 */
export async function sendReferralFax(providerId, uuid) {
  const [own] = await execute('SELECT id, counterparty_fax, patient_id, facility_id FROM referrals WHERE uuid = :u AND provider_id = :pid LIMIT 1', { u: uuid, pid: providerId });
  if (!own[0]) return null;
  if (!own[0].counterparty_fax) { const e = new Error('Add a destination fax number before sending.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
  // Resolve the REFERRING facility from a REAL, provider-authorized source, in priority order: the
  // referral's own snapshot → the patient's CURRENT facility → the PROVIDER's primary assigned facility.
  // A referral created before the patient/facility link (or one whose patient has no facility) still
  // resolves to the sending provider's own facility. This is NOT a shared-number fallback — every source
  // is a facility this provider legitimately operates from. Backfill so letterhead + S3 path stay
  // consistent going forward; if none resolves, facilityId stays null and the send fails loud below.
  let facilityId = own[0].facility_id ? Number(own[0].facility_id) : null;
  if (!facilityId) {
    facilityId = await resolveReferralFacilityId({ patientId: own[0].patient_id }, providerId);
    if (facilityId) await execute('UPDATE referrals SET facility_id = :f WHERE id = :id', { f: facilityId, id: own[0].id });
  }
  // Send strictly FROM the facility's OWN configured outgoing DID. NO FALLBACK to a shared/global number.
  // Honor a Super-Admin facility-level disable, and fail loud if no number is configured.
  const facFax = await resolveFacilityFax(facilityId);
  if (facFax.enabled === false) { const e = new Error('Referral faxing is turned off for this facility. A Super Admin can enable it in Referral fax settings.'); e.status = 403; e.code = 'REFERRAL_FAX_DISABLED'; throw e; }
  if (!facFax.outgoing) {
    const e = new Error(facFax.facility
      ? 'This facility has no outgoing referral fax number configured. A Super Admin must set the facility’s outgoing fax number before referrals can be sent.'
      : 'This referral is not linked to a facility with a configured fax number, so it cannot be faxed. Link the patient to a facility and configure its outgoing fax number.');
    e.status = 409; e.code = 'REFERRAL_FAX_UNCONFIGURED'; throw e;
  }
  const gen = await generateReferralLetter(providerId, uuid);
  if (!gen) return null;
  // Build the PACKAGE: cover page (lists the enclosed records) + every uploaded attachment, in order.
  // The cover LISTS exactly the records enclosed, so the package must be ALL-OR-NOTHING: if any listed
  // record cannot be fetched intact, the fax is NOT sent (no silent drop → no cover/package mismatch,
  // no data loss). Each attachment is scoped to THIS referral (attachmentRowsForReferral filters by
  // referral_id), so no other referral's/patient's record can enter the package.
  const attRows = await attachmentRowsForReferral(own[0].id);
  const attErr = (msg) => { const e = new Error(msg); e.status = 502; e.code = 'REFERRAL_ATTACHMENT'; return e; };
  const decName = (a, fallback) => { if (!a.file_name_enc) return fallback; try { return decrypt(a.file_name_enc); } catch { throw attErr('An enclosed record’s name could not be decrypted (possible corruption) — the fax was NOT sent.'); } };
  const coverAtts = attRows.map((a) => ({ fileName: decName(a, 'Record'), category: 'Enclosed record' }));
  const { buffer: cover } = await referralPdf({ referral: gen.referral, provider: gen.provider, facilityId: gen.facilityId, attachments: coverAtts });
  const files = [{ fileBuffer: cover, fileName: `${gen.referral.referralNo}.pdf`, contentType: 'application/pdf' }];
  for (const a of attRows) {
    let bytes;
    try { bytes = await getObjectBytes(a.s3_key); }
    catch (e) { logger.error({ err: e.message, att: a.uuid }, 'referral attachment fetch failed — fax NOT sent'); throw attErr('An enclosed record could not be retrieved — the fax was NOT sent. Remove or re-upload it and try again.'); }
    if (!bytes || !bytes.length) { logger.error({ att: a.uuid, key: a.s3_key }, 'referral attachment resolved empty — fax NOT sent'); throw attErr('An enclosed record is missing or empty in storage — the fax was NOT sent. Remove or re-upload it and try again.'); }
    files.push({ fileBuffer: bytes, fileName: decName(a, 'record.pdf'), contentType: a.content_type || 'application/pdf' });
  }
  // Completeness guard: cover + every enclosed record must be present, or we do not send (no data loss).
  if (files.length !== attRows.length + 1) throw attErr('The referral package is incomplete — the fax was NOT sent.');
  // Dispatch the whole package FROM this facility's number — if this throws (not enabled / upstream
  // error) we do NOT mark it sent.
  const result = await sendFax({ to: own[0].counterparty_fax, from: facFax.outgoing, files, comment: `Referral ${gen.referral.referralNo}` });
  // File the sent document under the dedicated Referrals tree (facility → provider → patient → outgoing).
  let s3Key = null;
  if (s3Enabled() && gen.referral.patient?.uuid) {
    try {
      const ctx = await getPatientS3Ctx(gen.referral.patient.uuid);
      if (ctx) { await ensureReferralFolder(ctx); s3Key = await uploadReferralObject(ctx, { direction: 'outgoing', fileName: `${gen.referral.referralNo}-${result.faxId || 'sent'}.pdf` }, cover, 'application/pdf'); }
    } catch (e) { logger.error({ err: e.message, uuid }, 'referral outgoing fax S3 store failed'); }
  }
  // Fax.Plus MUST return a tracking id, else the send is unreconcilable (reconcile keys on fax_id) and
  // would sit as a false "sent" forever. Never report a phantom success: record an unconfirmed/error
  // state (kept out of 'sent') and fail loud so the user can verify/retry.
  if (!result.faxId) {
    await execute(
      `UPDATE referrals SET fax_status = 'error', fax_s3_key = :key,
         fax_error = 'Fax provider returned no tracking id — delivery could not be confirmed.' WHERE id = :id`,
      { key: s3Key, id: own[0].id });
    await pushFaxEvent(own[0].id, 'error', 'Fax provider returned no tracking id — delivery unconfirmed, not marked sent');
    logger.error({ uuid, referral: gen.referral.referralNo }, 'outbound fax returned no fax id — marked unconfirmed, NOT sent');
    throw attErr('The fax provider did not confirm the send (no tracking id). The referral was NOT marked sent — please verify and retry.');
  }
  await execute(
    `UPDATE referrals SET fax_id = :fid, fax_status = 'queued', fax_s3_key = :key, fax_error = NULL,
       faxed_at = NOW(), status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END WHERE id = :id`,
    { fid: result.faxId, key: s3Key, id: own[0].id });
  await pushFaxEvent(own[0].id, 'queued', `Submitted to Fax.Plus from ${result.from} → ${own[0].counterparty_fax} (fax ${result.faxId})`);
  return getReferral(providerId, uuid);
}

/** Update a referral's fax status (from a webhook / status poll). By fax_id, no user scope (system). */
export async function updateFaxStatus(faxId, { status, pages, error } = {}) {
  if (!faxId) return false;
  const [rows] = await execute('SELECT id FROM referrals WHERE fax_id = :fid LIMIT 1', { fid: String(faxId) });
  if (!rows[0]) return false;
  await execute(
    'UPDATE referrals SET fax_status = COALESCE(:st, fax_status), fax_pages = COALESCE(:pg, fax_pages), fax_error = :err WHERE id = :id',
    { st: status || null, pg: pages != null ? Number(pages) : null, err: error || null, id: rows[0].id });
  if (status) await pushFaxEvent(rows[0].id, status, error || ''); // real-time timeline entry with timestamp
  return true;
}

// A fax status that needs no further tracking (delivery decided) — kept in sync with the UI's regex.
const FAX_TERMINAL = /success|delivered|complete|failed|error|cancel|no_answer|busy|rejected/i;

/**
 * RECONCILE an outbound fax's status by pulling the AUTHORITATIVE record straight from the Fax.Plus API
 * (getFaxRecord). Used alongside the webhook (push) so status stays correct in real time even if a
 * webhook is ever missed. Owner-scoped, idempotent, best-effort: does nothing when there is no fax id,
 * the status is already terminal, or fax is not live. Persists any change via updateFaxStatus (which
 * appends a timestamped timeline entry). Returns the fresh public referral. No mock, no fallback.
 */
export async function reconcileFaxStatus(providerId, uuid) {
  const [own] = await execute('SELECT id, fax_id, fax_status FROM referrals WHERE uuid = :u AND provider_id = :pid LIMIT 1', { u: uuid, pid: providerId });
  if (!own[0]) return null;
  const r = own[0];
  const settled = r.fax_status && FAX_TERMINAL.test(r.fax_status);
  if (r.fax_id && !settled && faxEnabled()) {
    try {
      const rec = await getFaxRecord(r.fax_id);
      if (rec && rec.status && String(rec.status) !== String(r.fax_status)) {
        await updateFaxStatus(r.fax_id, { status: rec.status, pages: rec.pages, error: rec.error || rec.error_message || null });
      }
    } catch (e) { logger.warn({ err: e.message, uuid }, 'fax status reconcile skipped (upstream)'); }
  }
  return getReferral(providerId, uuid);
}

/**
 * SYNC the Fax.Plus inbox directly via the API (listInbox) and ingest any received fax not yet captured
 * — a safety net so no inbound referral is missed if a webhook was not delivered/registered. Idempotent
 * (ingestIncomingFax dedupes by fax id, routes to the facility by the DID, stores the document + AI).
 * System scope (Super Admin action). Throws a typed error when fax is not live (no mock).
 */
export async function syncInbox() {
  if (!faxEnabled()) { const e = new Error('Fax is not activated yet — complete the Fax.Plus authorization first.'); e.status = 503; e.code = 'FAX_DISABLED'; throw e; }
  const inbox = await listInbox();
  let ingested = 0; let existing = 0;
  for (const rec of inbox) {
    try {
      const res = await ingestIncomingFax({
        id: rec.id || rec.fax_id, to: rec.to_number || rec.to || rec.destination,
        from: rec.from_number || rec.from, file: rec.file || rec.file_id, pages: rec.pages,
      });
      if (res?.existing) existing += 1; else if (res) ingested += 1;
    } catch (e) { logger.warn({ err: e.message, faxId: rec.id || rec.fax_id }, 'inbox sync: one fax skipped'); }
  }
  logger.info({ total: inbox.length, ingested, existing }, 'Fax inbox synced from Fax.Plus');
  return { total: inbox.length, ingested, existing };
}

/**
 * SYSTEM-LEVEL self-heal: re-store the received document for any INCOMING referral that has a fax file
 * reference but no stored S3 object (an intake store that failed). Guarantees "every received record is
 * stored" without a provider having to click Retrieve. Idempotent (skips rows already stored), best-effort
 * per row (a failure is logged, never silent, and never aborts the batch). Returns counts.
 */
export async function selfHealIncomingDocuments(limit = 200) {
  if (!faxEnabled() || !s3Enabled()) return { candidates: 0, healed: 0, stillMissing: 0 };
  const [rows] = await execute(
    `SELECT r.id, r.fax_id, r.facility_id, f.uuid AS fac_uuid, f.name AS fac_name
       FROM referrals r LEFT JOIN facilities f ON f.id = r.facility_id
      WHERE r.direction = 'incoming' AND r.fax_s3_key IS NULL AND r.fax_id IS NOT NULL
      ORDER BY r.id DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 200))}`);
  let healed = 0; let stillMissing = 0;
  for (const r of rows) {
    try {
      const { buffer } = await downloadFaxFile(r.fax_id); // download by fax id (documented key)
      if (!buffer || !buffer.length) throw new Error('received document is empty in the fax service');
      const ctx = r.fac_uuid ? { facilityUuid: r.fac_uuid, facilityName: r.fac_name } : null;
      const key = await uploadReferralObject(ctx, { direction: 'incoming', fileName: `${r.fax_id}.pdf` }, buffer, 'application/pdf');
      await execute('UPDATE referrals SET fax_s3_key = :k, fax_error = NULL WHERE id = :id', { k: key, id: r.id });
      await pushFaxEvent(r.id, 'received', 'Received document stored (auto self-heal)');
      healed += 1;
    } catch (e) { stillMissing += 1; logger.warn({ err: e.message, faxId: r.fax_id }, 'incoming doc self-heal: one row still missing (will retry next cycle)'); }
  }
  if (rows.length) logger.info({ candidates: rows.length, healed, stillMissing }, 'incoming fax document self-heal run');
  return { candidates: rows.length, healed, stillMissing };
}

/**
 * SYSTEM-LEVEL reconcile of every IN-FLIGHT OUTBOUND fax: pull the authoritative record from Fax.Plus for
 * any outbound referral whose status is not yet terminal, so a delivery outcome is never missed even if a
 * status webhook was not delivered. Idempotent (only writes on change), best-effort per row (logged).
 */
export async function reconcileOutboundInflight(limit = 200) {
  if (!faxEnabled()) return { checked: 0, updated: 0 };
  const [rows] = await execute(
    `SELECT id, fax_id, fax_status FROM referrals
      WHERE direction = 'outgoing' AND fax_id IS NOT NULL
        AND (fax_status IS NULL OR fax_status NOT REGEXP 'success|delivered|complete|failed|error|cancel|no_answer|busy|rejected')
      ORDER BY id DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 200))}`);
  let updated = 0;
  for (const r of rows) {
    try {
      const rec = await getFaxRecord(r.fax_id);
      if (rec && rec.status && String(rec.status) !== String(r.fax_status)) {
        await updateFaxStatus(r.fax_id, { status: rec.status, pages: rec.pages, error: rec.error || rec.error_message || null });
        updated += 1;
      }
    } catch (e) { logger.warn({ err: e.message, faxId: r.fax_id }, 'outbound status reconcile: one fax skipped (upstream)'); }
  }
  if (rows.length) logger.info({ checked: rows.length, updated }, 'outbound in-flight fax reconcile run');
  return { checked: rows.length, updated };
}

/**
 * ALL-IN-ONE fax reconciliation, run on a timer (and on demand) so NOTHING is missed and NOTHING is lost:
 *  1) inbox catch-up   — ingest any received fax a webhook did not deliver (idempotent),
 *  2) document self-heal — store any received document that failed to store,
 *  3) outbound reconcile — settle any in-flight sent fax's status from the authoritative record.
 * Each phase is independent and best-effort: a failure in one is logged (never silent) and never blocks
 * the others. Throws only when fax is not live (caller decides whether that's expected).
 */
export async function reconcileAllFaxes() {
  if (!faxEnabled()) { const e = new Error('Fax is not activated.'); e.status = 503; e.code = 'FAX_DISABLED'; throw e; }
  const out = { inbox: null, selfHeal: null, outbound: null };
  try { out.inbox = await syncInbox(); } catch (e) { out.inbox = { error: e.message }; logger.error({ err: e.message }, 'reconcile: inbox phase failed'); }
  try { out.selfHeal = await selfHealIncomingDocuments(); } catch (e) { out.selfHeal = { error: e.message }; logger.error({ err: e.message }, 'reconcile: self-heal phase failed'); }
  try { out.outbound = await reconcileOutboundInflight(); } catch (e) { out.outbound = { error: e.message }; logger.error({ err: e.message }, 'reconcile: outbound phase failed'); }
  return out;
}

/**
 * INGEST an inbound fax as an incoming referral (called by the verified Fax.Plus webhook). Idempotent
 * by fax id. In real time it: (1) routes the fax to the facility that owns the receiving DID, (2)
 * downloads the received PDF and files it under THAT facility's own Referrals S3 folder (never a generic
 * bucket) — retried, and any failure recorded (fax_file_id is kept so it can be re-fetched: no silent
 * loss), (3) runs Fax.Plus AI ONCE for triage and caches it on the row (no re-runs → no AI overusage),
 * (4) creates the UNASSIGNED incoming referral owned by the master-admin intake account so a provider
 * can review and link it to a patient.
 */
const titleCaseName = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
/** Split an extracted patient name into { firstName, lastName } (handles "Last, First" and "First … Last").
 *  Credential suffixes and non-name characters are stripped. Deterministic. */
export function splitPatientName(full) {
  const s = String(full || '')
    .replace(/^\s*(?:dr|mr|mrs|ms|miss|mx|prof|sir|madam)\.?\s+/i, '') // leading honorific/title
    .replace(/\b(md|do|np|pa|rn|dds|dpm|phd|faan|facp)\b\.?/gi, '') // trailing credentials
    .replace(/[^A-Za-z'\- ,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { firstName: '', lastName: '' };
  if (s.includes(',')) { const [ln, rest] = s.split(','); return { lastName: titleCaseName(ln), firstName: titleCaseName((rest || '').trim().split(' ')[0]) }; }
  const parts = s.split(' ').filter(Boolean);
  if (parts.length < 2) return { firstName: '', lastName: titleCaseName(parts[0] || '') };
  return { firstName: titleCaseName(parts[0]), lastName: titleCaseName(parts[parts.length - 1]) };
}
/**
 * PURE, DETERMINISTIC dedupe/link decision for an inbound-fax patient (unit-testable, no DB). Given the
 * extracted DOB and the same-name candidate charts (already facility-scoped by the caller) decide whether
 * to LINK an existing chart, CREATE a new one, leave for MANUAL review, or report BLOCKED (auto-create off).
 * Guarantees: (1) no duplicate — a same-name+DOB chart is always linked; (2) no wrong-patient — a no-DOB fax
 * with multiple same-name charts is never auto-linked (manual); (3) creation only when truly not present.
 * @param {{dob?:string, candidates?:Array<{id:number,dob?:string}>, allowCreate?:boolean}} args
 */
export function decidePatientMatch({ dob = '', candidates = [], allowCreate = true } = {}) {
  const cands = Array.isArray(candidates) ? candidates.filter((c) => c && c.id != null) : [];
  const d = String(dob || '').slice(0, 10);
  let res;
  if (d) {
    const exact = cands.find((c) => String(c.dob || '').slice(0, 10) === d);
    if (exact) res = { action: 'link', id: exact.id, reason: 'matched existing chart (name + DOB)' };
    else if (cands.length === 1 && !cands[0].dob) res = { action: 'link', id: cands[0].id, reason: 'matched existing chart (name; chart had no DOB)' };
    else res = { action: 'create', reason: 'not in system (name present, DOB differs) → new chart' };
  } else if (cands.length === 1) res = { action: 'link', id: cands[0].id, reason: 'matched existing chart (single same-name, no DOB)' };
  else if (cands.length > 1) res = { action: 'manual', reason: 'ambiguous — multiple same-name charts and no DOB to disambiguate (manual review)' };
  else res = { action: 'create', reason: 'not in system → new chart' };
  if (res.action === 'create' && !allowCreate) return { action: 'blocked', reason: 'not in system; auto-create disabled — queued for manual review' };
  return res;
}

/** An ACTIVE provider assigned to the facility (prefers a physician) to OWN an auto-created patient. */
async function facilityOwningProviderId(facilityId) {
  if (!facilityId) return null;
  const [rows] = await execute(
    `SELECT pf.provider_id AS id FROM provider_facilities pf JOIN users u ON u.id = pf.provider_id
       WHERE pf.facility_id = :fid AND u.status = 'active'
       ORDER BY FIELD(u.role, 'md', 'do', 'physician', 'provider') DESC, pf.provider_id LIMIT 1`, { fid: facilityId });
  return rows[0]?.id || null;
}
/**
 * DETERMINISTIC match-or-create of the patient an inbound referral is for. FACILITY-SCOPED throughout so a
 * fax can NEVER link to or create a patient outside the DID-routed facility (no cross-facility leakage):
 *  - MATCH: exact name blind-index within THIS facility; confirmed by DOB when both sides have one.
 *  - CREATE: only when the facility is known AND a real patient name is present AND the facility has an
 *    active provider to own the record. The new patient is pinned to THIS facility. Insurance carries over.
 * Returns { patientId, created, reason }. Never fabricates a name; a nameless/facility-less fax stays
 * unlinked in the intake queue (document still stored — no data loss).
 */
async function matchOrCreatePatientForReferral(extracted, { facilityId, createdBy, allowCreate = true } = {}) {
  const p = (extracted && extracted.patient) || {};
  const { firstName, lastName } = splitPatientName(p.name);
  if (!facilityId) return { patientId: null, created: false, reason: 'unknown DID — no facility to scope patient' };
  if (!firstName || !lastName) return { patientId: null, created: false, reason: 'no patient name on document' };
  const nameKey = `${lastName} ${firstName}`.trim().toLowerCase();
  const bidx = blindIndex(nameKey);
  const dob = p.dob || '';

  // Load same-NAME charts in THIS facility (facility-scoped → no cross-facility leakage) with their DOB.
  const loadCands = async () => {
    const [rows] = await execute('SELECT id, demographics_enc FROM patients WHERE name_bidx = :b AND facility_id = :f ORDER BY id', { b: bidx, f: facilityId });
    return rows.map((c) => { let d = {}; try { d = JSON.parse(decrypt(c.demographics_enc)); } catch { d = {}; } return { id: c.id, dob: d.dob ? String(d.dob).slice(0, 10) : '' }; });
  };
  const decide = (cands) => decidePatientMatch({ dob, candidates: cands, allowCreate });

  const first = decide(await loadCands());
  if (first.action === 'link') return { patientId: first.id, created: false, reason: first.reason };
  if (first.action === 'manual') return { patientId: null, created: false, reason: first.reason };
  if (first.action === 'blocked') return { patientId: null, created: false, reason: first.reason };

  const providerId = await facilityOwningProviderId(facilityId);
  if (!providerId) return { patientId: null, created: false, reason: 'no active provider at facility to own a new patient' };
  const created = await createPatient({
    providerId,
    demographics: { firstName, lastName, ...(dob ? { dob } : {}), ...(p.sex ? { sex: p.sex } : {}), ...(p.phone ? { phone: p.phone } : {}) },
    insurance: (extracted.insurance || []).filter((x) => x && (x.payer || x.memberId)),
    facility: null,
    createdBy,
  });
  const [row] = await execute('SELECT id FROM patients WHERE uuid = :u LIMIT 1', { u: created.uuid });
  const newId = row[0]?.id || null;
  // Pin the new patient to THIS facility (createPatient derives facility from the provider's PRIMARY
  // assignment, which may differ) — guarantees facility-scoping matches the DID (no cross-facility leak).
  if (newId) await execute('UPDATE patients SET facility_id = :f WHERE id = :id AND (facility_id IS NULL OR facility_id <> :f)', { f: facilityId, id: newId });
  // RACE GUARD (no duplicates under concurrency): if a simultaneous fax for the SAME patient created a
  // chart between our decide() and insert, more than one now matches. Re-decide over the fresh set; if the
  // winner is an EARLIER chart (not the one we just made), delete our just-created duplicate (it has no
  // children yet — the document is filed AFTER this returns) and link the earlier one.
  const after = await loadCands();
  const settled = decide(after);
  if (settled.action === 'link' && settled.id && settled.id !== newId) {
    if (newId) await execute('DELETE FROM patients WHERE id = :id', { id: newId }).catch(() => {});
    return { patientId: settled.id, created: false, reason: 'deduped to concurrently-created chart (no duplicate)' };
  }
  return { patientId: newId, created: true, reason: first.reason };
}

export async function ingestIncomingFax(rec = {}) {
  const faxId = String(rec.id || rec.fax_id || '');
  if (!faxId) return null;
  const [exist] = await execute('SELECT uuid FROM referrals WHERE fax_id = :f LIMIT 1', { f: faxId });
  if (exist[0]) return { uuid: exist[0].uuid, existing: true };

  // (1) FACILITY-SPECIFIC routing: the DID this fax arrived on maps to exactly one facility, so a
  // received referral surfaces only under that facility (never cross-facility). Unknown DID → intake queue.
  const toNum = rec.to_number || rec.to || rec.destination || '';
  let facility = null;
  try { facility = await facilityByIncomingFaxNumber(toNum); } catch (e) { logger.warn({ err: e.message, faxId }, 'inbound fax facility routing failed'); }
  const facilityId = facility?.id || null;
  const facilityCtx = facility ? { facilityUuid: facility.uuid, facilityName: facility.name } : null;

  // Resolve the file reference + page count. The webhook may omit the file id — fetch the fax record so
  // EVERY received fax's document is captured (nothing missed). Page count comes from the fax record; the
  // document itself is downloaded by FAX ID (the documented key), not the record's file token.
  let fileRef = rec.file || rec.file_id || null; // kept for reference/debugging only (not the download key)
  let pages = Number(rec.pages) || null;
  if (!pages && faxEnabled()) {
    try { const fr = await getFaxRecord(faxId); if (fr) { fileRef = fileRef || fr.file || fr.file_id || null; pages = pages || Number(fr.pages) || null; } }
    catch (e) { logger.warn({ err: e.message, faxId }, 'inbound fax record lookup failed'); }
  }

  // (2) Download the received document ONCE (by FAX ID per Fax.Plus docs) and reuse the SAME buffer for
  // both S3 storage and deterministic OCR extraction — one fetch, no double download, no data loss. If it
  // cannot be stored, keep the fax id (re-fetchable) and record the error — never a silent loss.
  let s3Key = null; let storeErr = null; let docBuffer = null; let docSize = null;
  if (faxId && (s3Enabled() || ocrEnabled())) {
    for (let attempt = 1; attempt <= 2 && !docBuffer; attempt += 1) {
      try {
        const { buffer } = await downloadFaxFile(faxId);
        if (!buffer || !buffer.length) throw new Error('received document is empty');
        docBuffer = buffer; docSize = buffer.length;
      } catch (e) { storeErr = e.message; logger.error({ err: e.message, faxId, attempt }, 'incoming fax download failed'); }
    }
    if (docBuffer && s3Enabled()) {
      try { s3Key = await uploadReferralObject(facilityCtx, { direction: 'incoming', fileName: `${faxId}.pdf` }, docBuffer, 'application/pdf'); }
      catch (e) { storeErr = e.message; logger.error({ err: e.message, faxId }, 'incoming fax store failed'); }
    }
  }

  // (3) DETERMINISTIC field extraction from the received document via the local PaddleOCR service — the
  // AUTHORITATIVE source for the structured referral fields (patient identity, referring provider/facility,
  // reason, diagnosis+ICD, specialty, urgency, insurance). Best-effort + real-time: any OCR failure is
  // LOGGED (never swallowed) and leaves the fields empty — the fax + document are still ingested & stored
  // (no data loss). Deterministic (same scan → same fields), no AI, no mock, no fabrication.
  let extracted = null;
  if (docBuffer && ocrEnabled()) {
    try { extracted = await extractReferralFax({ buffer: docBuffer, contentType: 'application/pdf', fileName: `${faxId}.pdf` }); }
    catch (e) { logger.error({ err: e.message, code: e.code, faxId }, 'deterministic inbound fax extraction failed (fax still ingested)'); }
  }
  const ex = extracted || {};
  const exPatient = ex.patient || {}; const exReferring = ex.referring || {}; const exReferral = ex.referral || {};
  // Optional Fax.Plus AI triage (secondary, non-authoritative) — kept only when the account has AI credits.
  let aiJson = null;
  if (faxEnabled() && await faxAiAvailable()) {
    try {
      const ai = await faxAi(faxId, 'extract');
      if (ai && (ai.text || ai.fields)) aiJson = JSON.stringify(ai).slice(0, 60000);
    } catch (e) { logger.warn({ err: e.message, code: e.code, faxId }, 'inbound fax AI triage skipped'); }
  }

  // Intake owner for the inbound-fax queue: prefer an active master_admin, else fall back to an active
  // super_admin — so a received PHI fax is never DROPPED just because no master_admin happens to exist.
  const [[owner]] = [await execute(
    "SELECT id FROM users WHERE role IN ('master_admin','super_admin') AND status = 'active' ORDER BY FIELD(role,'master_admin','super_admin'), id LIMIT 1")].map((x) => x[0]);
  if (!owner) { logger.error({ faxId }, 'no active master_admin/super_admin to own inbound fax referral — fax left in provider inbox for retry'); return null; }

  // (4) Resolve (match) OR create the patient this referral is FOR — deterministically, facility-scoped so
  // there is NO cross-facility/cross-patient leakage. A name+DOB match within the SAME facility links the
  // existing chart; otherwise a new patient is auto-created under a provider at that facility (real-time).
  // Auto-CREATE gate = GLOBAL super-admin setting AND the FACILITY-SPECIFIC toggle (both live-read so a
  // toggle takes effect in ~real time). Matching an EXISTING chart is ALWAYS allowed (safe, dedupes);
  // only creating a NEW chart is gated. When creation is off and no chart matches, the fax stays unlinked
  // in the intake queue for manual review — document still stored (no data loss).
  let patientId = null; let patientCreated = false; let patientReason = 'no extraction';
  if (extracted) {
    let allowCreate = false;
    try { allowCreate = (await isFaxAutoCreateEnabled()) && (await facilityFaxAutoCreateEnabled(facilityId)); }
    catch (e) { logger.warn({ err: e.message, faxId }, 'auto-create flag read failed — defaulting to no auto-create'); }
    try { const pr = await matchOrCreatePatientForReferral(ex, { facilityId, createdBy: owner.id, allowCreate }); patientId = pr.patientId; patientCreated = pr.created; patientReason = pr.reason || (pr.created ? 'created' : 'matched'); }
    catch (e) { logger.error({ err: e.message, faxId }, 'inbound fax patient match/create failed (referral still ingested)'); patientReason = `patient link failed: ${e.message}`; }
  }

  // Structured referral fields from the DETERMINISTIC extraction (fall back to the fax metadata when a
  // field wasn't on the document — never fabricated). counterparty = the REFERRING (sending) side.
  const fromNum = clip(rec.from_number || rec.from, 32).replace(/[^\d+]/g, '') || null;
  const counterpartyName = clip(exReferring.provider || exReferring.org || '', 160) || fromNum;
  const counterpartyOrg = clip(exReferring.org || '', 160) || null;
  const counterpartyNpi = /^\d{10}$/.test(exReferring.npi || '') ? exReferring.npi : null;
  const specialty = clip(exReferral.specialty || '', 100) || 'Unassigned (inbound fax)';
  const priority = ['routine', 'urgent', 'stat'].includes(exReferral.urgency) ? exReferral.urgency : 'routine';
  const reasonEnc = exReferral.reason ? encrypt(exReferral.reason) : null;
  const diagnosisEnc = exReferral.diagnosis ? encrypt(exReferral.diagnosis) : null;
  const extractedEnc = extracted ? encrypt(JSON.stringify(extracted)).slice(0, 16384) : null;

  const uuid = uuidv4();
  let ins;
  try {
    [ins] = await execute(
      `INSERT INTO referrals (uuid, referral_no, provider_id, patient_id, facility_id, direction, specialty, priority, status,
          counterparty_name, counterparty_org, counterparty_npi, counterparty_fax, reason_enc, diagnosis_enc,
          fax_id, fax_status, fax_file_id, fax_s3_key, fax_pages, fax_error, fax_ai, fax_ai_at,
          extracted_enc, extracted_at, referral_date, created_by, faxed_at)
       VALUES (:uuid, :tmpNo, :owner, :patientId, :facId, 'incoming', :specialty, :priority, 'received',
          :cpName, :cpOrg, :cpNpi, :from, :reasonEnc, :diagnosisEnc,
          :fid, 'received', :fileRef, :key, :pages, :err, :ai, :aiAt,
          :exEnc, :exAt, CURDATE(), :owner, NOW())`,
      { uuid, tmpNo: `TMP-${uuid.slice(0, 18)}`, owner: owner.id, patientId, facId: facilityId,
        specialty, priority, cpName: counterpartyName, cpOrg: counterpartyOrg, cpNpi: counterpartyNpi, from: fromNum,
        reasonEnc, diagnosisEnc, fid: faxId, fileRef: fileRef ? String(fileRef).slice(0, 128) : null, key: s3Key,
        pages, err: s3Key ? null : (storeErr ? String(storeErr).slice(0, 255) : null),
        ai: aiJson ? JSON.stringify({ v: 1, enc: encrypt(aiJson).toString('base64') }) : null,
        aiAt: aiJson ? new Date() : null,
        exEnc: extractedEnc, exAt: extracted ? new Date() : null });
  } catch (e) {
    // Race guard: a concurrent ingest (webhook + poll) already inserted this fax_id — the UNIQUE index
    // (uniq_ref_fax_id) rejects the duplicate. Treat as already-ingested (idempotent, no duplicate row).
    if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
      const [dup] = await execute('SELECT uuid FROM referrals WHERE fax_id = :f LIMIT 1', { f: faxId });
      if (dup[0]) { logger.info({ faxId }, 'inbound fax already ingested by a concurrent run (dedup)'); return { uuid: dup[0].uuid, existing: true }; }
    }
    throw e; // any other error is real — never silently swallowed
  }
  await execute("UPDATE referrals SET referral_no = CONCAT('RXF-', LPAD(id, 6, '0')) WHERE id = :id", { id: ins.insertId });

  // (5) File the received document into the LINKED patient's Documents section — so the referral letter and
  // enclosed pages live in that patient's chart (never another patient's). Best-effort; a failure here is
  // logged and leaves the document safely stored under the referral (re-linkable) — no data loss.
  let filedDocUuid = null;
  if (patientId && s3Key) {
    try {
      const doc = await createDocumentRecord({
        patientId, docType: 'referral', s3Key,
        fileName: `Incoming referral fax${faxId ? ` ${faxId}` : ''}${pages ? ` (${pages}p)` : ''}.pdf`,
        contentType: 'application/pdf', size: docSize, uploadedBy: owner.id,
        serviceDate: new Date().toISOString().slice(0, 10),
      });
      filedDocUuid = doc?.uuid || null;
    } catch (e) { logger.error({ err: e.message, faxId, patientId }, 'filing inbound fax into patient documents failed (document still stored on referral)'); }
  }

  await pushFaxEvent(ins.insertId, 'received', `Inbound fax${facility ? ` for ${facility.name}` : ''}${s3Key ? ' — document stored' : (storeErr ? ` — store failed: ${storeErr}` : '')}${patientId ? ` — ${patientCreated ? 'patient created' : 'patient matched'}${filedDocUuid ? ' + filed to chart' : ''}` : (extracted ? ` — not linked (${patientReason})` : '')}`);
  logger.info({ faxId, referralId: ins.insertId, facilityId, stored: !!s3Key, extracted: !!extracted, patientId, patientCreated, filed: !!filedDocUuid }, 'Inbound fax ingested as incoming referral');
  return { uuid, existing: false, stored: !!s3Key, facilityId, patientId, patientCreated };
}

/**
 * Re-store an inbound fax's document into S3 if it is missing (e.g. the original store failed) — a
 * self-heal used to guarantee "every received record is stored". Owner/facility-scoped; returns the new
 * s3 key or null. Idempotent-safe: does nothing if the document is already stored.
 */
export async function restoreInboundDocument(providerId, uuid) {
  const sc = await readScope(providerId);
  const [rows] = await execute(
    `SELECT r.id, r.fax_id, r.fax_file_id, r.fax_s3_key, r.facility_id, f.uuid AS fac_uuid, f.name AS fac_name
       FROM referrals r LEFT JOIN patients p ON p.id = r.patient_id LEFT JOIN facilities f ON f.id = r.facility_id
      WHERE r.uuid = :u AND r.direction = 'incoming' AND ${sc.sql} LIMIT 1`, { u: uuid, ...sc.params });
  const r = rows[0];
  if (!r) return null;
  if (r.fax_s3_key) return r.fax_s3_key; // already stored — no duplicate work
  if (!r.fax_id || !s3Enabled() || !faxEnabled()) { const e = new Error('The received document cannot be retrieved right now.'); e.status = 409; e.code = 'REFERRAL_ATTACHMENT'; throw e; }
  const { buffer } = await downloadFaxFile(r.fax_id); // download by fax id (documented key)
  if (!buffer || !buffer.length) { const e = new Error('The received document is empty in the fax service.'); e.status = 502; e.code = 'REFERRAL_ATTACHMENT'; throw e; }
  const ctx = r.fac_uuid ? { facilityUuid: r.fac_uuid, facilityName: r.fac_name } : null;
  const key = await uploadReferralObject(ctx, { direction: 'incoming', fileName: `${r.fax_id}.pdf` }, buffer, 'application/pdf');
  await execute('UPDATE referrals SET fax_s3_key = :k, fax_error = NULL WHERE id = :id', { k: key, id: r.id });
  await pushFaxEvent(r.id, 'received', 'Received document stored (re-fetched)');
  return key;
}

/**
 * SUPER-ADMIN oversight — ALL referrals across every facility/provider (NO scope filter). The caller
 * MUST be a super/master admin (enforced at the route with authorize()). Adds the owning provider +
 * facility name so the admin can see who/where. Never call this from a provider-facing path.
 */
export async function listAllReferrals({ direction = '', status = '', q = '', page = 1, pageSize = 25 } = {}) {
  const lim = Math.max(1, Math.min(100, Math.floor(Number(pageSize)) || 25));
  const pg = Math.max(1, Math.floor(Number(page)) || 1);
  const off = (pg - 1) * lim;
  const params = {};
  let where = '1=1';
  if (DIRECTIONS.includes(direction)) { where += ' AND r.direction = :dir'; params.dir = direction; }
  if (STATUSES.includes(status)) { where += ' AND r.status = :st'; params.st = status; }
  const needle = clip(q, 80);
  if (needle) { where += ' AND (r.referral_no LIKE :like OR r.specialty LIKE :like OR r.counterparty_name LIKE :like OR p.mrn LIKE :like)'; params.like = `%${needle}%`; }
  const [rows] = await execute(
    `SELECT r.uuid, r.referral_no, r.direction, r.specialty, r.priority, r.status, r.counterparty_name,
        r.counterparty_org, r.fax_id, r.fax_status, r.fax_s3_key, r.fax_error,
        DATE_FORMAT(r.referral_date, '%Y-%m-%d') AS referral_date_str, r.updated_at,
        p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
        u.full_name_enc AS owner_name_enc, f.name AS facility_name, COUNT(*) OVER() AS _total
      FROM referrals r
      LEFT JOIN patients p ON p.id = r.patient_id
      LEFT JOIN users u ON u.id = r.provider_id
      LEFT JOIN facilities f ON f.id = r.facility_id
      WHERE ${where} ORDER BY r.referral_date DESC, r.id DESC LIMIT ${lim} OFFSET ${off}`, params);
  const total = rows.length ? Number(rows[0]._total) : 0;
  const items = rows.map((r) => {
    const pub = toPublicReferral(r);
    let owner = null; try { owner = r.owner_name_enc ? decrypt(r.owner_name_enc) : null; } catch { owner = null; }
    return { ...pub, owner, facilityName: r.facility_name || pub.patient?.facilityName || null };
  });
  return { referrals: items, total, page: pg, pageSize: lim };
}

export async function allReferralStats() {
  const [rows] = await execute('SELECT direction, status, COUNT(*) AS n FROM referrals GROUP BY direction, status');
  const out = { outgoing: { total: 0 }, incoming: { total: 0 }, faxed: 0, failed: 0 };
  for (const s of STATUSES) { out.outgoing[s] = 0; out.incoming[s] = 0; }
  for (const r of rows) { if (out[r.direction]) { out[r.direction][r.status] = Number(r.n); out[r.direction].total += Number(r.n); } }
  const [[fx]] = [await execute("SELECT SUM(fax_id IS NOT NULL) faxed, SUM(fax_status IN ('failed','error') OR fax_error IS NOT NULL) failed FROM referrals")].map((x) => x[0]);
  out.faxed = Number(fx.faxed || 0); out.failed = Number(fx.failed || 0);
  return out;
}

/**
 * Generate the enterprise referral PDF buffer (scoped) — for the on-screen PREVIEW panel and download,
 * and reused by the fax send so the faxed document is byte-identical to what the provider previewed.
 * `attachments` (optional) is the list of enclosed-record metadata to list on the cover page.
 */
export async function referralPdfBuffer(providerId, uuid) {
  const gen = await generateReferralLetter(providerId, uuid); // scope-checked; null if out of scope
  if (!gen) return null;
  const atts = (await listReferralAttachments(providerId, uuid)) || [];
  const attachments = atts.map((a) => ({ fileName: a.fileName, category: 'Enclosed record' }));
  return referralPdf({ referral: gen.referral, provider: gen.provider, facilityId: gen.facilityId, attachments });
}

/**
 * Stream an INCOMING referral's RECEIVED document (the inbound fax PDF stored in S3) for in-app viewing.
 * Read-scoped exactly like the rest of the EHR (facility-wide MD / owner), so a provider only ever sees a
 * received fax for their own facility — no cross-facility leakage. Returns { buffer, filename } or null
 * (out of scope / not incoming / not yet stored). Fail-loud on a storage error (never a blank).
 */
export async function receivedDocumentBuffer(providerId, uuid) {
  const sc = await readScope(providerId);
  const [rows] = await execute(
    `SELECT r.referral_no, r.fax_s3_key, r.direction FROM referrals r
       LEFT JOIN patients p ON p.id = r.patient_id
      WHERE r.uuid = :u AND r.direction = 'incoming' AND ${sc.sql} LIMIT 1`,
    { u: uuid, ...sc.params });
  const r = rows[0];
  if (!r) return null;
  if (!r.fax_s3_key) { const e = new Error('The received document is not stored yet. Use “Retrieve document”.'); e.status = 409; e.code = 'REFERRAL_ATTACHMENT'; throw e; }
  const buffer = await getObjectBytes(r.fax_s3_key);
  if (!buffer || !buffer.length) { const e = new Error('The received document could not be read from storage.'); e.status = 502; e.code = 'REFERRAL_ATTACHMENT'; throw e; }
  return { buffer, filename: `received-${slugSafe(r.referral_no)}.pdf` };
}
function slugSafe(s) { return String(s || 'fax').replace(/[^A-Za-z0-9._-]+/g, '-'); }

// ---- Referral attachments (uploaded PDF records enclosed in the faxed package) ------------------
/** Resolve the OWNED referral row (owner-scoped write) + its patient uuid, or null. */
async function ownedReferralRow(providerId, uuid) {
  const [rows] = await execute(
    `SELECT r.id, r.referral_no, r.patient_id, p.uuid AS patient_uuid FROM referrals r
       LEFT JOIN patients p ON p.id = r.patient_id WHERE r.uuid = :u AND r.provider_id = :pid LIMIT 1`,
    { u: uuid, pid: providerId });
  return rows[0] || null;
}

/** Attach an uploaded PDF record to a referral (owner-scoped). Stored in the Referrals/ S3 tree under
 *  the patient's outgoing folder; the filename is encrypted. Returns the public attachment metadata. */
export async function addReferralAttachment(providerId, uuid, { fileName, buffer, contentType = 'application/pdf', size } = {}) {
  const r = await ownedReferralRow(providerId, uuid);
  if (!r) return null;
  if (!Buffer.isBuffer(buffer) || !buffer.length) { const e = new Error('Empty file.'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
  if (!s3Enabled()) { const e = new Error('Document storage (S3) is not configured.'); e.status = 503; e.code = 'REFERRAL_INVALID'; throw e; }
  const [[cnt]] = [await execute('SELECT COUNT(*) n FROM referral_attachments WHERE referral_id = :id', { id: r.id })].map((x) => x[0]);
  if (Number(cnt.n) >= 9) { const e = new Error('A fax package can enclose at most 9 records (plus the cover).'); e.status = 400; e.code = 'REFERRAL_INVALID'; throw e; }
  const attUuid = uuidv4();
  const safeName = clip(fileName, 200) || `record-${attUuid.slice(0, 8)}.pdf`;
  let s3Key = null;
  if (r.patient_uuid) {
    const ctx = await getPatientS3Ctx(r.patient_uuid);
    if (ctx) { await ensureReferralFolder(ctx); s3Key = await uploadReferralObject(ctx, { direction: 'outgoing', fileName: `${r.referral_no}-att-${attUuid.slice(0, 8)}.pdf` }, buffer, contentType); }
  }
  if (!s3Key) s3Key = await uploadReferralObject(null, { direction: 'outgoing', fileName: `${r.referral_no}-att-${attUuid.slice(0, 8)}.pdf` }, buffer, contentType);
  await execute(
    `INSERT INTO referral_attachments (uuid, referral_id, file_name_enc, s3_key, content_type, size_bytes, uploaded_by)
     VALUES (:u, :rid, :nameEnc, :key, :ct, :size, :by)`,
    { u: attUuid, rid: r.id, nameEnc: encrypt(safeName), key: s3Key, ct: clip(contentType, 120) || null, size: size || buffer.length, by: providerId });
  return { uuid: attUuid, fileName: safeName, contentType, size: size || buffer.length };
}

const attPublic = (row) => ({ uuid: row.uuid, fileName: row.file_name_enc ? decrypt(row.file_name_enc) : null, contentType: row.content_type, size: Number(row.size_bytes) || null, createdAt: row.created_at });

/** List a referral's uploaded attachments (owner/facility-scoped via the referral). */
export async function listReferralAttachments(providerId, uuid) {
  const sc = await readScope(providerId);
  const [own] = await execute(`SELECT r.id FROM referrals r LEFT JOIN patients p ON p.id = r.patient_id WHERE r.uuid = :u AND ${sc.sql} LIMIT 1`, { u: uuid, ...sc.params });
  if (!own[0]) return null;
  const [rows] = await execute('SELECT uuid, file_name_enc, content_type, size_bytes, created_at FROM referral_attachments WHERE referral_id = :id ORDER BY id', { id: own[0].id });
  return rows.map(attPublic);
}

/** Delete one attachment (owner-scoped write). */
export async function deleteReferralAttachment(providerId, uuid, attUuid) {
  const r = await ownedReferralRow(providerId, uuid);
  if (!r) return null;
  const [rows] = await execute('SELECT s3_key FROM referral_attachments WHERE uuid = :a AND referral_id = :rid LIMIT 1', { a: attUuid, rid: r.id });
  if (!rows[0]) return false;
  const [res] = await execute('DELETE FROM referral_attachments WHERE uuid = :a AND referral_id = :rid', { a: attUuid, rid: r.id });
  // Remove the S3 object too so no orphan is left behind (best-effort — the DB row is the source of truth).
  if (res.affectedRows > 0 && rows[0].s3_key && s3Enabled()) { try { await deleteObject(rows[0].s3_key); } catch (e) { logger.warn({ err: e.message, att: attUuid }, 'referral attachment S3 delete skipped'); } }
  return res.affectedRows > 0;
}

/** Internal — raw attachment rows (with s3_key) for building the fax package. */
async function attachmentRowsForReferral(referralId) {
  const [rows] = await execute('SELECT uuid, file_name_enc, s3_key, content_type FROM referral_attachments WHERE referral_id = :id ORDER BY id', { id: referralId });
  return rows;
}
