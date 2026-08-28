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
 * Authoritative SET of service lines a provider may practice — the UNION of the service
 * lines of ALL their assigned specialties (many-to-many `user_specialties`). A provider
 * assigned SNFs + Pain returns ['snf','pain']; a single-specialty provider returns one
 * line. Falls back to the legacy single `specialty_id` if the join table has no rows yet.
 * A provider with NO specialty returns an EMPTY set (deny-by-default — no fallback). Read from
 * the STORED, admin-set `service_line` column — no name-string inference in the security path.
 * @returns {Promise<string[]>} distinct service lines (subset of {'snf','pain','tcm'})
 */
/**
 * Short-TTL cache for a provider's service-line set. Read on the hot path (the note-template
 * picker on every open, note create/update, and inside viewerScope for every notes op) and
 * the remote DB has ~260-520ms round-trip latency — caching removes that per-request cost.
 * The set changes only when an admin edits the provider's specialties, which invalidates the
 * entry; a 20s TTL bounds staleness even if an invalidation is ever missed.
 */
const SL_TTL_MS = 20_000;
const slCache = new Map(); // userId -> { lines:string[], exp:number }
export function invalidateServiceLines(userId) {
  if (userId != null) slCache.delete(Number(userId));
  else slCache.clear();
}

export async function providerServiceLines(userId) {
  const key = Number(userId);
  const now = Date.now();
  const cached = slCache.get(key);
  if (cached && cached.exp > now) return cached.lines.slice();
  const [rows] = await execute(
    `SELECT DISTINCT s.service_line AS sl
       FROM user_specialties us JOIN specialties s ON s.id = us.specialty_id
      WHERE us.user_id = :id`,
    { id: userId },
  );
  let lines = rows.map((r) => r.sl).filter(Boolean);
  if (!lines.length) {
    // Legacy fallback: the single specialty_id (providers not migrated to the join table).
    const [leg] = await execute(
      `SELECT s.service_line AS sl FROM users u JOIN specialties s ON s.id = u.specialty_id WHERE u.id = :id`,
      { id: userId },
    );
    lines = leg.map((r) => r.sl).filter(Boolean);
  }
  // NO FALLBACK: a provider with no assigned specialty gets an EMPTY set and is denied all
  // clinical records (deny-by-default), rather than silently defaulting to a service line.
  const distinct = [...new Set(lines)];
  slCache.set(key, { lines: distinct, exp: now + SL_TTL_MS });
  if (slCache.size > 5000) slCache.delete(slCache.keys().next().value);
  return distinct.slice();
}

/**
 * Resolve the viewer's scope.
 * @returns {Promise<{ isMD: boolean, facilityIds: number[], serviceLines: string[] }>}
 *   `facilityIds` is populated only for an MD who has facility assignments. `serviceLines`
 *   is the union of the viewer's specialties' service lines — a facility-wide MD's
 *   cross-provider access is bounded to exactly these lines (a Pain-only MD never sees SNF
 *   records; a multi-specialty SNF+Pain MD sees both), so isolation never widens beyond the
 *   admin-granted specialties.
 */
export async function viewerScope(userId) {
  const [rows] = await execute(`SELECT credentials FROM users WHERE id = :id LIMIT 1`, { id: userId });
  const isMD = isMdCredentials(rows[0]?.credentials);
  const facilityIds = isMD ? await providerFacilityIds(userId) : [];
  const serviceLines = await providerServiceLines(userId);
  return { isMD, facilityIds, serviceLines };
}

/** True when the viewer's scope is facility-wide (an MD with ≥1 assigned facility). */
export function isFacilityWide(scope) {
  return !!(scope.isMD && scope.facilityIds.length);
}

/**
 * SQL predicate restricting a note (aliased `alias`) to the viewer's OWN service line(s),
 * used together with facility-wide access. Pain note types are prefixed `pain_` and TCM types
 * `tcm_`; SNF types carry no prefix (the residual) — a clean, index-friendly prefix split.
 */
const SERVICE_LINES = ['snf', 'pain', 'tcm'];

/** Per-line note-type predicate. Pain and TCM note types carry their line prefix (`pain_`,
 *  `tcm_`); SNF is the RESIDUAL (no prefix), so a SNF viewer sees notes that are neither. */
function lineNotePredicate(line, alias) {
  if (line === 'pain') return `${alias}.note_type LIKE 'pain%'`;
  if (line === 'tcm') return `${alias}.note_type LIKE 'tcm%'`;
  return `(${alias}.note_type NOT LIKE 'pain%' AND ${alias}.note_type NOT LIKE 'tcm%')`; // snf residual
}

export function noteServiceLineWhere(scope, alias = 'n') {
  const lines = [...new Set(scope.serviceLines || [])].filter((l) => SERVICE_LINES.includes(l));
  if (!lines.length) return '1=0'; // no granted service line → sees no notes (deny by default, no fallback)
  // OR over the viewer's granted lines — a multi-specialty viewer sees the union.
  return `(${lines.map((l) => lineNotePredicate(l, alias)).join(' OR ')})`;
}

/** EXISTS predicate: the owning provider (aliased row's `provider_id`) practises `line`.
 *  SNF is the residual — an owner with a stored SNF specialty OR NO specialty at all counts
 *  as SNF, matching the note-type residual so purely-SNF patients aren't stranded. */
function ownerHasLinePredicate(line, alias) {
  if (line === 'snf') {
    return `(EXISTS (SELECT 1 FROM user_specialties pus JOIN specialties ps ON ps.id = pus.specialty_id WHERE pus.user_id = ${alias}.provider_id AND ps.service_line = 'snf') OR NOT EXISTS (SELECT 1 FROM user_specialties pus WHERE pus.user_id = ${alias}.provider_id))`;
  }
  return `EXISTS (SELECT 1 FROM user_specialties pus JOIN specialties ps ON ps.id = pus.specialty_id WHERE pus.user_id = ${alias}.provider_id AND ps.service_line = '${line}')`;
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
    // Bound to the viewer's SERVICE-LINE SET by the OWNING provider's specialties
    // (many-to-many, join-aware): a facility-wide MD sees a patient iff the owning provider
    // practises at least one service line the viewer holds. A Pain-only MD never sees a
    // purely-SNF-owned patient (and vice-versa); a multi-specialty SNF+Pain MD sees both.
    // An owner with NO specialties counts as SNF (consistent with the default). Deterministic,
    // admin-set service_line only — no name-string matching in the security path.
    const lines = [...new Set(scope.serviceLines || [])].filter((l) => SERVICE_LINES.includes(l));
    // Empty set (no specialty granted): deny — no fallback. Otherwise the viewer sees a patient
    // iff the OWNING provider practises at least one of the viewer's granted lines (OR over lines).
    const sl = lines.length ? `(${lines.map((l) => ownerHasLinePredicate(l, alias)).join(' OR ')})` : '1=0';
    return { sql: `${alias}.facility_id IN (${ph}) AND ${sl}`, params };
  }
  return { sql: `${alias}.provider_id = :scopePid`, params: { scopePid: providerId } };
}
