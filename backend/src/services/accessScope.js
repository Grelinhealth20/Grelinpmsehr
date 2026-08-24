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
  const [rows] = await execute(`SELECT credentials FROM users WHERE id = :id LIMIT 1`, { id: userId });
  const isMD = isMdCredentials(rows[0]?.credentials);
  const facilityIds = isMD ? await providerFacilityIds(userId) : [];
  return { isMD, facilityIds };
}

/** True when the viewer's scope is facility-wide (an MD with ≥1 assigned facility). */
export function isFacilityWide(scope) {
  return !!(scope.isMD && scope.facilityIds.length);
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
    return { sql: `${alias}.facility_id IN (${ph})`, params };
  }
  return { sql: `${alias}.provider_id = :scopePid`, params: { scopePid: providerId } };
}
