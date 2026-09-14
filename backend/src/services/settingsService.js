import { execute } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * System settings — super-admin controlled feature flags for the whole platform.
 * Currently governs whether real-time eligibility verification is available on the
 * EHR side. Backed by `app_settings`; reads are cached briefly so the hot-path
 * eligibility checks never add a DB round-trip.
 */

// Defaults applied when a key has never been set. Eligibility is ON by default. Automatic patient
// creation from an incoming referral fax is ON by default (deterministic match-or-create); a super/master
// admin can disable it so unmatched inbound faxes stay unlinked in the intake queue for manual review.
const DEFAULTS = Object.freeze({ eligibilityEnabled: true, faxAutoCreatePatients: true, nppMedicareDifferential: false });

// Only these keys are accepted from an admin PATCH (allowlist — no arbitrary keys).
const BOOLEAN_KEYS = new Set(['eligibilityEnabled', 'faxAutoCreatePatients', 'nppMedicareDifferential']);

const CACHE_TTL_MS = 15 * 1000;
let cache = null;
let cacheAt = 0;

const asBool = (v) => v === true || v === 1 || v === '1' || v === 'true';

async function loadAll() {
  const [rows] = await execute('SELECT setting_key, setting_value FROM app_settings');
  const out = { ...DEFAULTS };
  for (const r of rows) {
    let val = r.setting_value;
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch { /* keep raw */ } }
    // Object.hasOwn (not `in`) so a stored row keyed `__proto__`/`constructor`/`toString` cannot satisfy the
    // allowlist via the prototype chain and write onto the returned settings object.
    if (Object.hasOwn(DEFAULTS, r.setting_key)) out[r.setting_key] = typeof DEFAULTS[r.setting_key] === 'boolean' ? asBool(val) : val;
  }
  return out;
}

/** All public settings, merged over defaults. Cached for CACHE_TTL_MS. */
export async function getSettings() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  try {
    cache = await loadAll();
    cacheAt = Date.now();
  } catch (err) {
    // A transient load failure must NOT silently flip a flag to its default (which would, e.g., re-enable
    // fax auto-create an admin disabled, or drop the NPP differential an admin enabled). Serve the LAST-GOOD
    // cached values if we have them — only a COLD-START failure (never loaded) falls back to DEFAULTS.
    if (cache) {
      logger.error({ err: err.message }, 'Failed to reload app settings — serving last-good cached values');
      cacheAt = Date.now(); // brief re-cache so we don't hammer the DB on every request during the outage
      return cache;
    }
    logger.error({ err: err.message }, 'Failed to load app settings on cold start — using defaults');
    return { ...DEFAULTS };
  }
  return cache;
}

export function invalidateSettingsCache() { cache = null; cacheAt = 0; }

/** Fast boolean read for the eligibility hot path. */
export async function isEligibilityEnabled() {
  const s = await getSettings();
  return s.eligibilityEnabled !== false;
}

/** Whether inbound-fax ingestion may AUTO-CREATE a patient when no existing chart matches. Read live at
 *  ingest (cached ≤15s) so a super/master admin toggle takes effect in ~real time. Matching an EXISTING
 *  chart is unaffected — only the creation of a new chart is gated. */
export async function isFaxAutoCreateEnabled() {
  const s = await getSettings();
  return s.faxAutoCreatePatients !== false;
}

/** Whether the NPP Medicare 85% differential is applied to the payscale (default OFF → every provider paid
 *  the same $/Work-RVU). Read live at pay computation (cached ≤15s) so a super-admin toggle takes effect
 *  in ~real time. Only affects NPP-rendered work; physician (MD/DO) pay is never changed. */
export async function isNppDifferentialEnabled() {
  const s = await getSettings();
  return s.nppMedicareDifferential === true;
}

/**
 * Apply an allowlisted settings patch. Unknown keys are ignored. Returns the full,
 * fresh settings object. `updatedBy` is the acting super-admin's user id (audit).
 */
export async function updateSettings(patch = {}, updatedBy = null) {
  const applied = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!BOOLEAN_KEYS.has(key)) continue; // ignore anything not explicitly allowed
    const value = asBool(raw);
    await execute(
      `INSERT INTO app_settings (setting_key, setting_value, updated_by, updated_at)
         VALUES (:k, CAST(:v AS JSON), :by, NOW())
       ON DUPLICATE KEY UPDATE setting_value = CAST(:v AS JSON), updated_by = :by, updated_at = NOW()`,
      { k: key, v: JSON.stringify(value), by: updatedBy },
    );
    applied[key] = value;
  }
  invalidateSettingsCache();
  return { settings: await getSettings(), applied };
}
