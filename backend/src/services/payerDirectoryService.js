import { pool, execute } from '../db/pool.js';

/**
 * Stedi Payer Network directory (loaded from Stedi's CSV export into stedi_payers).
 * Resolves a face-sheet payer — a name, primary payer ID, or alias (e.g. "UHC",
 * "Cigna", "62308") — to the canonical Stedi payer, returning the STEDI payer ID
 * used as tradingPartnerServiceId for eligibility. Public reference data, so it is
 * matched in plaintext (no encryption/blind index).
 */

function mapRow(r) {
  if (!r) return null;
  return { stediId: r.stedi_id, primaryPayerId: r.primary_payer_id || null, name: r.display_name };
}

const STATE_ABBR = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY',
  LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA',
  WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'PUERTO RICO': 'PR',
};

const STATE_CODES = new Set(Object.values(STATE_ABBR));

/** Normalize a state to its 2-letter USPS code ('' if unknown). */
export function normalizeState(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t) return '';
  if (t.length === 2) return STATE_CODES.has(t) ? t : '';
  return STATE_ABBR[t] || '';
}

/**
 * Best-effort extraction of a US state from a freeform address/city string — used
 * when a facility has no discrete state field but the state is present in its
 * address (e.g. "123 Main St, Harrisburg, PA 17101" or "…, Pennsylvania"). Returns
 * the 2-letter USPS code, or '' if none can be determined. Never guesses a state
 * that isn't literally present.
 */
export function extractStateFromText(text) {
  const up = String(text || '').trim().toUpperCase();
  if (!up) return '';
  // 1) A 2-letter state code sitting right before a 5-digit ZIP ("... PA 17101").
  const z = up.match(/\b([A-Z]{2})\b\s*,?\s*\d{5}(?:-\d{4})?/);
  if (z && STATE_CODES.has(z[1])) return z[1];
  // 2) A full state name appearing anywhere in the text.
  for (const [name, ab] of Object.entries(STATE_ABBR)) {
    if (new RegExp(`\\b${name}\\b`).test(up)) return ab;
  }
  // 3) Any standalone valid 2-letter state code — last one wins (states sit near
  //    the end of an address, before the ZIP).
  const codes = (up.match(/\b[A-Z]{2}\b/g) || []).filter((c) => STATE_CODES.has(c));
  return codes.length ? codes[codes.length - 1] : '';
}

/**
 * Is this face-sheet payer traditional/Original Medicare Part B (a state-MAC
 * jurisdiction), as opposed to a Medicare Advantage plan (which has its own payer)?
 */
export function isMedicarePartB(payer) {
  const p = String(payer || '').trim().toLowerCase();
  if (!p) return false;
  if (p.includes('advantage') || p.includes('part c') || p.includes('gold plus') || p.includes('hmo') || p.includes('ppo')) return false;
  return (
    /^medicare(\s*(part\s*)?b)?$/.test(p) ||
    /^(traditional|original)\s+medicare/.test(p) ||
    /medicare\s+(ffs|fee[-\s]for[-\s]service)/.test(p) ||
    /^part\s*b$/.test(p) ||
    /^mcr(\s*b)?$/.test(p) ||
    (p.includes('medicare') && p.includes('part b'))
  );
}

/** State-specific "Medicare {State} Part B" MAC payer for a facility's state. */
export async function resolveMedicarePartB(state) {
  const st = normalizeState(state);
  if (!st) return null;
  const [rows] = await execute(
    `SELECT stedi_id, primary_payer_id, display_name
       FROM stedi_payers
      WHERE UPPER(operating_states) = :st
        AND LOWER(display_name) LIKE 'medicare %part b'
        AND eligibility_supported = 1
      ORDER BY CHAR_LENGTH(display_name) ASC
      LIMIT 1`,
    { st },
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Typeahead search over the Stedi payer directory for the face-sheet Payer picker.
 * Unlike resolvePayer (which is exact-only for routing), this is a human-facing
 * SEARCH box: it ranks id / exact-name / prefix / contains matches so the provider
 * can pick the exact payer. Eligibility-supported payers rank first. Returns a small
 * result list [{ stediId, primaryPayerId, name, eligibilitySupported }].
 */
export async function searchPayers(queryText, { limit = 10 } = {}) {
  const q = String(queryText || '').trim();
  if (q.length < 2) return [];
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();
  const lim = Math.min(25, Math.max(1, Number(limit) || 10));
  const [rows] = await execute(
    `SELECT stedi_id, primary_payer_id, display_name, eligibility_supported,
       (CASE
          WHEN UPPER(stedi_id) = :qu OR UPPER(primary_payer_id) = :qu THEN 100
          WHEN LOWER(display_name) = :ql THEN 90
          WHEN LOWER(display_name) LIKE :pfx THEN 70
          WHEN LOWER(display_name) LIKE :ctn THEN 45
          WHEN LOWER(names) LIKE :ctn THEN 30
          ELSE 10
        END) AS score
       FROM stedi_payers
      WHERE UPPER(stedi_id) = :qu
         OR UPPER(primary_payer_id) = :qu
         OR LOWER(display_name) LIKE :ctn
         OR LOWER(names) LIKE :ctn
      ORDER BY score DESC, eligibility_supported DESC, CHAR_LENGTH(display_name) ASC
      LIMIT ${lim}`,
    { qu: qUpper, ql: qLower, pfx: `${qLower}%`, ctn: `%${qLower}%` },
  );
  return rows.map((r) => ({
    stediId: r.stedi_id,
    primaryPayerId: r.primary_payer_id || null,
    name: r.display_name,
    eligibilitySupported: !!r.eligibility_supported,
  }));
}

/** How many payers are loaded (0 => run the loader before relying on the DB). */
export async function payerCount() {
  const [rows] = await execute('SELECT COUNT(*) AS n FROM stedi_payers');
  return Number(rows[0]?.n || 0);
}

// Generic payer words that DON'T distinguish one payer from another — plan-type and
// filler tokens. Used ONLY to strip trailing plan descriptors off a face-sheet payer
// string (e.g. "WellMed Medicare Advantage PDPM" → "WellMed") before an EXACT lookup.
const GENERIC_PAYER_WORDS = new Set([
  'medicare', 'medicaid', 'advantage', 'part', 'plan', 'plans', 'health', 'healthcare',
  'insurance', 'ins', 'of', 'the', 'and', 'ppo', 'hmo', 'pos', 'epo', 'pdp', 'pdpm', 'snp',
  'mapd', 'gold', 'plus', 'prime', 'choice', 'care', 'community', 'group', 'inc', 'llc', 'co',
  'company', 'corp', 'network', 'america', 'american', 'national', 'state', 'usa', 'value',
  'complete', 'classic', 'basic', 'select', 'preferred', 'premier', 'total', 'senior', 'dual',
]);
const normId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve a payer to its canonical Stedi payer — EXACT MATCH ONLY. No fuzzy
 * substring matching and no live-search fallback: a face-sheet payer resolves only
 * when it matches a real Stedi payer by Stedi ID, primary payer ID, display name
 * (exact, or exact ignoring spacing/punctuation), or an exact alias/name token.
 *
 * Face sheets often carry PLAN descriptors after the payer name — e.g. "WellMed
 * Medicare Advantage PDPM" for the payer "WellMed" — so if the full string has no
 * exact match we retry with progressively fewer TRAILING GENERIC words (longest
 * first). Every attempt is still an EXACT lookup. Returns null when nothing matches
 * exactly (the caller surfaces "payer not matched" — never a guessed payer).
 */
export async function resolvePayer(queryText, opts = {}) {
  const q = String(queryText || '').trim();
  if (!q) return null;
  // Traditional Medicare Part B → the state-specific MAC payer for the facility's
  // state (real-time). Returns null if the state is unknown so the caller can
  // surface it, rather than routing to a wrong-state Medicare payer.
  if (isMedicarePartB(q)) return resolveMedicarePartB(opts.state);

  const words = q.split(/\s+/);
  for (let n = words.length; n >= 1; n--) {
    const sub = words.slice(0, n).join(' ');
    const row = await resolveExact(sub);
    if (row) return row;
    // Only keep stripping if the word we're about to drop is a generic plan
    // descriptor — never strip into a different, more-specific payer name.
    if (n > 1 && !GENERIC_PAYER_WORDS.has(normId(words[n - 1]))) break;
  }
  return null;
}

/** EXACT directory lookup for one query string (no substring/prefix fuzzy matching). */
async function resolveExact(q) {
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();
  const qNorm = normId(q); // spacing/punctuation-insensitive identity (still exact)
  const NORM_DN = "REPLACE(REPLACE(REPLACE(LOWER(display_name),' ',''),'-',''),'.','')";
  const [rows] = await execute(
    `SELECT stedi_id, primary_payer_id, display_name, eligibility_supported,
       (CASE
          WHEN UPPER(stedi_id) = :qu THEN 100
          WHEN UPPER(primary_payer_id) = :qu THEN 92
          WHEN LOWER(display_name) = :ql THEN 88
          WHEN ${NORM_DN} = :qn THEN 86
          WHEN CONCAT('|', UPPER(aliases), '|') LIKE :aliasTok THEN 74
          WHEN CONCAT('|', LOWER(names), '|') LIKE :nameTok THEN 70
          ELSE 0
        END) AS score
       FROM stedi_payers
      WHERE UPPER(stedi_id) = :qu
         OR UPPER(primary_payer_id) = :qu
         OR LOWER(display_name) = :ql
         OR ${NORM_DN} = :qn
         OR CONCAT('|', UPPER(aliases), '|') LIKE :aliasTok
         OR CONCAT('|', LOWER(names), '|') LIKE :nameTok
      ORDER BY score DESC, eligibility_supported DESC, CHAR_LENGTH(display_name) ASC
      LIMIT 1`,
    { qu: qUpper, ql: qLower, qn: qNorm, aliasTok: `%|${qUpper}|%`, nameTok: `%|${qLower}|%` },
  );
  return rows[0] && rows[0].score > 0 ? mapRow(rows[0]) : null;
}

/**
 * Bulk upsert payer rows (used by the CSV loader). Each row is the tuple order:
 * [stediId, primaryPayerId, displayName, names, aliases, eligibilitySupported,
 *  coverageTypes, operatingStates]. Chunked to stay within packet limits.
 */
export async function upsertPayers(rows, { chunkSize = 500 } = {}) {
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await pool.query(
      `INSERT INTO stedi_payers
         (stedi_id, primary_payer_id, display_name, names, aliases, eligibility_supported, coverage_types, operating_states)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         primary_payer_id = VALUES(primary_payer_id),
         display_name     = VALUES(display_name),
         names            = VALUES(names),
         aliases          = VALUES(aliases),
         eligibility_supported = VALUES(eligibility_supported),
         coverage_types   = VALUES(coverage_types),
         operating_states = VALUES(operating_states)`,
      [chunk],
    );
    written += chunk.length;
  }
  return written;
}
