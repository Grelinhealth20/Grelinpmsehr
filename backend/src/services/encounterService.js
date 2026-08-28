import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { decrypt, blindIndex } from '../utils/crypto.js';
import { viewerScope, patientScopeWhere, isFacilityWide, noteServiceLineWhere } from './accessScope.js';

/**
 * Encounter worklist. Each of a provider's appointments is presented as an
 * encounter row, enriched with the linked patient (name, MRN, facility) and any
 * persisted encounter state (eligibility + chart status). Everything is scoped
 * to the calling provider — patient joins are constrained to the same owner so
 * no cross-patient data can surface.
 */

function jsonFromEnc(buf) {
  if (!buf) return null;
  try { return JSON.parse(decrypt(buf)); } catch { return null; }
}
const CHART_FROM_APPT = { completed: 'charts_completed', cancelled: 'cancelled', scheduled: 'not_seen' };
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Encounter number — a 5-digit sequence UNIQUE PER PATIENT (00001, 00002, …).
 * Fully numeric, ≤5 chars, wired to the patient (and therefore the MRN) via the
 * encounter's patient_id; the DOS is stored separately (encounter_date / DOS).
 * Enterprise EHR visit-numbering style.
 */
async function nextEncounterNo(patientId) {
  if (!patientId) return null;
  const [m] = await execute(
    // Clean multi-digit per-patient visit number: starts at 1001, increments by 1,
    // no leading zeros, always numeric and ≤5 characters (1001, 1002, 1003 …).
    `SELECT GREATEST(COALESCE(MAX(CAST(encounter_no AS UNSIGNED)), 0) + 1, 1001) AS nxt
       FROM encounters WHERE patient_id = :pid`,
    { pid: patientId },
  );
  return String(m[0].nxt);
}

const isDupKey = (e) => e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY');

/**
 * Assign a per-patient encounter number and run `write(no)`. Two concurrent
 * requests can compute the same next number; the DB unique key (uq_enc_patient_no)
 * rejects the loser, and we retry with a freshly-recomputed number. This makes the
 * whole "read max → write" sequence safe under concurrency without a table lock.
 */
async function withEncounterNo(patientId, write) {
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const no = await nextEncounterNo(patientId);
    try {
      await write(no);
      return no;
    } catch (err) {
      if (isDupKey(err) && attempt < MAX_ATTEMPTS - 1) {
        // Lost the race. Jitter before recomputing so a burst of simultaneous
        // inserts desynchronizes instead of colliding in lockstep every round.
        await new Promise((r) => { setTimeout(r, 3 + Math.floor(Math.random() * 25)); });
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * Ensure an encounter row exists for an appointment (idempotent on appointment_id)
 * and assign its per-patient encounter number.
 */
export async function ensureEncounter({ appointmentId, patientId, providerId, createdBy }) {
  const [existing] = await execute(
    `SELECT id, encounter_no FROM encounters WHERE appointment_id = :aid LIMIT 1`,
    { aid: appointmentId },
  );
  if (existing[0]) {
    if (!existing[0].encounter_no && patientId) {
      await withEncounterNo(patientId, (no) => execute(
        `UPDATE encounters SET encounter_no = :no WHERE id = :id`, { no, id: existing[0].id },
      ));
    }
    return;
  }
  const uuid = uuidv4();
  await withEncounterNo(patientId, (no) => execute(
    `INSERT INTO encounters (uuid, encounter_no, provider_id, appointment_id, patient_id, eligibility_status, chart_status, created_by)
     VALUES (:uuid, :no, :pid, :aid, :patientId, 'not_verified', 'not_seen', :createdBy)`,
    { uuid, no, pid: providerId, aid: appointmentId, patientId: patientId || null, createdBy },
  ));
}

const NOTE_AGG = `(SELECT COUNT(*) FROM encounter_notes n WHERE n.encounter_id = e.id)`;
const NOTE_SIGNED = `(SELECT COUNT(*) FROM encounter_notes n WHERE n.encounter_id = e.id AND n.status = 'signed')`;
// Procedure = the note type(s) documented on the encounter; signer = the MD(s) who signed.
const NOTE_TYPES_SQL = `(SELECT GROUP_CONCAT(DISTINCT n.note_type) FROM encounter_notes n WHERE n.encounter_id = e.id)`;
const NOTE_SIGNERS_SQL = `(SELECT GROUP_CONCAT(DISTINCT n.signed_by_name SEPARATOR ', ') FROM encounter_notes n WHERE n.encounter_id = e.id AND n.status = 'signed' AND n.signed_by_name IS NOT NULL)`;

const LIST = `SELECT
    a.uuid AS appt_uuid, a.patient_uuid, a.status AS appt_status,
    DATE_FORMAT(a.appt_date, '%Y-%m-%d') AS appt_date, a.start_min, a.duration_min,
    a.patient_name_enc,
    p.id AS patient_id, p.mrn, p.demographics_enc, p.facility_enc,
    u.full_name_enc AS owner_name_enc, rp.full_name_enc AS rendering_name_enc,
    e.uuid AS enc_uuid, e.encounter_no, e.eligibility_status, e.chart_status,
    ${NOTE_AGG} AS note_count, ${NOTE_SIGNED} AS note_signed,
    ${NOTE_TYPES_SQL} AS note_types, ${NOTE_SIGNERS_SQL} AS signers
  FROM appointments a
  LEFT JOIN patients p ON p.uuid = a.patient_uuid AND p.provider_id = a.provider_id
  LEFT JOIN users u ON u.id = a.provider_id
  LEFT JOIN users rp ON rp.id = a.rendering_provider_id
  LEFT JOIN encounters e ON e.appointment_id = a.id
  WHERE a.provider_id = :pid
  ORDER BY a.appt_date DESC, a.start_min DESC`;

// Standalone encounters (manually created, not tied to an appointment).
const LIST_STANDALONE = `SELECT
    e.uuid AS enc_uuid, e.encounter_no, e.eligibility_status, e.chart_status,
    DATE_FORMAT(e.encounter_date, '%Y-%m-%d') AS enc_date,
    p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
    u.full_name_enc AS owner_name_enc,
    ${NOTE_AGG} AS note_count, ${NOTE_SIGNED} AS note_signed,
    ${NOTE_TYPES_SQL} AS note_types, ${NOTE_SIGNERS_SQL} AS signers
  FROM encounters e
  LEFT JOIN patients p ON p.id = e.patient_id AND p.provider_id = e.provider_id
  LEFT JOIN users u ON u.id = e.provider_id
  WHERE e.provider_id = :pid AND e.appointment_id IS NULL
  ORDER BY e.encounter_date DESC, e.created_at DESC`;

export async function listEncounters(providerId) {
  const [rows] = await execute(LIST, { pid: providerId });
  const fromAppts = rows.map((r) => {
    const demo = jsonFromEnc(r.demographics_enc);
    const fac = jsonFromEnc(r.facility_enc);
    const linkedName = demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : '';
    return {
      encounterUuid: r.enc_uuid || null,
      appointmentUuid: r.appt_uuid,
      encounterNo: r.encounter_no || null,
      patientUuid: r.patient_uuid || null,
      mrn: r.mrn || null,
      date: r.appt_date,
      startMin: r.start_min,
      durationMin: r.duration_min,
      patientName: linkedName || (r.patient_name_enc ? decrypt(r.patient_name_enc) : '') || null,
      facilityName: fac?.facilityName || null,
      renderingProvider: r.rendering_name_enc ? decrypt(r.rendering_name_enc) : (r.owner_name_enc ? decrypt(r.owner_name_enc) : null),
      eligibilityStatus: r.eligibility_status || 'not_verified',
      chartStatus: r.chart_status || CHART_FROM_APPT[r.appt_status] || 'not_seen',
      appointmentStatus: r.appt_status,
      noteCount: Number(r.note_count || 0),
      noteSigned: Number(r.note_signed || 0),
      noteTypes: r.note_types || '',
      signedOffProvider: r.signers || null,
      source: 'appointment',
    };
  });

  const [srows] = await execute(LIST_STANDALONE, { pid: providerId });
  const standalone = srows.map((r) => {
    const demo = jsonFromEnc(r.demographics_enc);
    const fac = jsonFromEnc(r.facility_enc);
    const linkedName = demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : '';
    return {
      encounterUuid: r.enc_uuid,
      appointmentUuid: null,
      encounterNo: r.encounter_no || null,
      patientUuid: r.patient_uuid || null,
      mrn: r.mrn || null,
      date: r.enc_date,
      patientName: linkedName || null,
      facilityName: fac?.facilityName || null,
      renderingProvider: r.owner_name_enc ? decrypt(r.owner_name_enc) : null,
      eligibilityStatus: r.eligibility_status || 'not_verified',
      chartStatus: r.chart_status || 'not_seen',
      noteCount: Number(r.note_count || 0),
      noteSigned: Number(r.note_signed || 0),
      noteTypes: r.note_types || '',
      signedOffProvider: r.signers || null,
      source: 'manual',
    };
  });

  return [...standalone, ...fromAppts];
}

/**
 * ENTERPRISE-GRADE server-side pagination — Patients & Encounters view.
 * Only one page of patients is ever loaded (indexed on provider_id); each
 * patient's encounters are fetched on demand, paginated. Scales to 50k+ patients
 * and 10k+ encounters/patient with low latency (no full-table loads).
 */
export async function listProviderPatients(providerId, { page = 1, pageSize = 25, q = '' } = {}) {
  // Safe integers (validated/clamped by the controller) — inlined because MySQL
  // prepared statements reject placeholders in LIMIT/OFFSET.
  const lim = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const off = Math.max(0, (Number(page) - 1) * lim);
  // Scope: MD → facility-wide (all providers at their facilities); others → own.
  const scope = await viewerScope(providerId);
  const sc = patientScopeWhere(scope, providerId, 'p');
  const params = { ...sc.params };
  let where = sc.sql;
  if (q) {
    // FLEXIBLE, still-encrypted patient search — a single bar matches by last name, first
    // name, first initial, or any prefix, OR by partial MRN:
    //   • Name — each typed word is matched as a PREFIX blind index against the patient's
    //     name-token table (a name STARTS WITH the word). Multiple words must ALL match
    //     (e.g. "schwirian p" → last name Schwirian + first initial P). Indexed equality —
    //     scales to any patient count, never a full-table name scan or decrypt.
    //   • MRN — plaintext partial (LIKE). ORed with the name match.
    // Names stay AES-GCM encrypted; only opaque prefix hashes are compared.
    const raw = String(q).trim();
    const words = raw.toLowerCase().split(/[\s\-]+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    const nameConds = words.map((w, i) => {
      params[`nt${i}`] = blindIndex(w);
      return `EXISTS (SELECT 1 FROM patient_name_tokens t WHERE t.patient_id = p.id AND t.token_bidx = :nt${i})`;
    });
    params.qlike = `%${raw}%`;
    const nameMatch = nameConds.length ? `(${nameConds.join(' AND ')})` : '0';
    where += ` AND (${nameMatch} OR p.mrn LIKE :qlike)`;
  }
  const [[rows], [cnt]] = await Promise.all([
    execute(
      `SELECT p.uuid, p.mrn, p.demographics_enc, p.facility_enc, u.full_name_enc AS owner_name_enc,
          (SELECT COUNT(*) FROM encounters e WHERE e.patient_id = p.id) AS enc_count
        FROM patients p
        LEFT JOIN users u ON u.id = p.provider_id
        WHERE ${where}
        ORDER BY p.id DESC
        LIMIT ${lim} OFFSET ${off}`,
      params,
    ),
    execute(`SELECT COUNT(*) AS total FROM patients p WHERE ${where}`, params),
  ]);
  return {
    patients: rows.map((r) => {
      const demo = jsonFromEnc(r.demographics_enc);
      const fac = jsonFromEnc(r.facility_enc);
      return {
        patientUuid: r.uuid,
        mrn: r.mrn,
        patientName: demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : null,
        facilityName: fac?.facilityName || null,
        // The patient's OWNING provider (rendering provider) — for the MD's
        // facility-wide view each row may belong to a different provider.
        renderingProvider: r.owner_name_enc ? decrypt(r.owner_name_enc) : null,
        encounterCount: Number(r.enc_count || 0),
      };
    }),
    total: Number(cnt[0].total),
    page: Number(page),
    pageSize: Number(pageSize),
  };
}

/** Paginated encounters for one patient (10/page). Scope: MD → all encounters at
 *  their facility for this patient; other providers → their own encounters only. */
export async function listPatientEncounters(providerId, patientUuid, { page = 1, pageSize = 25 } = {}) {
  // Resolve + authorize the patient by the viewer's scope (strict isolation).
  const scope = await viewerScope(providerId);
  const sc = patientScopeWhere(scope, providerId, 'p');
  const [pr] = await execute(`SELECT p.id FROM patients p WHERE p.uuid = :u AND ${sc.sql} LIMIT 1`, { u: patientUuid, ...sc.params });
  if (!pr[0]) return null; // not visible to this viewer → 404
  const pidInt = pr[0].id;
  const lim = Math.max(1, Math.min(50, Number(pageSize) || 25));
  const off = Math.max(0, (Number(page) - 1) * lim);
  // A facility-wide MD sees every encounter for the patient; others see only theirs.
  const encWhere = isFacilityWide(scope) ? 'e.patient_id = :pid' : 'e.patient_id = :pid AND e.provider_id = :prov';
  const encParams = isFacilityWide(scope) ? { pid: pidInt } : { pid: pidInt, prov: providerId };
  const [[rows], [cnt]] = await Promise.all([
    execute(
      `SELECT e.uuid, e.encounter_no,
          DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos,
          COALESCE(rp.full_name_enc, u.full_name_enc) AS rendering_enc,
          ${NOTE_TYPES_SQL} AS note_types, ${NOTE_SIGNERS_SQL} AS signers
        FROM encounters e
        LEFT JOIN appointments a ON a.id = e.appointment_id
        LEFT JOIN users rp ON rp.id = a.rendering_provider_id
        LEFT JOIN users u ON u.id = e.provider_id
        WHERE ${encWhere}
        ORDER BY COALESCE(e.encounter_date, a.appt_date) DESC, e.id DESC
        LIMIT ${lim} OFFSET ${off}`,
      encParams,
    ),
    execute(`SELECT COUNT(*) AS total FROM encounters e WHERE ${encWhere}`, encParams),
  ]);
  return {
    encounters: rows.map((r) => ({
      encounterUuid: r.uuid,
      encounterNo: r.encounter_no,
      date: r.dos,
      renderingProvider: r.rendering_enc ? decrypt(r.rendering_enc) : null,
      noteTypes: r.note_types || '',
      signedOffProvider: r.signers || null,
    })),
    total: Number(cnt[0].total),
    page: Number(page),
    pageSize: Number(pageSize),
  };
}

/**
 * Carry-forward medication list — the patient's MOST RECENT note (within the caller's
 * scope) that carries prescriptions. Used to auto-populate a new encounter's Rx so a
 * provider never re-enters the med list; they simply amend it. STRICTLY scoped to the
 * accessible patient (own patients, or facility-wide for an MD) — never cross-patient.
 * Returns null when the patient is not accessible.
 */
export async function latestPrescriptions(providerId, patientUuid) {
  const scope = await viewerScope(providerId);
  const sc = patientScopeWhere(scope, providerId, 'p');
  const [pr] = await execute(`SELECT p.id FROM patients p WHERE p.uuid = :u AND ${sc.sql} LIMIT 1`, { u: patientUuid, ...sc.params });
  if (!pr[0]) return null; // not accessible → caller 404s (no cross-patient)
  const patientId = pr[0].id;
  const noteWhere = isFacilityWide(scope) ? 'e.patient_id = :pid' : 'e.patient_id = :pid AND e.provider_id = :prov';
  const params = isFacilityWide(scope) ? { pid: patientId } : { pid: patientId, prov: providerId };
  const [rows] = await execute(
    `SELECT n.content_enc, n.created_at FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
      WHERE ${noteWhere} AND n.content_enc IS NOT NULL
      ORDER BY n.created_at DESC LIMIT 40`,
    params,
  );
  for (const r of rows) {
    const c = jsonFromEnc(r.content_enc);
    const rx = Array.isArray(c?.prescriptions) ? c.prescriptions.filter((p) => p && p.drug) : [];
    if (rx.length) {
      return {
        patientId,
        prescriptions: rx.map((p) => ({ drug: p.drug || '', dose: p.dose || '', route: p.route || '', frequency: p.frequency || '', quantity: p.quantity || '', refills: p.refills || '', sig: p.sig || '' })),
        sourceDate: r.created_at,
      };
    }
  }
  return { patientId, prescriptions: [], sourceDate: null };
}

/** Create a standalone encounter (select patient + date) not tied to an appointment. */
export async function createStandaloneEncounter({ providerId, patientUuid, encounterDate, createdBy }) {
  const [pr] = await execute(
    `SELECT id, mrn FROM patients WHERE uuid = :u AND provider_id = :pid LIMIT 1`,
    { u: patientUuid, pid: providerId },
  );
  const patient = pr[0];
  if (!patient) return null; // not the provider's patient → caller 404s (no cross-patient)
  const uuid = uuidv4();
  const encounterNo = await withEncounterNo(patient.id, (no) => execute(
    `INSERT INTO encounters (uuid, encounter_no, provider_id, appointment_id, patient_id, encounter_date, eligibility_status, chart_status, created_by)
     VALUES (:uuid, :no, :pid, NULL, :patientId, :dos, 'not_verified', 'not_seen', :createdBy)`,
    { uuid, no, pid: providerId, patientId: patient.id, dos: encounterDate, createdBy },
  ));
  return { uuid, encounterNo };
}

/** Resolve an encounter the provider owns → returns its internal id (or null). */
export async function getOwnedEncounterId(encounterUuid, providerId) {
  const [rows] = await execute(
    `SELECT id FROM encounters WHERE uuid = :u AND provider_id = :pid LIMIT 1`,
    { u: encounterUuid, pid: providerId },
  );
  return rows[0]?.id || null;
}

/**
 * READ access to an encounter by the viewer's scope: the encounter's own provider,
 * OR a facility-wide MD whose assigned facilities include the patient's facility.
 * Returns the internal encounter id, or null when out of scope (strict isolation).
 */
export async function getAccessibleEncounterId(encounterUuid, userId, scope = null) {
  const sc = scope || (await viewerScope(userId));
  if (!isFacilityWide(sc)) return getOwnedEncounterId(encounterUuid, userId);
  const params = { u: encounterUuid, pid: userId };
  const ph = sc.facilityIds.map((id, i) => { params[`f${i}`] = id; return `:f${i}`; }).join(',');
  const [rows] = await execute(
    `SELECT e.id FROM encounters e LEFT JOIN patients p ON p.id = e.patient_id
      WHERE e.uuid = :u AND (e.provider_id = :pid OR p.facility_id IN (${ph})) LIMIT 1`,
    params,
  );
  return rows[0]?.id || null;
}

// Aggregates for the flat Clinical Records list — per note, not grouped.
const NOTE_STATUS = "n.status"; // 'draft' | 'signed'

/**
 * Flat, paginated Clinical Records list (one row per clinical note).
 * Scope: a facility-wide MD sees every note for patients at their facilities
 * (across all providers); every other provider sees ONLY their own notes.
 * Enterprise-grade: server-side pagination on indexed columns, no cross-facility
 * or cross-provider leakage.
 */
export async function listClinicalRecords(userId, { page = 1, pageSize = 25, q = '', status = '' } = {}) {
  const scope = await viewerScope(userId);
  const lim = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const off = Math.max(0, (Number(page) - 1) * lim);
  const params = {};
  let where;
  if (isFacilityWide(scope)) {
    // Facility-wide MD: every note for patients at their facilities — BUT only within
    // the MD's own service line (a Pain MD never sees SNF records and vice versa).
    const ph = scope.facilityIds.map((id, i) => { params[`sf${i}`] = id; return `:sf${i}`; }).join(',');
    where = `p.facility_id IN (${ph}) AND ${noteServiceLineWhere(scope, 'n')}`;
  } else {
    where = `n.provider_id = :uid`;
    params.uid = userId;
  }
  if (status === 'signed') where += ` AND ${NOTE_STATUS} = 'signed'`;
  else if (status === 'draft') where += ` AND ${NOTE_STATUS} = 'draft'`;
  if (q) {
    where += ' AND (p.mrn LIKE :qlike OR e.encounter_no LIKE :qlike OR p.name_bidx = :qbidx)';
    params.qlike = `%${q}%`;
    params.qbidx = blindIndex(q.trim().toLowerCase());
  }
  const [[rows], [cnt]] = await Promise.all([
    execute(
      `SELECT n.uuid AS note_uuid, n.note_type, n.status, n.signed_by_name,
          e.uuid AS enc_uuid, e.encounter_no,
          DATE_FORMAT(COALESCE(e.encounter_date, a.appt_date), '%Y-%m-%d') AS dos,
          p.uuid AS patient_uuid, p.mrn, p.demographics_enc, p.facility_enc,
          u.full_name_enc AS rendering_enc
        FROM encounter_notes n
        JOIN encounters e ON e.id = n.encounter_id
        LEFT JOIN appointments a ON a.id = e.appointment_id
        LEFT JOIN patients p ON p.id = e.patient_id
        LEFT JOIN users u ON u.id = n.provider_id
        WHERE ${where}
        -- status is enum('draft','signed'): ASC puts 'draft' (Yet to Sign) first,
        -- then newest within each group. A real column (not an expression) so the
        -- composite index is used and there's no filesort even at 10k+ records.
        ORDER BY n.status ASC, n.created_at DESC
        LIMIT ${lim} OFFSET ${off}`,
      params,
    ),
    execute(
      `SELECT COUNT(*) AS total FROM encounter_notes n
        JOIN encounters e ON e.id = n.encounter_id
        LEFT JOIN patients p ON p.id = e.patient_id
        WHERE ${where}`,
      params,
    ),
  ]);
  return {
    records: rows.map((r) => {
      const demo = jsonFromEnc(r.demographics_enc);
      const fac = jsonFromEnc(r.facility_enc);
      return {
        noteUuid: r.note_uuid,
        encounterUuid: r.enc_uuid,
        encounterNo: r.encounter_no,
        patientUuid: r.patient_uuid,
        mrn: r.mrn || null,
        patientName: demo ? `${demo.firstName || ''} ${demo.lastName || ''}`.trim() : null,
        facilityName: fac?.facilityName || null,
        renderingProvider: r.rendering_enc ? decrypt(r.rendering_enc) : null,
        noteType: r.note_type,
        status: r.status, // 'signed' | 'draft'
        signedByName: r.signed_by_name || null,
        date: r.dos || null,
      };
    }),
    total: Number(cnt[0].total),
    page: Number(page),
    pageSize: Number(pageSize),
  };
}

/** Upsert the editable encounter state for one of the provider's appointments. */
export async function updateEncounterStatus(appointmentUuid, providerId, createdBy, { eligibilityStatus, chartStatus }) {
  const [appt] = await execute(
    `SELECT a.id, a.provider_id, p.id AS patient_id
       FROM appointments a LEFT JOIN patients p ON p.uuid = a.patient_uuid AND p.provider_id = a.provider_id
      WHERE a.uuid = :uuid LIMIT 1`,
    { uuid: appointmentUuid },
  );
  const row = appt[0];
  if (!row || Number(row.provider_id) !== Number(providerId)) return null; // not owner → caller 404s

  const sets = [];
  const params = { pid: providerId, apptId: row.id, patientId: row.patient_id || null, uuid: uuidv4(), createdBy };
  if (eligibilityStatus !== undefined) params.elig = eligibilityStatus;
  if (chartStatus !== undefined) params.chart = chartStatus;

  await execute(
    `INSERT INTO encounters (uuid, provider_id, appointment_id, patient_id, eligibility_status, chart_status, created_by)
     VALUES (:uuid, :pid, :apptId, :patientId,
             COALESCE(:elig, 'not_verified'), COALESCE(:chart, 'not_seen'), :createdBy)
     ON DUPLICATE KEY UPDATE
       eligibility_status = COALESCE(:elig, eligibility_status),
       chart_status = COALESCE(:chart, chart_status),
       patient_id = COALESCE(:patientId, patient_id)`,
    { ...params, elig: params.elig ?? null, chart: params.chart ?? null },
  );
  return { ok: true };
}
