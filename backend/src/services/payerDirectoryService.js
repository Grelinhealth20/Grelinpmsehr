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

/** Normalize a state to its 2-letter USPS code ('' if unknown). */
export function normalizeState(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t) return '';
  if (t.length === 2) return t;
  return STATE_ABBR[t] || '';
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

/** How many payers are loaded (0 => run the loader before relying on the DB). */
export async function payerCount() {
  const [rows] = await execute('SELECT COUNT(*) AS n FROM stedi_payers');
  return Number(rows[0]?.n || 0);
}

/**
 * Resolve a payer. Precedence: exact Stedi ID / primary payer ID / display name /
 * alias-token / name-token, then a display-name prefix/contains fallback. Payers
 * that support eligibility inquiries are always preferred. Returns null on no
 * match (caller may then fall back to the live Stedi payer-search API).
 */
export async function resolvePayer(queryText, opts = {}) {
  const q = String(queryText || '').trim();
  if (!q) return null;
  // Traditional Medicare Part B → the state-specific MAC payer for the facility's
  // state (real-time). Returns null if the state is unknown so the caller can
  // surface it, rather than routing to a wrong-state Medicare payer.
  if (isMedicarePartB(q)) return resolveMedicarePartB(opts.state);
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  // Relevance scoring so an EXACT identifier / display-name / whole-token match
  // always outranks a mere substring hit. Without this, a short unrelated payer
  // that merely lists the query as an alias/name token could win on name length
  // (e.g. "Humana" wrongly resolving to "iCare"). Highest score wins; ties break
  // toward eligibility-supported payers, then the shorter (more canonical) name.
  const [rows] = await execute(
    `SELECT stedi_id, primary_payer_id, display_name, eligibility_supported,
       (CASE
          WHEN UPPER(stedi_id) = :qu1 THEN 100
          WHEN UPPER(primary_payer_id) = :qu2 THEN 92
          WHEN LOWER(display_name) = :ql1 THEN 88
          WHEN CONCAT('|', UPPER(aliases), '|') LIKE :aliasTok1 THEN 74
          WHEN CONCAT('|', LOWER(names), '|') LIKE :nameTok1 THEN 70
          WHEN LOWER(display_name) LIKE :pfx1 THEN 50
          WHEN LOWER(display_name) LIKE :ctn1 THEN 30
          WHEN LOWER(names) LIKE :ctn2 THEN 20
          ELSE 0
        END) AS score
       FROM stedi_payers
      WHERE UPPER(stedi_id) = :qu3
         OR UPPER(primary_payer_id) = :qu4
         OR LOWER(display_name) LIKE :ctn3
         OR CONCAT('|', UPPER(aliases), '|') LIKE :aliasTok2
         OR CONCAT('|', LOWER(names), '|') LIKE :nameTok2
      ORDER BY score DESC, eligibility_supported DESC, CHAR_LENGTH(display_name) ASC
      LIMIT 1`,
    {
      qu1: qUpper, qu2: qUpper, ql1: qLower,
      aliasTok1: `%|${qUpper}|%`, nameTok1: `%|${qLower}|%`,
      pfx1: `${qLower}%`, ctn1: `%${qLower}%`, ctn2: `%${qLower}%`,
      qu3: qUpper, qu4: qUpper, ctn3: `%${qLower}%`,
      aliasTok2: `%|${qUpper}|%`, nameTok2: `%|${qLower}|%`,
    },
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
