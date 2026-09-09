import { v4 as uuidv4 } from 'uuid';
import { execute, withTransaction } from '../db/pool.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { logger } from '../config/logger.js';
import { normalizeState, extractStateFromText } from './payerDirectoryService.js';
import { s3Enabled, uploadFacilityLogo, getObjectBytes, deleteObject, facilityPrefix, deleteByPrefix } from './s3Service.js';
import { recordAudit, backfillAuditChain } from './auditService.js';

// Decode a data:image/...;base64 URI → { buffer, contentType, ext } (null if not one).
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
function parseLogoDataUri(uri) {
  const m = String(uri || '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  return { buffer: Buffer.from(m[2], 'base64'), contentType, ext: EXT[contentType] || 'png' };
}

// Content type from a stored logo S3 key's extension.
const LOGO_CT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
function logoContentType(key) { return LOGO_CT[String(key || '').split('.').pop().toLowerCase()] || 'image/png'; }

/**
 * Replace facility.logo (an S3 object key) with an INLINE data URI so the browser
 * can render it directly. This avoids exposing the S3 host (the app CSP allows
 * `data:` but not the bucket origin) and has no signed-URL expiry. Best-effort:
 * any failure leaves the logo null. `rawKey` is the stored S3 key from the row.
 */
async function inlineLogo(facility, rawKey) {
  facility.logo = null;
  if (rawKey && s3Enabled()) {
    try {
      const bytes = await getObjectBytes(rawKey);
      if (bytes && bytes.length) facility.logo = `data:${logoContentType(rawKey)};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch { facility.logo = null; }
  }
  return facility;
}

/**
 * Facility records + provider⇄facility assignments.
 *
 * Facility data is PUBLIC (CMS NPPES registry) and stored in plaintext. A
 * Super/Master admin verifies NPPES-fetched details before saving. Assignments
 * govern which facilities a provider may work at — patient/encounter access is
 * scoped through them to strictly prevent cross-facility data sharing.
 */

const FAC_COLS = `f.uuid, f.npi, f.name, f.address, f.city, f.state, f.zip, f.phone, f.fax,
  f.taxonomy, f.taxonomy_code, f.tax_id, f.authorized_official, f.enumeration_date, f.mailing_address,
  f.nppes_status, f.logo, f.status, f.coding_enabled, f.eligibility_enabled, f.fax_auto_create_patients, f.source,
  DATE_FORMAT(f.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at`;
const boolFlag = (v) => v == null ? true : !!Number(v); // per-facility flags default ON

// Map a row to the public DTO. `logo` is intentionally NOT the raw S3 key — callers
// that display it set it to an inline data URI (inlineLogo) or a hasLogo flag.
function toFacility(r) {
  return {
    uuid: r.uuid, npi: r.npi || null, name: r.name,
    address: r.address || null, city: r.city || null, state: r.state || null,
    zip: r.zip || null, phone: r.phone || null, fax: r.fax || null,
    taxonomy: r.taxonomy || null, taxonomyCode: r.taxonomy_code || null,
    taxId: r.tax_id || null,
    // Full NPPES (NPI-2) registry details — captured so nothing is dropped.
    authorizedOfficial: r.authorized_official || null,
    enumerationDate: r.enumeration_date || null,
    mailingAddress: r.mailing_address || null,
    nppesStatus: r.nppes_status || null,
    logo: null, hasLogo: !!r.logo,
    status: r.status, source: r.source,
    codingEnabled: boolFlag(r.coding_enabled),
    eligibilityEnabled: boolFlag(r.eligibility_enabled),
    autoCreatePatients: boolFlag(r.fax_auto_create_patients), // auto-create a patient from an inbound fax (per-facility)
    providerCount: r.provider_count != null ? Number(r.provider_count) : undefined,
    createdAt: r.created_at,
  };
}

export async function listFacilities({ q = '', status = null } = {}) {
  const where = [];
  const params = {};
  if (q) { where.push('(f.name LIKE :q OR f.npi LIKE :q OR f.city LIKE :q)'); params.q = `%${q}%`; }
  if (status) { where.push('f.status = :status'); params.status = status; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await execute(
    `SELECT ${FAC_COLS},
        (SELECT COUNT(*) FROM provider_facilities pf WHERE pf.facility_id = f.id) AS provider_count
      FROM facilities f ${clause} ORDER BY f.name ASC`,
    params,
  );
  // The list does not render logos — return the lightweight DTO (hasLogo flag only)
  // so a large facility list never triggers one S3 fetch per row.
  return rows.map(toFacility);
}

async function facilityRowByUuid(uuid) {
  const [rows] = await execute(`SELECT f.id, ${FAC_COLS} FROM facilities f WHERE f.uuid = :uuid LIMIT 1`, { uuid });
  return rows[0] || null;
}

/** Facility detail + the providers assigned to it. */
export async function getFacility(uuid) {
  const row = await facilityRowByUuid(uuid);
  if (!row) return null;
  const [prov] = await execute(
    `SELECT u.uuid, u.full_name_enc, u.credentials, u.role,
        DATE_FORMAT(pf.created_at, '%Y-%m-%dT%H:%i:%sZ') AS assigned_at
      FROM provider_facilities pf JOIN users u ON u.id = pf.provider_id
      WHERE pf.facility_id = :fid ORDER BY pf.created_at DESC`,
    { fid: row.id },
  );
  const providers = prov.map((p) => ({
    uuid: p.uuid,
    fullName: p.full_name_enc ? decrypt(p.full_name_enc) : '',
    role: p.role,
    credentials: (() => { try { return Array.isArray(p.credentials) ? p.credentials : JSON.parse(p.credentials || '[]'); } catch { return []; } })(),
    assignedAt: p.assigned_at,
  }));
  // Single-facility view (the admin modal) renders the logo — inline it as a data URI.
  return { ...(await inlineLogo(toFacility(row), row.logo)), providers };
}

/** Insert a verified facility. Dedupe by NPI (returns existing if already saved). */
export async function createFacility(data, { adminId } = {}) {
  if (data.npi) {
    const [dupe] = await execute(`SELECT ${FAC_COLS} FROM facilities f WHERE f.npi = :npi LIMIT 1`, { npi: data.npi });
    if (dupe[0]) return { facility: toFacility(dupe[0]), duplicate: true };
  }
  const uuid = uuidv4();
  // Logo (if provided as a data URI) is stored in the facility's S3 folder; the DB
  // keeps only the object key.
  let logoKey = null;
  const parsed = parseLogoDataUri(data.logo);
  if (parsed && s3Enabled()) {
    try { logoKey = await uploadFacilityLogo({ facilityUuid: uuid, facilityName: data.name }, parsed.buffer, parsed.contentType, parsed.ext); } catch { logoKey = null; }
  }
  await execute(
    `INSERT INTO facilities (uuid, npi, name, address, city, state, zip, phone, fax, taxonomy, taxonomy_code,
        tax_id, authorized_official, enumeration_date, mailing_address, nppes_status, logo, status, source, verified_by, created_by)
     VALUES (:uuid, :npi, :name, :address, :city, :state, :zip, :phone, :fax, :taxonomy, :taxonomyCode,
        :taxId, :authorizedOfficial, :enumerationDate, :mailingAddress, :nppesStatus, :logo, 'active', :source, :adminId, :adminId)`,
    {
      uuid, npi: data.npi || null, name: data.name, address: data.address || null,
      city: data.city || null, state: data.state || null, zip: data.zip || null,
      phone: data.phone || null, fax: data.fax || null,
      taxonomy: data.taxonomy || null, taxonomyCode: data.taxonomyCode || null, taxId: data.taxId || null,
      authorizedOfficial: data.authorizedOfficial || null, enumerationDate: data.enumerationDate || null,
      mailingAddress: data.mailingAddress || null, nppesStatus: data.nppesStatus || data.status || null,
      logo: logoKey, source: data.source || 'nppes', adminId: adminId || null,
    },
  );
  return { facility: await getFacility(uuid), duplicate: false };
}

export async function updateFacility(uuid, data) {
  const row = await facilityRowByUuid(uuid);
  if (!row) return null;
  const sets = [];
  const params = { uuid };
  for (const k of ['npi', 'name', 'address', 'city', 'state', 'zip', 'phone', 'fax', 'taxonomy']) {
    if (data[k] !== undefined) { sets.push(`${k} = :${k}`); params[k] = data[k] || null; }
  }
  // Tax ID (EIN): the DTO key `taxId` maps to the `tax_id` column.
  if (data.taxId !== undefined) { sets.push('tax_id = :taxId'); params.taxId = data.taxId || null; }
  // Full NPPES (NPI-2) details — DTO camelCase → snake_case columns.
  if (data.taxonomyCode !== undefined) { sets.push('taxonomy_code = :taxonomyCode'); params.taxonomyCode = data.taxonomyCode || null; }
  if (data.authorizedOfficial !== undefined) { sets.push('authorized_official = :authorizedOfficial'); params.authorizedOfficial = data.authorizedOfficial || null; }
  if (data.enumerationDate !== undefined) { sets.push('enumeration_date = :enumerationDate'); params.enumerationDate = data.enumerationDate || null; }
  if (data.mailingAddress !== undefined) { sets.push('mailing_address = :mailingAddress'); params.mailingAddress = data.mailingAddress || null; }
  if (data.nppesStatus !== undefined) { sets.push('nppes_status = :nppesStatus'); params.nppesStatus = data.nppesStatus || null; }
  // Logo: a new data URI uploads to the facility's S3 folder (replacing the old
  // object); an empty string clears it. `row.logo` holds the current S3 key.
  if (data.logo !== undefined) {
    const parsed = parseLogoDataUri(data.logo);
    if (parsed && s3Enabled()) {
      let key = null;
      try { key = await uploadFacilityLogo({ facilityUuid: uuid, facilityName: data.name || row.name }, parsed.buffer, parsed.contentType, parsed.ext); } catch { key = null; }
      if (key) { sets.push('logo = :logo'); params.logo = key; }
      if (key && row.logo && row.logo !== key) { try { await deleteObject(row.logo); } catch { /* best-effort */ } }
    } else if (!data.logo) { // cleared
      sets.push('logo = :logo'); params.logo = null;
      if (row.logo && s3Enabled()) { try { await deleteObject(row.logo); } catch { /* best-effort */ } }
    }
  }
  if (!sets.length) return getFacility(uuid);
  await execute(`UPDATE facilities SET ${sets.join(', ')} WHERE uuid = :uuid`, params);
  return getFacility(uuid);
}

export async function setFacilityStatus(uuid, status) {
  const [res] = await execute(`UPDATE facilities SET status = :status WHERE uuid = :uuid`, { uuid, status });
  return res.affectedRows > 0 ? getFacility(uuid) : null;
}

/**
 * SUPER-ADMIN: set the per-facility feature switches. Only the flags present in `flags` are changed.
 * These govern whether the coding engine (claims scrubbing) and real-time eligibility are available
 * for patients at this facility. Enforced server-side; the EHR also hides the controls when off.
 */
export async function setFacilityFlags(uuid, flags = {}) {
  const sets = []; const params = { uuid };
  if (flags.codingEnabled !== undefined) { sets.push('coding_enabled = :ce'); params.ce = flags.codingEnabled ? 1 : 0; }
  if (flags.eligibilityEnabled !== undefined) { sets.push('eligibility_enabled = :ee'); params.ee = flags.eligibilityEnabled ? 1 : 0; }
  if (flags.autoCreatePatients !== undefined) { sets.push('fax_auto_create_patients = :ac'); params.ac = flags.autoCreatePatients ? 1 : 0; }
  if (!sets.length) return getFacility(uuid);
  const [res] = await execute(`UPDATE facilities SET ${sets.join(', ')} WHERE uuid = :uuid`, params);
  if (!res.affectedRows) return null;
  invalidateFacilityFlags();
  return getFacility(uuid);
}

// Short-TTL cache for per-patient facility flags (read on the coding/eligibility paths).
const FLAG_TTL_MS = 15_000;
const flagCache = new Map(); // key -> { flags, exp }
export function invalidateFacilityFlags() { flagCache.clear(); }

/** Feature flags for the facility a PATIENT belongs to (default ON when unlinked). */
export async function facilityFlagsForPatient(patientUuid) {
  const key = `p:${patientUuid}`; const now = Date.now();
  const hit = flagCache.get(key); if (hit && hit.exp > now) return hit.flags;
  const [rows] = await execute(
    `SELECT f.coding_enabled AS c, f.eligibility_enabled AS e
       FROM patients p LEFT JOIN facilities f ON f.id = p.facility_id WHERE p.uuid = :u LIMIT 1`, { u: patientUuid });
  const r = rows[0];
  const flags = { codingEnabled: boolFlag(r ? r.c : null), eligibilityEnabled: boolFlag(r ? r.e : null) };
  flagCache.set(key, { flags, exp: now + FLAG_TTL_MS });
  return flags;
}

/** Coding-engine flag for the facility behind a NOTE (via its encounter → patient). Default ON. */
export async function codingEnabledForNote(noteUuid) {
  const [rows] = await execute(
    `SELECT f.coding_enabled AS c FROM encounter_notes n
       JOIN encounters e ON e.id = n.encounter_id
       LEFT JOIN patients p ON p.id = e.patient_id
       LEFT JOIN facilities f ON f.id = p.facility_id WHERE n.uuid = :u LIMIT 1`, { u: noteUuid });
  return boolFlag(rows[0] ? rows[0].c : null);
}

export async function eligibilityEnabledForPatient(patientUuid) {
  return (await facilityFlagsForPatient(patientUuid)).eligibilityEnabled;
}

/** Eligibility flag for a provider's PRIMARY active facility (used on the appointment path, which
 *  is not patient-linked). Default ON when the provider has no active facility. */
export async function eligibilityEnabledForProvider(providerId) {
  const [rows] = await execute(
    `SELECT f.eligibility_enabled AS e FROM facilities f
       JOIN provider_facilities pf ON pf.facility_id = f.id
      WHERE pf.provider_id = :pid AND f.status = 'active' ORDER BY f.name ASC LIMIT 1`, { pid: providerId });
  return boolFlag(rows[0] ? rows[0].e : null);
}

export async function deleteFacility(uuid) {
  const [res] = await execute(`DELETE FROM facilities WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
}

/**
 * MASTER-ONLY facility wipe. Permanently and completely removes ALL data belonging to ONE facility —
 * its patients and every chart/encounter/note/code, appointments, referrals + attachments, eligibility,
 * documents (DB + S3), and the facility-scoped audit trail — then either retires the providers that
 * belonged solely to it or unlinks the ones shared with other facilities.
 *
 * HARD SCOPING — NO CROSS-FACILITY DELETION (the invariant this whole function is built around):
 *  - Clinical data is deleted strictly by `patients.facility_id = fid` (and `referrals.facility_id`).
 *    Patients with a different (or NULL) facility are never touched.
 *  - Provider ACCOUNTS are the danger: `patients/encounters/appointments.provider_id → users(id) ON
 *    DELETE CASCADE`, so deleting a shared provider would cascade-delete their OTHER facilities' data.
 *    We therefore handle providers AFTER this facility's clinical rows are gone, and delete a provider
 *    account ONLY when it then has ZERO remaining footprint anywhere (no other facility assignment and no
 *    remaining patients/encounters/appointments). Any provider with external data is merely UNLINKED.
 *  - The master/super admins are never deleted.
 *
 * Guarded: requires the caller to re-type the facility name (`confirmName`) — a mismatch refuses the wipe.
 * Atomic: all DB deletes run in one transaction; S3 (not transactional) is emptied after commit; the
 * audit hash-chain is re-sealed (backfill) afterward; and a single top-level `facility.master_wipe`
 * audit event (with counts) is written so the destructive action itself is always accountable.
 */
export async function masterWipeFacility(facilityUuid, { actorId, confirmName, deleteFacility: alsoDeleteFacility = false } = {}) {
  const [frows] = await execute('SELECT id, uuid, name FROM facilities WHERE uuid = :u LIMIT 1', { u: facilityUuid });
  const facility = frows[0];
  if (!facility) return { notFound: true };
  // Confirmation gate — the caller must echo the exact facility name (case-insensitive, trimmed).
  if (String(confirmName || '').trim().toLowerCase() !== String(facility.name || '').trim().toLowerCase()) {
    return { confirmMismatch: true, expected: facility.name };
  }
  const fid = facility.id;

  const summary = await withTransaction(async (exec) => {
    // 1. Collect the uuids of everything scoped to this facility BEFORE deleting (for audit cleanup).
    const [pRows] = await exec('SELECT id, uuid FROM patients WHERE facility_id = :fid', { fid });
    const patientIds = pRows.map((r) => r.id);
    const uuids = new Set(pRows.map((r) => r.uuid));
    if (patientIds.length) {
      const [encRows] = await exec('SELECT uuid FROM encounters WHERE patient_id IN (SELECT id FROM patients WHERE facility_id = :fid)', { fid });
      for (const r of encRows) uuids.add(r.uuid);
      const [noteRows] = await exec('SELECT n.uuid FROM encounter_notes n JOIN encounters e ON e.id = n.encounter_id WHERE e.patient_id IN (SELECT id FROM patients WHERE facility_id = :fid)', { fid });
      for (const r of noteRows) uuids.add(r.uuid);
      const [apptRows] = await exec('SELECT uuid FROM appointments WHERE patient_uuid IN (SELECT uuid FROM patients WHERE facility_id = :fid)', { fid });
      for (const r of apptRows) uuids.add(r.uuid);
    }
    const [refRows] = await exec('SELECT uuid FROM referrals WHERE facility_id = :fid', { fid });
    for (const r of refRows) uuids.add(r.uuid);

    // 2. Delete this facility's clinical data (children cascade via FKs). Scoped ONLY by facility_id.
    //    Order: encounters (→notes→note_codes) and appointments (patient_uuid) and referrals (→attachments)
    //    then patients (→documents/eligibility/name_tokens/emergency_access).
    const [encDel] = await exec('DELETE FROM encounters WHERE patient_id IN (SELECT id FROM patients WHERE facility_id = :fid)', { fid });
    const [apptDel] = await exec('DELETE FROM appointments WHERE patient_uuid IN (SELECT uuid FROM patients WHERE facility_id = :fid)', { fid });
    const [refDel] = await exec('DELETE FROM referrals WHERE facility_id = :fid', { fid });
    const [patDel] = await exec('DELETE FROM patients WHERE facility_id = :fid', { fid });

    // 3. Providers/billing assigned to this facility. Clinical rows are already gone, so a remaining
    //    footprint is necessarily EXTERNAL → delete the account only when nothing remains (safe), else unlink.
    const [assigned] = await exec('SELECT pf.provider_id AS pid, u.role AS role FROM provider_facilities pf JOIN users u ON u.id = pf.provider_id WHERE pf.facility_id = :fid', { fid });
    let providersDeleted = 0; let providersUnlinked = 0; const deletedProviderIds = [];
    for (const { pid, role } of assigned) {
      if (role !== 'provider' && role !== 'billing') { // never delete admins — unlink only
        await exec('DELETE FROM provider_facilities WHERE provider_id = :pid AND facility_id = :fid', { pid, fid });
        providersUnlinked += 1; continue;
      }
      const [[ext]] = await exec(
        `SELECT
           (SELECT COUNT(*) FROM provider_facilities WHERE provider_id = :pid AND facility_id <> :fid) AS otherFac,
           (SELECT COUNT(*) FROM patients      WHERE provider_id = :pid) AS pats,
           (SELECT COUNT(*) FROM encounters    WHERE provider_id = :pid) AS encs,
           (SELECT COUNT(*) FROM appointments  WHERE provider_id = :pid) AS appts`,
        { pid, fid },
      );
      const safeToDelete = Number(ext.otherFac) === 0 && Number(ext.pats) === 0 && Number(ext.encs) === 0 && Number(ext.appts) === 0;
      if (safeToDelete) {
        await exec('DELETE FROM users WHERE id = :pid AND role IN (\'provider\',\'billing\')', { pid });
        providersDeleted += 1; deletedProviderIds.push(pid);
      } else {
        await exec('DELETE FROM provider_facilities WHERE provider_id = :pid AND facility_id = :fid', { pid, fid });
        providersUnlinked += 1;
      }
    }

    // 4. Facility-scoped audit trail: rows whose entity belonged to this facility, plus rows whose actor
    //    was a provider we just deleted. Batched IN() to stay within param limits at scale.
    let auditDeleted = 0;
    const uuidList = [...uuids];
    for (let i = 0; i < uuidList.length; i += 500) {
      const batch = uuidList.slice(i, i + 500);
      const ph = batch.map((_, j) => `:e${j}`).join(',');
      const params = {}; batch.forEach((v, j) => { params[`e${j}`] = v; });
      const [d] = await exec(`DELETE FROM audit_logs WHERE entity_id IN (${ph})`, params);
      auditDeleted += d.affectedRows || 0;
    }
    for (let i = 0; i < deletedProviderIds.length; i += 500) {
      const batch = deletedProviderIds.slice(i, i + 500);
      const ph = batch.map((_, j) => `:a${j}`).join(',');
      const params = {}; batch.forEach((v, j) => { params[`a${j}`] = v; });
      const [d] = await exec(`DELETE FROM audit_logs WHERE actor_user_id IN (${ph})`, params);
      auditDeleted += d.affectedRows || 0;
    }

    // 5. Optionally remove the (now-empty) facility record itself.
    if (alsoDeleteFacility) await exec('DELETE FROM facilities WHERE id = :fid', { fid });

    return {
      facility: { uuid: facility.uuid, name: facility.name },
      patients: patDel.affectedRows || 0,
      encounters: encDel.affectedRows || 0,
      appointments: apptDel.affectedRows || 0,
      referrals: refDel.affectedRows || 0,
      auditLogs: auditDeleted,
      providersDeleted,
      providersUnlinked,
      facilityDeleted: !!alsoDeleteFacility,
    };
  });

  // 6. Empty the facility's S3 folder (all patient/encounter/referral/provider objects live under it).
  //    Non-transactional; a failure is surfaced but the DB wipe already committed.
  summary.s3ObjectsDeleted = 0;
  if (s3Enabled()) {
    try { summary.s3ObjectsDeleted = await deleteByPrefix(facilityPrefix({ facilityUuid: facility.uuid, facilityName: facility.name })); }
    catch (e) { logger.error({ err: e.message, facility: facility.uuid }, 'facility wipe: S3 prefix delete failed (DB already wiped)'); summary.s3Error = e.message; }
  }

  // 7. Re-seal the audit hash-chain (rows were removed) and record the destructive action itself.
  try { await backfillAuditChain(); } catch (e) { logger.error({ err: e.message }, 'facility wipe: audit chain re-seal failed — run backfillAuditChain manually'); summary.auditChainError = e.message; }
  await recordAudit({ actorUserId: actorId, action: 'facility.master_wipe', entityType: 'facility', entityId: facility.uuid, metadata: summary });

  logger.warn({ actorId, ...summary }, 'MASTER facility wipe completed');
  return { ok: true, ...summary };
}

/* --- Provider ⇄ Facility assignments -------------------------------------- */

async function idsFor(facilityUuid, providerUuid) {
  const [f] = await execute(`SELECT id FROM facilities WHERE uuid = :u LIMIT 1`, { u: facilityUuid });
  // Providers AND billing users may be assigned to a facility.
  const [p] = await execute(`SELECT id FROM users WHERE uuid = :u AND role IN ('provider','billing') LIMIT 1`, { u: providerUuid });
  return { facilityId: f[0]?.id || null, providerId: p[0]?.id || null };
}

export async function assignProvider(facilityUuid, providerUuid, adminId) {
  const { facilityId, providerId } = await idsFor(facilityUuid, providerUuid);
  if (!facilityId || !providerId) return { notFound: true };
  await execute(
    `INSERT IGNORE INTO provider_facilities (provider_id, facility_id, assigned_by) VALUES (:pid, :fid, :aid)`,
    { pid: providerId, fid: facilityId, aid: adminId || null },
  );
  invalidateFacilityIds(providerId); // assignment changed → refresh access scope now
  // Real-time auto-heal: link any of this provider's UNLINKED patients/referrals to their primary facility
  // so gaining facility-wide MD scope never hides their own previously-unlinked records.
  let healed = { patients: 0, referrals: 0 };
  try { healed = await healProviderNullFacilities(providerId); if (healed.patients || healed.referrals) logger.info({ providerId, ...healed }, 'assignProvider: auto-linked unlinked records to primary facility'); }
  catch (e) { logger.error({ err: e.message, providerId }, 'assignProvider: auto-heal failed (assignment still applied)'); }
  return { ok: true, healed };
}

export async function unassignProvider(facilityUuid, providerUuid) {
  const { facilityId, providerId } = await idsFor(facilityUuid, providerUuid);
  if (!facilityId || !providerId) return { notFound: true };
  await execute(`DELETE FROM provider_facilities WHERE provider_id = :pid AND facility_id = :fid`, { pid: providerId, fid: facilityId });
  invalidateFacilityIds(providerId); // assignment changed → refresh access scope now
  return { ok: true };
}

/** Facilities a provider is assigned to (for the EHR + facility-scoped access). */
export async function listProviderFacilities(providerId) {
  const [rows] = await execute(
    `SELECT ${FAC_COLS}, f.id AS fid FROM facilities f
      JOIN provider_facilities pf ON pf.facility_id = f.id
      WHERE pf.provider_id = :pid AND f.status = 'active'
      ORDER BY f.name ASC`,
    { pid: providerId },
  );
  return rows.map((r) => ({ ...toFacility(r), id: r.fid }));
}

/**
 * Short-TTL cache for a provider's assigned-facility id set. This is read on the hot
 * access-scope path (every notes list/get/sign, clinical records, patient list), and the
 * remote DB has ~260ms round-trip latency — caching removes that per-request cost. The set
 * changes only when an admin (un)assigns a provider, which invalidates the entry. A 20s TTL
 * bounds staleness even if an invalidation is ever missed (matches the auth-cache TTL).
 */
const FAC_IDS_TTL_MS = 20_000;
const facIdsCache = new Map(); // providerId -> { ids:number[], exp:number }
export function invalidateFacilityIds(providerId) {
  if (providerId != null) facIdsCache.delete(Number(providerId));
  else facIdsCache.clear();
}

/** Internal-id set of a provider's assigned facilities (isolation checks). */
export async function providerFacilityIds(providerId) {
  const key = Number(providerId);
  const now = Date.now();
  const hit = facIdsCache.get(key);
  if (hit && hit.exp > now) return hit.ids.slice();
  const [rows] = await execute(`SELECT facility_id FROM provider_facilities WHERE provider_id = :pid`, { pid: providerId });
  const ids = rows.map((r) => Number(r.facility_id));
  facIdsCache.set(key, { ids, exp: now + FAC_IDS_TTL_MS });
  if (facIdsCache.size > 50000) facIdsCache.delete(facIdsCache.keys().next().value); // headroom well beyond 5000 providers — no thrash at scale
  return ids.slice();
}

/**
 * The provider's PRIMARY assigned facility (first active) — used as the billing
 * provider identity (NPI + organization name) on eligibility requests. Returns
 * { npi, name } or null when the provider has no active facility assigned.
 */
export async function providerPrimaryFacility(providerId) {
  const [rows] = await execute(
    `SELECT f.npi, f.name, f.state, f.address, f.city, f.zip FROM facilities f
       JOIN provider_facilities pf ON pf.facility_id = f.id
      WHERE pf.provider_id = :pid AND f.status = 'active'
      ORDER BY f.name ASC LIMIT 1`,
    { pid: providerId },
  );
  const r = rows[0];
  if (!r) return null;
  // State drives the Medicare Part B MAC. Prefer the discrete state column; when it
  // is empty, derive it from the facility's ADDRESS (state can be fetched from the
  // assigned facility address of that provider).
  const state = normalizeState(r.state)
    || extractStateFromText([r.address, r.city, r.zip].filter(Boolean).join(' '))
    || null;
  return { npi: r.npi || null, name: r.name || null, state };
}

/**
 * The provider's PRIMARY assigned facility's INTERNAL id (first ACTIVE by name), or null. The single
 * source of truth used to auto-link a new patient / referral to a real facility (shared by patientService
 * and referralService) — deterministic (active-only, name-ordered), never an inactive or arbitrary pick.
 */
export async function providerPrimaryFacilityId(providerId) {
  const [rows] = await execute(
    `SELECT f.id FROM facilities f JOIN provider_facilities pf ON pf.facility_id = f.id
      WHERE pf.provider_id = :pid AND f.status = 'active' ORDER BY f.name ASC LIMIT 1`,
    { pid: providerId },
  );
  return rows[0]?.id ? Number(rows[0].id) : null;
}

/**
 * AUTO-HEAL every UNLINKED (facility_id IS NULL) patient and referral OWNED by this provider by linking
 * them to the provider's primary active facility. Called right after a facility assignment so a provider
 * who gains facility-wide MD scope never loses sight of their own previously-unlinked records (the exact
 * stranding that pure facility-scoped access would otherwise cause). Never overwrites an existing link;
 * sets the encrypted facility snapshot on patients only when absent. No-op when the provider has no
 * active facility. Returns how many rows were healed.
 */
export async function healProviderNullFacilities(providerId) {
  const fid = await providerPrimaryFacilityId(providerId);
  if (!fid) return { patients: 0, referrals: 0, facilityId: null };
  const [frows] = await execute('SELECT uuid, name FROM facilities WHERE id = :id LIMIT 1', { id: fid });
  const snap = frows[0] ? encrypt(JSON.stringify({ facilityUuid: frows[0].uuid, facilityName: frows[0].name })) : null;
  const [p] = await execute(
    'UPDATE patients SET facility_id = :fid, facility_enc = COALESCE(facility_enc, :snap) WHERE provider_id = :pid AND facility_id IS NULL',
    { fid, snap, pid: providerId });
  const [r] = await execute(
    'UPDATE referrals SET facility_id = :fid WHERE provider_id = :pid AND facility_id IS NULL',
    { fid, pid: providerId });
  return { patients: p.affectedRows || 0, referrals: r.affectedRows || 0, facilityId: fid };
}

/**
 * Active PROVIDERS assigned to any facility the given user is assigned to — the
 * rendering providers a front-desk/billing (or MD) user may schedule within their
 * facility. Real assignments only; returns [] when the user has no facility.
 */
export async function listSchedulableProviders(userId) {
  const facIds = await providerFacilityIds(userId);
  if (!facIds.length) return [];
  const params = {};
  const ph = facIds.map((id, i) => { params[`f${i}`] = id; return `:f${i}`; }).join(',');
  const [rows] = await execute(
    `SELECT DISTINCT u.id, u.uuid, u.full_name_enc, u.credentials, s.uuid AS specialty_uuid, s.name AS specialty_name
       FROM users u JOIN provider_facilities pf ON pf.provider_id = u.id
       LEFT JOIN specialties s ON s.id = u.specialty_id
      WHERE u.role = 'provider' AND u.status = 'active' AND pf.facility_id IN (${ph})
      ORDER BY u.id`,
    params,
  );
  return rows.map((r) => ({
    uuid: r.uuid,
    fullName: r.full_name_enc ? decrypt(r.full_name_enc) : '',
    credentials: (() => { try { return Array.isArray(r.credentials) ? r.credentials : JSON.parse(r.credentials || '[]'); } catch { return []; } })(),
    specialty: r.specialty_uuid ? { uuid: r.specialty_uuid, name: r.specialty_name } : null,
  }));
}

/** True iff `providerUuid` is an active provider assigned to a facility the user shares. */
export async function isProviderInUserFacilities(providerUuid, userId) {
  const facIds = await providerFacilityIds(userId);
  if (!facIds.length) return false;
  const params = { pu: providerUuid };
  const ph = facIds.map((id, i) => { params[`f${i}`] = id; return `:f${i}`; }).join(',');
  const [rows] = await execute(
    `SELECT u.id FROM users u JOIN provider_facilities pf ON pf.provider_id = u.id
      WHERE u.uuid = :pu AND u.role = 'provider' AND u.status = 'active' AND pf.facility_id IN (${ph}) LIMIT 1`,
    params,
  );
  return rows[0]?.id || false;
}

/** True iff a patient (by uuid) belongs to a facility the given user is assigned to. */
export async function isPatientInUserFacilities(patientUuid, userId) {
  const facIds = await providerFacilityIds(userId);
  if (!facIds.length || !patientUuid) return false;
  const params = { pu: patientUuid };
  const ph = facIds.map((id, i) => { params[`f${i}`] = id; return `:f${i}`; }).join(',');
  const [rows] = await execute(
    `SELECT id FROM patients WHERE uuid = :pu AND facility_id IN (${ph}) LIMIT 1`,
    params,
  );
  return !!rows[0];
}

/** Facilities a specific user (provider or billing) is assigned to — by uuid. */
export async function listUserFacilities(userUuid) {
  const [u] = await execute(`SELECT id FROM users WHERE uuid = :u AND role IN ('provider','billing') LIMIT 1`, { u: userUuid });
  if (!u[0]) return [];
  const [rows] = await execute(
    `SELECT ${FAC_COLS} FROM facilities f
       JOIN provider_facilities pf ON pf.facility_id = f.id
      WHERE pf.provider_id = :pid ORDER BY f.name ASC`,
    { pid: u[0].id },
  );
  return rows.map(toFacility);
}

/** Replace a user's facility assignments with exactly `facilityUuids`. */
export async function setUserFacilities(userUuid, facilityUuids = [], adminId = null) {
  const [u] = await execute(`SELECT id FROM users WHERE uuid = :u AND role IN ('provider','billing') LIMIT 1`, { u: userUuid });
  if (!u[0]) return { notFound: true };
  const pid = u[0].id;
  const uuids = Array.from(new Set((facilityUuids || []).filter(Boolean)));
  let wantIds = [];
  if (uuids.length) {
    const placeholders = uuids.map((_, i) => `:f${i}`).join(',');
    const params = {};
    uuids.forEach((v, i) => { params[`f${i}`] = v; });
    const [frows] = await execute(`SELECT id FROM facilities WHERE uuid IN (${placeholders})`, params);
    wantIds = frows.map((r) => Number(r.id));
  }
  const [cur] = await execute(`SELECT facility_id FROM provider_facilities WHERE provider_id = :pid`, { pid });
  const curSet = new Set(cur.map((r) => Number(r.facility_id)));
  const wantSet = new Set(wantIds);
  for (const fid of [...curSet].filter((id) => !wantSet.has(id))) {
    await execute(`DELETE FROM provider_facilities WHERE provider_id = :pid AND facility_id = :fid`, { pid, fid });
  }
  for (const fid of [...wantSet].filter((id) => !curSet.has(id))) {
    await execute(`INSERT IGNORE INTO provider_facilities (provider_id, facility_id, assigned_by) VALUES (:pid, :fid, :aid)`, { pid, fid, aid: adminId });
  }
  return { ok: true };
}
