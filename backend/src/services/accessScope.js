import { execute } from '../db/pool.js';
import { providerFacilityIds } from './facilityService.js';

/**
 * Clinical data access scope — the single source of truth for who may see what.
 *
 *  - An **MD** (a provider holding the 'MD' credential) may see ALL records for the
 *    facilities they are assigned to — across every provider at those facilities —
 *    and may sign/approve those notes.
 *  - Every **other provider** may see ONLY their own records.
 *
 * Scoping is always facility-bounded: an MD never sees another facility's data, and
 * a non-MD provider only ever sees the patients they own (which live at their own
 * facility). This strictly prevents cross-facility and cross-patient exposure.
 */

function parseCreds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}

export function isMdCredentials(raw) {
  return parseCreds(raw).map((c) => String(c).toUpperCase().trim()).includes('MD');
}

/**
 * Resolve the viewer's scope.
 * @returns {Promise<{ isMD: boolean, facilityIds: number[] }>}
 *   `facilityIds` is populated only for an MD who has facility assignments — the
 *   set of facilities whose records they may see. Empty otherwise.
 */
export async function viewerScope(userId) {
  const [rows] = await execute(
    `SELECT u.credentials, s.service_line AS service_line FROM users u
       LEFT JOIN specialties s ON s.id = u.specialty_id WHERE u.id = :id LIMIT 1`,
    { id: userId },
  );
  const isMD = isMdCredentials(rows[0]?.credentials);
  const facilityIds = isMD ? await providerFacilityIds(userId) : [];
  // The viewer's SERVICE LINE (snf | pain) — read from the specialty's STORED, admin-set
  // service_line column (authoritative; no name-string inference in the security path). A
  // facility-wide MD's cross-provider access is bounded to their own service line, so a
  // Pain MD never sees SNF records and vice versa even at a shared facility. A provider
  // with no specialty defaults to 'snf'.
  const serviceLine = rows[0]?.service_line || 'snf';
  return { isMD, facilityIds, serviceLine };
}

/** True when the viewer's scope is facility-wide (an MD with ≥1 assigned facility). */
export function isFacilityWide(scope) {
  return !!(scope.isMD && scope.facilityIds.length);
}

/**
 * SQL predicate restricting a note (aliased `alias`) to the viewer's OWN service line,
 * used together with facility-wide access. All Pain note types are prefixed `pain_`;
 * SNF types are not — so the split is a clean, index-friendly prefix test.
 */
export function noteServiceLineWhere(scope, alias = 'n') {
  return scope.serviceLine === 'pain' ? `${alias}.note_type LIKE 'pain%'` : `${alias}.note_type NOT LIKE 'pain%'`;
}

/**
 * Scheduling scope for the appointment book. Front-desk **billing** users AND
 * **MDs** manage the whole facility's schedule (facility-wide); every other
 * provider manages only their own book. Facility-bounded — no cross-facility.
 * @returns {Promise<{ isBilling:boolean, isMD:boolean, facilityWide:boolean, facilityIds:number[] }>}
 */
export async function schedulingScope(userId) {
  const [rows] = await execute(`SELECT role, credentials FROM users WHERE id = :id LIMIT 1`, { id: userId });
  const u = rows[0] || {};
  const isBilling = u.role === 'billing';
  const isMD = isMdCredentials(u.credentials);
  const facilityRole = isBilling || isMD;
  const facilityIds = facilityRole ? await providerFacilityIds(userId) : [];
  return { isBilling, isMD, facilityWide: facilityRole && facilityIds.length > 0, facilityIds };
}

/**
 * WHERE fragment + params scoping a `patients` row (aliased) to the viewer.
 *  - Facility-wide MD: p.facility_id IN (assigned facilities)
 *  - Everyone else:    p.provider_id = :scopePid   (own records only)
 */
export function patientScopeWhere(scope, providerId, alias = 'p') {
  if (isFacilityWide(scope)) {
    const params = {};
    const ph = scope.facilityIds.map((id, i) => { params[`sf${i}`] = id; return `:sf${i}`; }).join(',');
    // Bound to the viewer's SERVICE LINE: a facility-wide MD sees only patients whose
    // OWNING provider is in the same service line (a Pain MD never sees SNF-owned patients
    // and vice-versa). A patient owned by a provider with no/other specialty counts as SNF,
    // consistent with serviceForSpecialty(''). PK-indexed EXISTS — negligible per-row cost.
    // Bound by the OWNING provider's STORED service line (authoritative, admin-set) —
    // deterministic, no name-string matching in the security path.
    const painOwned = `EXISTS (SELECT 1 FROM users pu JOIN specialties ps ON ps.id = pu.specialty_id WHERE pu.id = ${alias}.provider_id AND ps.service_line = 'pain')`;
    const sl = scope.serviceLine === 'pain' ? painOwned : `NOT ${painOwned}`;
    return { sql: `${alias}.facility_id IN (${ph}) AND ${sl}`, params };
  }
  return { sql: `${alias}.provider_id = :scopePid`, params: { scopePid: providerId } };
}
