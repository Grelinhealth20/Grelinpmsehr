import { execute } from '../db/pool.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Per-facility referral FAX configuration (Super Admin).
 *
 * A multi-facility EHR: each facility can carry its OWN dedicated Fax.Plus numbers —
 *   • incomingNumber — the DID inbound referral faxes ARRIVE on; used to route a received fax to
 *     the correct facility (so one facility's inbound referrals never appear under another). It MUST
 *     be unique across facilities for the routing to be deterministic.
 *   • outgoingNumber — the number a facility's OUTBOUND referral faxes are sent FROM.
 *   • enabled — whether referral faxing is active for the facility at all.
 *
 * Numbers are non-PHI operational config stored on the `facilities` row. When a facility has no
 * override, the send/receive paths fall back to the global Fax.Plus numbers (config.faxplus.*), so
 * existing behavior is preserved. All mutations are Super-Admin gated at the route.
 */

const normNum = (s) => String(s == null ? '' : s).replace(/[^\d+]/g, '').slice(0, 24);
const isValidFax = (s) => /^\+?\d{7,15}$/.test(s);
/** Normalize a fax number to a consistent `+E.164`-ish form for storage + comparison ('' when empty). */
export function normalizeFax(raw) {
  const n = normNum(raw);
  if (!n) return '';
  const digits = n.replace(/\+/g, '');
  return `+${digits}`;
}
function invalid(message) { const e = new Error(message); e.status = 400; e.code = 'FAX_CONFIG_INVALID'; return e; }

function toConfig(r) {
  return {
    uuid: r.uuid,
    name: r.name,
    npi: r.npi || null,
    status: r.status,
    providerCount: r.provider_count != null ? Number(r.provider_count) : undefined,
    incomingNumber: r.fax_incoming_number || null,
    outgoingNumber: r.fax_outgoing_number || null,
    enabled: r.fax_referrals_enabled == null ? true : !!Number(r.fax_referrals_enabled), // faxing (send/receive)
    referralsEnabled: r.referrals_enabled == null ? true : !!Number(r.referrals_enabled), // the Referrals feature
    updatedAt: r.fax_updated_at || null,
  };
}

const FAX_COLS = `f.uuid, f.name, f.npi, f.status,
  f.fax_incoming_number, f.fax_outgoing_number, f.fax_referrals_enabled, f.referrals_enabled,
  DATE_FORMAT(f.fax_updated_at, '%Y-%m-%dT%H:%i:%sZ') AS fax_updated_at`;

/** The platform's provisioned Fax.Plus numbers — shown to the admin as REFERENCE only (a number an
 *  admin may explicitly assign to a facility). These are NOT a fallback: nothing auto-uses them. */
export function platformFaxNumbers() {
  return {
    incomingNumber: config.faxplus.incomingNumber || null,
    outgoingNumber: config.faxplus.outgoingNumber || null,
  };
}

/** Facilities with their referral-fax config + provider counts, plus the platform numbers (reference).
 *  Backend-paginated: pass { q, page, pageSize } for a page (searchable by name/NPI/city — all plaintext);
 *  omit page/pageSize to get the full set. Returns { platformNumbers, facilities, total, page, pageSize }. */
export async function listFacilityFaxConfigs({ q = '', page = null, pageSize = null } = {}) {
  const provSub = '(SELECT COUNT(*) FROM provider_facilities pf WHERE pf.facility_id = f.id) AS provider_count';
  const where = []; const params = {};
  if (q && String(q).trim()) { where.push('(f.name LIKE :q OR f.npi LIKE :q OR f.city LIKE :q)'); params.q = `%${String(q).trim()}%`; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const platformNumbers = platformFaxNumbers();

  if (page == null && pageSize == null) {
    const [rows] = await execute(`SELECT ${FAX_COLS}, ${provSub} FROM facilities f ${clause} ORDER BY f.name ASC`, params);
    return { platformNumbers, facilities: rows.map(toConfig), total: rows.length, page: 1, pageSize: rows.length };
  }
  const lim = Math.min(Math.max(Math.floor(Number(pageSize)) || 25, 1), 200);
  const pg = Math.max(Math.floor(Number(page)) || 1, 1);
  const off = (pg - 1) * lim;
  const [[cnt]] = [await execute(`SELECT COUNT(*) total FROM facilities f ${clause}`, params)].map((x) => x[0]);
  const [rows] = await execute(`SELECT ${FAX_COLS}, ${provSub} FROM facilities f ${clause} ORDER BY f.name ASC LIMIT ${lim} OFFSET ${off}`, params);
  return { platformNumbers, facilities: rows.map(toConfig), total: Number(cnt.total) || 0, page: pg, pageSize: lim };
}

/** One facility's referral-fax config (null if the facility does not exist). */
export async function getFacilityFaxConfig(uuid) {
  const [rows] = await execute(
    `SELECT ${FAX_COLS},
        (SELECT COUNT(*) FROM provider_facilities pf WHERE pf.facility_id = f.id) AS provider_count
       FROM facilities f WHERE f.uuid = :u LIMIT 1`,
    { u: uuid },
  );
  return rows[0] ? toConfig(rows[0]) : null;
}

/**
 * Set a facility's referral-fax config. Only the fields present in `patch` change. Validates each
 * number and enforces that an incoming DID is not already assigned to another facility (deterministic
 * inbound routing). Returns the updated config, or null if the facility does not exist.
 */
export async function setFacilityFaxConfig(uuid, patch = {}, adminId = null) {
  const [f] = await execute('SELECT id FROM facilities WHERE uuid = :u LIMIT 1', { u: uuid });
  if (!f[0]) return null;
  const facId = f[0].id;

  const sets = ['fax_updated_by = :by', 'fax_updated_at = NOW()'];
  const params = { id: facId, by: adminId || null };

  if (patch.incomingNumber !== undefined) {
    // Distinguish a deliberate CLEAR (empty/whitespace) from non-empty GARBAGE ('abc'). Garbage
    // normalizes to '' too, so validate against the raw input — fail loud, never silently clear.
    const rawIn = String(patch.incomingNumber ?? '').trim();
    const inc = normalizeFax(patch.incomingNumber);
    if (rawIn && !isValidFax(inc)) throw invalid('The incoming fax number is not a valid phone number.');
    if (inc) {
      const [dup] = await execute(
        'SELECT name FROM facilities WHERE fax_incoming_number = :n AND id <> :id LIMIT 1', { n: inc, id: facId });
      if (dup[0]) throw invalid(`That incoming fax number is already assigned to ${dup[0].name}.`);
    }
    sets.push('fax_incoming_number = :inc'); params.inc = inc || null;
  }
  if (patch.outgoingNumber !== undefined) {
    const rawOut = String(patch.outgoingNumber ?? '').trim();
    const out = normalizeFax(patch.outgoingNumber);
    if (rawOut && !isValidFax(out)) throw invalid('The outgoing fax number is not a valid phone number.');
    sets.push('fax_outgoing_number = :out'); params.out = out || null;
  }
  if (patch.enabled !== undefined) { sets.push('fax_referrals_enabled = :en'); params.en = patch.enabled ? 1 : 0; }
  if (patch.referralsEnabled !== undefined) { sets.push('referrals_enabled = :re'); params.re = patch.referralsEnabled ? 1 : 0; }

  try {
    await execute(`UPDATE facilities SET ${sets.join(', ')} WHERE id = :id`, params);
  } catch (e) {
    // The unique index on fax_incoming_number closes the app-check TOCTOU window: a concurrent save of
    // the same DID to another facility fails here — return the same friendly 400 rather than a raw 500.
    if (e && e.code === 'ER_DUP_ENTRY') throw invalid('That incoming fax number is already assigned to another facility.');
    throw e;
  }
  invalidateFaxRouting();
  invalidateReferralAccess();
  return getFacilityFaxConfig(uuid);
}

/**
 * Resolve a facility's OWN send/receive numbers (by internal id). Used by the fax SEND path to pick the
 * FROM number and to honor a facility-level disable. NO FALLBACK: a facility uses ONLY its own configured
 * number — an unset number returns null, and the caller must fail loud rather than silently fax from a
 * shared/global number (which would be an incorrect-sender / cross-facility risk). Returns
 * { incoming, outgoing, enabled, facility } — `facility` is false when there is no such facility row
 * (unlinked referral), so the caller knows the referral is not tied to a configured facility at all.
 */
export async function resolveFacilityFax(facilityId) {
  if (facilityId == null) return { incoming: null, outgoing: null, enabled: null, facility: false };
  const [rows] = await execute(
    'SELECT fax_incoming_number AS inc, fax_outgoing_number AS outg, fax_referrals_enabled AS en FROM facilities WHERE id = :id LIMIT 1',
    { id: facilityId });
  const r = rows[0];
  if (!r) return { incoming: null, outgoing: null, enabled: null, facility: false };
  return {
    incoming: r.inc || null,   // the facility's OWN incoming DID only — never a global fallback
    outgoing: r.outg || null,  // the facility's OWN outgoing number only — never a global fallback
    enabled: r.en == null ? true : !!Number(r.en),
    facility: true,
  };
}

// --- Inbound routing: incoming DID → facility (short-TTL cached; invalidated on config change) ------
const ROUTE_TTL_MS = 30_000;
let routeCache = { map: null, exp: 0 };
export function invalidateFaxRouting() { routeCache = { map: null, exp: 0 }; }

async function routingMap() {
  const now = Date.now();
  if (routeCache.map && routeCache.exp > now) return routeCache.map;
  const [rows] = await execute(
    "SELECT id, uuid, name, fax_incoming_number AS inc FROM facilities WHERE fax_incoming_number IS NOT NULL AND fax_incoming_number <> ''");
  // Build the DID→facility map, but FAIL CLOSED on any DID assigned to more than one facility: an
  // ambiguous number must NOT be silently delivered to an arbitrary facility (cross-facility PHI
  // mis-routing). Such a collision is prevented by the unique index on fax_incoming_number; this guards
  // the write-race window and any legacy duplicates by leaving the number UNROUTED (→ master_admin intake
  // queue) and logging loudly, rather than picking a winner.
  const byKey = new Map();
  for (const r of rows) {
    const key = normalizeFax(r.inc);
    if (!key) continue;
    const e = byKey.get(key);
    if (e) { e.count += 1; } else { byKey.set(key, { count: 1, fac: { id: Number(r.id), uuid: r.uuid, name: r.name } }); }
  }
  const map = new Map();
  for (const [key, e] of byKey) {
    if (e.count === 1) map.set(key, e.fac);
    else logger.error({ did: key, facilities: e.count }, 'inbound DID assigned to multiple facilities — routing REFUSED (fax → intake queue) to prevent cross-facility PHI mis-delivery');
  }
  routeCache = { map, exp: now + ROUTE_TTL_MS };
  return map;
}

/** The facility that owns an inbound DID (the number a fax was RECEIVED on), or null. */
export async function facilityByIncomingFaxNumber(number) {
  const n = normalizeFax(number);
  if (!n) return null;
  const map = await routingMap();
  return map.get(n) || null;
}

// --- Per-facility REFERRAL FEATURE gate (Super Admin) ---------------------------------------------
// Whether the Referrals feature is available to a given user, resolved from their facilities. Cached
// briefly (the flag changes only when a Super Admin toggles it, which clears this cache).
const RA_TTL_MS = 20_000;
const raCache = new Map(); // userId -> { enabled, exp }
export function invalidateReferralAccess(userId) { if (userId != null) raCache.delete(Number(userId)); else raCache.clear(); }

/**
 * Is the Referrals feature enabled for this user? Super/Master admins always (they manage it). Everyone
 * else: enabled iff they have NO active facility (legacy default ON) OR at least one active assigned
 * facility with referrals_enabled ≠ 0 — so disabling a facility removes Referrals for providers whose
 * facilities are ALL disabled, never affecting other facilities' providers (facility-specific).
 */
export async function referralsEnabledForProvider(userId) {
  const key = Number(userId); const now = Date.now();
  const hit = raCache.get(key); if (hit && hit.exp > now) return hit.enabled;
  const [urows] = await execute('SELECT role FROM users WHERE id = :id LIMIT 1', { id: userId });
  const role = urows[0]?.role;
  let enabled;
  if (role === 'super_admin' || role === 'master_admin') { enabled = true; }
  else {
    const [rows] = await execute(
      `SELECT COUNT(*) AS total, SUM(f.referrals_enabled <> 0) AS on_count
         FROM provider_facilities pf JOIN facilities f ON f.id = pf.facility_id
        WHERE pf.provider_id = :id AND f.status = 'active'`, { id: userId });
    const total = Number(rows[0]?.total || 0);
    const onCount = Number(rows[0]?.on_count || 0);
    enabled = total === 0 ? true : onCount > 0;
  }
  raCache.set(key, { enabled, exp: now + RA_TTL_MS });
  if (raCache.size > 5000) raCache.delete(raCache.keys().next().value);
  return enabled;
}
