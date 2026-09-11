/**
 * Facility-specific identifier allocation — the atomic, concurrency-safe backbone of the MRN and Encounter
 * ID series. NO fallbacks: a record that cannot be tied to a facility with a Facility Code fails loudly
 * rather than silently minting a non-facility identifier.
 *   • MRN          = <CODE>-NNNNNN-C   (6-digit per-facility sequence + Luhn check digit)
 *   • Encounter ID = <CODE>-YYYY-NNNNNN (per-facility, per-year sequence)
 */
import { withTransaction, execute } from '../db/pool.js';

/**
 * Next integer for `scope`, allocated ATOMICALLY (MySQL LAST_INSERT_ID upsert on a single connection).
 * Two concurrent callers can never receive the same value — the row lock serializes them — so the series
 * is clean and collision-free. Starts at 1.
 */
export async function nextSequence(scope) {
  return withTransaction(async (exec) => {
    await exec(
      `INSERT INTO id_sequences (scope, seq) VALUES (:s, LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)`,
      { s: scope },
    );
    const [rows] = await exec('SELECT LAST_INSERT_ID() AS n');
    return Number(rows[0].n);
  });
}

/** The facility's REQUIRED uppercase code. Throws (no fallback) if the facility is missing or has no code. */
export async function facilityCodeFor(facilityId) {
  if (!facilityId) {
    const e = new Error('A facility is required to allocate a facility-specific identifier (MRN / Encounter ID).');
    e.status = 422; e.code = 'FACILITY_REQUIRED'; throw e;
  }
  const [rows] = await execute('SELECT facility_code FROM facilities WHERE id = :id LIMIT 1', { id: facilityId });
  const code = rows[0]?.facility_code;
  if (!code) {
    const e = new Error('This facility has no Facility Code set. Set a Facility Code in the facility settings before creating patients or encounters.');
    e.status = 422; e.code = 'FACILITY_CODE_MISSING'; throw e;
  }
  return String(code).toUpperCase();
}

/** Luhn check digit over a numeric string (medical-records-grade typo/transposition detection). */
export function luhnCheckDigit(digits) {
  const s = String(digits).replace(/\D/g, '');
  let sum = 0; let dbl = true; // rightmost body digit is doubled
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Propose a UNIQUE facility code from a name: first alphanumerics, uppercased, ≥2 chars, numeric suffix on
 *  collision. `taken` is a Set of already-used uppercase codes. Deterministic. */
export function proposeFacilityCode(name, taken = new Set(), fallbackId = 0) {
  const alpha = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = (alpha.slice(0, 3) || `F${fallbackId}`).padEnd(2, 'X').slice(0, 8);
  let code = base; let n = 1;
  while (taken.has(code)) { const suf = String(n++); code = base.slice(0, Math.max(2, 8 - suf.length)) + suf; }
  return code;
}

/** All facility codes currently in use (uppercase), for uniqueness checks. */
export async function facilityCodesInUse(excludeFacilityId = null) {
  const [rows] = await execute(
    `SELECT facility_code AS c FROM facilities WHERE facility_code IS NOT NULL AND facility_code <> '' ${excludeFacilityId ? 'AND id <> :ex' : ''}`,
    excludeFacilityId ? { ex: excludeFacilityId } : {},
  );
  return new Set(rows.map((r) => String(r.c).toUpperCase()));
}
