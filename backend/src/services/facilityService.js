import { v4 as uuidv4 } from 'uuid';
import { execute } from '../db/pool.js';
import { decrypt } from '../utils/crypto.js';
import { normalizeState, extractStateFromText } from './payerDirectoryService.js';
import { s3Enabled, uploadFacilityLogo, signedGetUrl, deleteObject } from './s3Service.js';

// Decode a data:image/...;base64 URI → { buffer, contentType, ext } (null if not one).
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
function parseLogoDataUri(uri) {
  const m = String(uri || '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return null;
  const contentType = m[1].toLowerCase();
  return { buffer: Buffer.from(m[2], 'base64'), contentType, ext: EXT[contentType] || 'png' };
}

/** Replace facility.logo (an S3 key) with a short-lived signed URL for display. */
async function signLogo(facility) {
  if (facility && facility.logo && s3Enabled()) {
    try { facility.logo = await signedGetUrl(facility.logo, 900); } catch { facility.logo = null; }
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

const FAC_COLS = `f.uuid, f.npi, f.name, f.address, f.city, f.state, f.zip, f.phone,
  f.taxonomy, f.logo, f.status, f.source,
  DATE_FORMAT(f.created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at`;

function toFacility(r) {
  return {
    uuid: r.uuid, npi: r.npi || null, name: r.name,
    address: r.address || null, city: r.city || null, state: r.state || null,
    zip: r.zip || null, phone: r.phone || null, taxonomy: r.taxonomy || null,
    logo: r.logo || null,
    status: r.status, source: r.source,
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
  return Promise.all(rows.map((r) => signLogo(toFacility(r))));
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
  return { ...(await signLogo(toFacility(row))), providers };
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
    try { logoKey = await uploadFacilityLogo(uuid, parsed.buffer, parsed.contentType, parsed.ext); } catch { logoKey = null; }
  }
  await execute(
    `INSERT INTO facilities (uuid, npi, name, address, city, state, zip, phone, taxonomy, logo, status, source, verified_by, created_by)
     VALUES (:uuid, :npi, :name, :address, :city, :state, :zip, :phone, :taxonomy, :logo, 'active', :source, :adminId, :adminId)`,
    {
      uuid, npi: data.npi || null, name: data.name, address: data.address || null,
      city: data.city || null, state: data.state || null, zip: data.zip || null,
      phone: data.phone || null, taxonomy: data.taxonomy || null, logo: logoKey,
      source: data.source || 'nppes', adminId: adminId || null,
    },
  );
  return { facility: await getFacility(uuid), duplicate: false };
}

export async function updateFacility(uuid, data) {
  const row = await facilityRowByUuid(uuid);
  if (!row) return null;
  const sets = [];
  const params = { uuid };
  for (const k of ['npi', 'name', 'address', 'city', 'state', 'zip', 'phone', 'taxonomy']) {
    if (data[k] !== undefined) { sets.push(`${k} = :${k}`); params[k] = data[k] || null; }
  }
  // Logo: a new data URI uploads to the facility's S3 folder (replacing the old
  // object); an empty string clears it. `row.logo` holds the current S3 key.
  if (data.logo !== undefined) {
    const parsed = parseLogoDataUri(data.logo);
    if (parsed && s3Enabled()) {
      let key = null;
      try { key = await uploadFacilityLogo(uuid, parsed.buffer, parsed.contentType, parsed.ext); } catch { key = null; }
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

export async function deleteFacility(uuid) {
  const [res] = await execute(`DELETE FROM facilities WHERE uuid = :uuid`, { uuid });
  return res.affectedRows > 0;
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
  return { ok: true };
}

export async function unassignProvider(facilityUuid, providerUuid) {
  const { facilityId, providerId } = await idsFor(facilityUuid, providerUuid);
  if (!facilityId || !providerId) return { notFound: true };
  await execute(`DELETE FROM provider_facilities WHERE provider_id = :pid AND facility_id = :fid`, { pid: providerId, fid: facilityId });
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

/** Internal-id set of a provider's assigned facilities (isolation checks). */
export async function providerFacilityIds(providerId) {
  const [rows] = await execute(`SELECT facility_id FROM provider_facilities WHERE provider_id = :pid`, { pid: providerId });
  return rows.map((r) => Number(r.facility_id));
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
