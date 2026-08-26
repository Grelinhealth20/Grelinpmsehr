import { execute } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * System settings — super-admin controlled feature flags for the whole platform.
 * Currently governs whether real-time eligibility verification is available on the
 * EHR side. Backed by `app_settings`; reads are cached briefly so the hot-path
 * eligibility checks never add a DB round-trip.
 */

// Defaults applied when a key has never been set. Eligibility is ON by default.
const DEFAULTS = Object.freeze({ eligibilityEnabled: true });

// Only these keys are accepted from an admin PATCH (allowlist — no arbitrary keys).
const BOOLEAN_KEYS = new Set(['eligibilityEnabled']);

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
    if (r.setting_key in DEFAULTS) out[r.setting_key] = typeof DEFAULTS[r.setting_key] === 'boolean' ? asBool(val) : val;
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
    // Never fail a request because settings couldn't load — fall back to defaults.
    logger.error({ err: err.message }, 'Failed to load app settings — using defaults');
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
