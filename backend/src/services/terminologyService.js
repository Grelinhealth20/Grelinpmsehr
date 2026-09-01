import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * Clinical terminology lookups against the UMLS Terminology Services (NLM), real-time.
 *
 * The `uts-ws` REST API is a per-query lookup service (NOT a bulk export). Every real
 * result is written to the local `terminology_cache` table so repeated lookups are instant
 * and the DB accumulates the exact codes this practice uses — REAL NLM data only, never
 * mock/sample. Supported UMLS root sources (sabs): SNOMED CT US, RxNorm, CPT, HCPCS,
 * ICD-10-CM, CDT, LOINC.
 */
// UMLS root sources (sabs) we expose. 'ALL' searches the ENTIRE UMLS Metathesaurus (no sab
// filter) so nothing is missed — SNOMED CT US already carries the SNOMED international core;
// 'ALL' also surfaces any other UMLS vocabulary. (NIH CDE is a separate NLM resource with
// its own API — not part of the UMLS Metathesaurus — so it is not reachable via uts-ws.)
export const TERM_SOURCES = ['ALL', 'SNOMEDCT_US', 'RXNORM', 'CPT', 'HCPCS', 'ICD10CM', 'ICD10PCS', 'CDT', 'LNC', 'CVX', 'MTHICD9'];

export function umlsEnabled() { return config.umls.enabled; }

const SCT_SYNONYM = 900000000000013009;
// Whether the full local SNOMED CT US Edition has been loaded (so we search it directly
// instead of the per-query UMLS API). Cached after first check.
let _snomedLocal = null;
async function snomedLoadedLocally() {
  if (_snomedLocal !== null) return _snomedLocal;
  try {
    const [r] = await pool.query('SELECT 1 FROM snomed_descriptions LIMIT 1');
    _snomedLocal = r.length > 0;
  } catch { _snomedLocal = false; }
  return _snomedLocal;
}

/**
 * Search the full local SNOMED CT US Edition (all active descriptions — FSN + synonyms).
 * Returns [{ code: conceptId, name: term, source, preferred }], preferred terms first.
 */
export async function searchSnomed(query, { pageSize = 20 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const limit = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  const byCode = /^\d{6,18}$/.test(q); // SNOMED concept ids are numeric
  if (byCode) {
    const [rows] = await pool.query(
      `SELECT d.concept_id AS code, d.term AS name, d.us_preferred AS preferred
         FROM snomed_descriptions d JOIN snomed_concepts c ON c.id = d.concept_id
        WHERE d.concept_id = ? AND d.active = 1 AND c.active = 1
        ORDER BY d.us_preferred DESC, (d.type_id = ?) DESC LIMIT ?`,
      [q, SCT_SYNONYM, limit]);
    return rows.map((r) => ({ code: String(r.code), name: r.name, source: 'SNOMEDCT_US', preferred: !!r.preferred }));
  }
  // Fast word-based match via FULLTEXT (ft_sct_term). Each word required, last one a prefix so
  // it works as a type-ahead. Falls back to a prefix LIKE for very short/stopword-only queries.
  const words = q.split(/\s+/).map((w) => w.replace(/[+\-><()~*"@]/g, '').trim()).filter((w) => w.length >= 2);
  const boolean = words.map((w, i) => `+${w}${i === words.length - 1 ? '*' : ''}`).join(' ');
  let rows = [];
  if (boolean) {
    [rows] = await pool.query(
      `SELECT d.concept_id AS code, d.term AS name, d.us_preferred AS preferred,
              MATCH(d.term) AGAINST(? IN BOOLEAN MODE) AS score
         FROM snomed_descriptions d JOIN snomed_concepts c ON c.id = d.concept_id
        WHERE d.active = 1 AND c.active = 1 AND MATCH(d.term) AGAINST(? IN BOOLEAN MODE)
        ORDER BY (d.term LIKE ?) DESC, d.us_preferred DESC, CHAR_LENGTH(d.term), score DESC LIMIT ?`,
      [boolean, boolean, `${q}%`, limit * 4]);
  }
  if (!rows.length) {
    [rows] = await pool.query(
      `SELECT d.concept_id AS code, d.term AS name, d.us_preferred AS preferred
         FROM snomed_descriptions d JOIN snomed_concepts c ON c.id = d.concept_id
        WHERE d.active = 1 AND c.active = 1 AND d.term LIKE ?
        ORDER BY d.us_preferred DESC, CHAR_LENGTH(d.term) LIMIT ?`, [`${q}%`, limit]);
  }
  // One row per concept (prefer the us_preferred/highest-scoring synonym already ordered first).
  const seen = new Set(); const out = [];
  for (const r of rows) {
    const code = String(r.code);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: r.name, source: 'SNOMEDCT_US', preferred: !!r.preferred });
    if (out.length >= limit) break;
  }
  return out;
}

async function umlsFetch(path, params) {
  const usp = new URLSearchParams({ ...params, apiKey: config.umls.apiKey });
  const url = `${config.umls.baseUrl}${path}?${usp.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.umls.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`UMLS request failed (${res.status})`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// Persist real results (best-effort) so the DB builds up the terminology actually used.
async function cacheResults(rows) {
  if (!rows.length) return;
  try {
    await pool.query(
      `INSERT INTO terminology_cache (source, code, term) VALUES ?
       ON DUPLICATE KEY UPDATE term = VALUES(term), updated_at = NOW()`,
      [rows.map((r) => [r.source, r.code, r.name])],
    );
  } catch (e) { logger.warn({ err: e.message }, 'terminology cache write failed'); }
}

// Whether the full RxNorm concept set has been loaded locally (from RxNav).
let _rxnormLocal = null;
async function rxnormLoadedLocally() {
  if (_rxnormLocal !== null) return _rxnormLocal;
  try { const [r] = await pool.query('SELECT 1 FROM rxnorm_concepts LIMIT 1'); _rxnormLocal = r.length > 0; }
  catch { _rxnormLocal = false; }
  return _rxnormLocal;
}

/** Search the full local RxNorm set (RxNav-loaded). Prescribable/ingredient/brand names first. */
export async function searchRxnorm(query, { pageSize = 20 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const limit = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  if (/^\d+$/.test(q)) {
    const [rows] = await pool.query(
      'SELECT rxcui AS code, name, tty FROM rxnorm_concepts WHERE rxcui = ? LIMIT ?', [q, limit]);
    return rows.map((r) => ({ code: String(r.code), name: r.name, source: 'RXNORM', tty: r.tty }));
  }
  // Prefer prescribable/ingredient/brand types, then prefix matches, then shorter names.
  const [rows] = await pool.query(
    `SELECT rxcui AS code, name, tty FROM rxnorm_concepts
      WHERE name LIKE ?
      ORDER BY FIELD(tty,'SCD','SBD','BPCK','GPCK','BN','IN','PIN','MIN') = 0,
               (name LIKE ?) DESC, CHAR_LENGTH(name) LIMIT ?`,
    [`%${q}%`, `${q}%`, limit]);
  return rows.map((r) => ({ code: String(r.code), name: r.name, source: 'RXNORM', tty: r.tty }));
}

/**
 * Real-time terminology search. Returns [{ code, name, source }] from NLM and caches them.
 * If no API key is configured, serves only the REAL results previously cached (never mock).
 */
export async function searchTerminology(query, { source = 'SNOMEDCT_US', pageSize = 20 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const sab = TERM_SOURCES.includes(source) ? source : 'SNOMEDCT_US';
  const limit = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  // Full SNOMED CT US Edition is loaded locally — search it directly (complete + instant).
  if (sab === 'SNOMEDCT_US' && await snomedLoadedLocally()) {
    return searchSnomed(q, { pageSize: limit });
  }
  // Full RxNorm is loaded locally (from RxNav) — search it directly.
  if (sab === 'RXNORM' && await rxnormLoadedLocally()) {
    return searchRxnorm(q, { pageSize: limit });
  }
  if (!config.umls.enabled) {
    const [rows] = sab === 'ALL'
      ? await pool.query('SELECT source, code, term AS name FROM terminology_cache WHERE term LIKE ? ORDER BY term LIMIT ?', [`%${q}%`, limit])
      : await pool.query('SELECT source, code, term AS name FROM terminology_cache WHERE source = ? AND term LIKE ? ORDER BY term LIMIT ?', [sab, `%${q}%`, limit]);
    return rows;
  }
  // 'ALL' searches the entire UMLS Metathesaurus (no sabs filter) so no vocabulary is missed.
  const params = { string: q, returnIdType: 'code', pageSize: String(limit) };
  if (sab !== 'ALL') params.sabs = sab;
  const data = await umlsFetch('/search/current', params);
  const results = (data?.result?.results || [])
    .filter((r) => r.ui && r.ui !== 'NONE')
    .map((r) => ({ code: r.ui, name: r.name, source: r.rootSource || sab }));
  await cacheResults(results);
  return results;
}

/**
 * AMA CPT® master lookup (local cpt_codes table). Returns the full descriptor set — the
 * `long` descriptor for clinical display and `short` (≤28-char) for CMS-1500 / 837P claims.
 */
export async function lookupCpt(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[0-9]{4}[0-9A-Z]$/.test(c)) return null;
  const [rows] = await pool.query(
    `SELECT code, long_desc AS \`long\`, medium_desc AS medium, short_desc AS \`short\`,
            consumer_desc AS consumer, effective_date AS effectiveDate
       FROM cpt_codes WHERE code = ? LIMIT 1`, [c]);
  return rows[0] || null;
}

// Medicare Part B payability of a CPT/HCPCS from its MPFS status indicator. `billable`:
// true = separately payable, false = not separately payable, null = not on the MPFS (may be
// payable under another fee schedule — clinical lab, DME, etc.). Real CMS MPFS status meanings.
const CPT_STATUS = {
  A: ['payable', 'Active — separately payable under the MPFS'],
  R: ['payable', 'Restricted — payable under specific coverage conditions'],
  T: ['payable', 'Paid only if no other payable service is furnished the same day'],
  C: ['payable', 'Carrier-priced — the MAC sets the payment amount'],
  J: ['payable', 'Anesthesia service — paid under the anesthesia methodology'],
  B: ['not-payable', 'Bundled — payment is included in another service; not separately billable'],
  P: ['not-payable', 'Bundled/excluded — no separate payment'],
  N: ['not-payable', 'Non-covered by Medicare'],
  I: ['not-payable', 'Not valid for Medicare — a more specific code is required'],
  X: ['not-payable', 'Statutory exclusion — not a Medicare benefit'],
  E: ['not-payable', 'Excluded from the physician fee schedule'],
  M: ['not-payable', 'Measurement code — not separately payable'],
};
export function cptPayability(code, status) {
  if (/F$/.test(String(code || ''))) return { billable: false, status: 'CAT_II', statusMeaning: 'Category II performance-measurement code — not billed for payment' };
  const s = String(status || '').toUpperCase();
  if (CPT_STATUS[s]) return { billable: CPT_STATUS[s][0] === 'payable', status: s, statusMeaning: CPT_STATUS[s][1] };
  return { billable: null, status: s || null, statusMeaning: s ? `MPFS status ${s}` : 'Not on the Physician Fee Schedule (may be payable under another fee schedule)' };
}

/** Search the AMA CPT® set by code prefix or descriptor text (long/short/clinician phrasings). */
export async function searchCpt(query, { pageSize = 20 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const limit = Math.max(1, Math.min(Number(pageSize) || 20, 50));
  const like = `%${q}%`;
  // Code-prefix match first (exact billing lookups), then descriptor matches.
  const [rows] = await pool.query(
    `SELECT DISTINCT c.code, c.long_desc AS \`long\`, c.short_desc AS \`short\`, c.medium_desc AS medium,
            r.status_code
       FROM cpt_codes c
       LEFT JOIN cpt_clinician_descriptors d ON d.code = c.code
       LEFT JOIN mpfs_rvu r ON r.hcpcs = c.code AND r.year = 2026 AND r.modifier = ''
      WHERE c.code LIKE ? OR c.long_desc LIKE ? OR c.short_desc LIKE ? OR d.descriptor LIKE ?
      ORDER BY (c.code LIKE ?) DESC, c.code
      LIMIT ?`,
    [`${q}%`, like, like, like, `${q}%`, limit]);
  return rows.map((r) => ({ ...r, ...cptPayability(r.code, r.status_code) }));
}

/** All AMA CPT® Level I modifiers (for charge/claim entry). */
export async function listCptModifiers() {
  const [rows] = await pool.query(
    'SELECT modifier, name, description, section FROM cpt_modifiers ORDER BY modifier');
  return rows;
}

/**
 * Resolve a clinician-selected SNOMED CT concept to its billable ICD-10-CM code(s) using the
 * OFFICIAL SNOMED CT US → ICD-10-CM complex map (snomed_map_icd10cm, refset 6011000124106).
 * Returns { primary, candidates:[{icd, description, mapGroup, mapPriority, rule, advice, contextDependent}] }.
 * map_group 1 / lowest priority is the default; rules other than TRUE/OTHERWISE TRUE are context
 * dependent (age/sex/etc.) and flagged so the UI can prompt the clinician to confirm.
 */
export async function snomedToIcd10cm(conceptId) {
  const id = String(conceptId || '').trim();
  if (!/^\d+$/.test(id)) return { primary: null, candidates: [] };
  const [rows] = await pool.query(
    `SELECT m.map_group, m.map_priority, m.map_rule, m.map_advice, m.icd_code,
            t.term AS icd_desc, (v.code IS NOT NULL) AS billable
       FROM snomed_map_icd10cm m
       LEFT JOIN terminology_cache t ON t.source = 'ICD10CM' AND t.code = m.icd_code
       LEFT JOIN icd10cm_valid v ON v.code = m.icd_code
      WHERE m.snomed_id = ? AND m.icd_code IS NOT NULL AND m.icd_code <> ''
      ORDER BY m.map_group, m.map_priority`, [id]);
  const candidates = rows.map((r) => {
    const rule = (r.map_rule || '').trim().toUpperCase();
    return {
      icd: r.icd_code,
      description: r.icd_desc || null,
      mapGroup: r.map_group,
      mapPriority: r.map_priority,
      rule: r.map_rule,
      advice: r.map_advice,
      contextDependent: !(rule === 'TRUE' || rule === 'OTHERWISE TRUE'),
      // Only a valid-for-submission leaf code can be billed to a payer; a category/header cannot.
      billable: !!Number(r.billable),
    };
  });
  // Primary = the best BILLABLE, unconditional default. Fall back through billable → unconditional
  // → first, but always prefer a code a payer will actually accept.
  const g1 = candidates.filter((c) => c.mapGroup === 1);
  const pick = (arr) => arr.find((c) => c.billable && !c.contextDependent)
    || arr.find((c) => c.billable) || arr.find((c) => !c.contextDependent) || arr[0];
  const primary = pick(g1) || pick(candidates) || null;
  return { primary, candidates };
}

/** Rows currently cached for a source (what has been loaded into the DB so far). */
export async function cachedCount(source) {
  const [rows] = await pool.query(
    source ? 'SELECT COUNT(*) n FROM terminology_cache WHERE source = ?' : 'SELECT COUNT(*) n FROM terminology_cache',
    source ? [source] : [],
  );
  return Number(rows[0].n);
}
