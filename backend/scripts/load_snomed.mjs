/**
 * Load the SNOMED CT US Edition (RF2 Snapshot) into the DB — REAL SNOMED data only.
 *
 * Populates:
 *   snomed_concepts       (id, active, definition_status_id, effective_time)
 *   snomed_descriptions   (all FSN + synonyms; us_preferred marked from the US language refset)
 *   terminology_cache     (source='SNOMEDCT_US') — one clinician-facing term per ACTIVE concept
 *                         (US-preferred synonym, falling back to the Fully Specified Name)
 *
 * Usage:
 *   node --max-old-space-size=4096 scripts/load_snomed.mjs \
 *     --concept   sct2_Concept_Snapshot_*.txt \
 *     --description sct2_Description_Snapshot-en_*.txt \
 *     --language  der2_cRefset_LanguageSnapshot-en_*.txt
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const CONCEPT = arg('concept');
const DESCRIPTION = arg('description');
const LANGUAGE = arg('language');

const US_REFSET = '900000000000509007';      // US English language refset
const ACCEPT_PREFERRED = '900000000000548007'; // "Preferred"
const TYPE_FSN = '900000000000003001';
const TYPE_SYNONYM = '900000000000013009';

const asDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

function rl(file) { return readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity }); }

// 1) US-preferred description IDs from the language refset ------------------------------------
async function loadPreferredSet() {
  const preferred = new Set();
  let header = true; let n = 0;
  for await (const line of rl(LANGUAGE)) {
    if (header) { header = false; continue; }
    const c = line.split('\t');
    // active[2], refsetId[4], referencedComponentId[5]=descriptionId, acceptabilityId[6]
    if (c[2] === '1' && c[4] === US_REFSET && c[6] === ACCEPT_PREFERRED) preferred.add(c[5]);
    if ((++n % 1_000_000) === 0) process.stdout.write(`\r  language refset: ${n} rows`);
  }
  process.stdout.write(`\r  language refset: ${n} rows → ${preferred.size} US-preferred descriptions\n`);
  return preferred;
}

// 2) Concepts --------------------------------------------------------------------------------
async function loadConcepts() {
  let batch = []; let n = 0;
  const flush = async () => {
    if (!batch.length) return; const rows = batch; batch = [];
    await pool.query(
      `INSERT INTO snomed_concepts (id, active, definition_status_id, effective_time) VALUES ?
       ON DUPLICATE KEY UPDATE active=VALUES(active), definition_status_id=VALUES(definition_status_id),
         effective_time=VALUES(effective_time)`, [rows]);
  };
  let header = true;
  for await (const line of rl(CONCEPT)) {
    if (header) { header = false; continue; }
    const c = line.split('\t');            // id[0], effectiveTime[1], active[2], moduleId[3], defStatus[4]
    if (!c[0]) continue;
    batch.push([c[0], c[2] === '1' ? 1 : 0, c[4] || null, asDate(c[1])]);
    if (batch.length >= 2000) await flush();
    n += 1;
  }
  await flush();
  return n;
}

// 3) Descriptions ----------------------------------------------------------------------------
async function loadDescriptions(preferred) {
  let batch = []; let n = 0;
  const flush = async () => {
    if (!batch.length) return; const rows = batch; batch = [];
    await pool.query(
      `INSERT INTO snomed_descriptions
         (id, concept_id, type_id, term, language_code, case_significance_id, active, us_preferred) VALUES ?
       ON DUPLICATE KEY UPDATE concept_id=VALUES(concept_id), type_id=VALUES(type_id), term=VALUES(term),
         language_code=VALUES(language_code), case_significance_id=VALUES(case_significance_id),
         active=VALUES(active), us_preferred=VALUES(us_preferred)`, [rows]);
  };
  let header = true;
  for await (const line of rl(DESCRIPTION)) {
    if (header) { header = false; continue; }
    // id[0], eff[1], active[2], mod[3], conceptId[4], lang[5], typeId[6], term[7], caseSig[8]
    const c = line.split('\t');
    if (!c[0] || !c[4] || !c[7]) continue;
    batch.push([c[0], c[4], c[6] || null, c[7].slice(0, 512), c[5] || null, c[8] || null,
      c[2] === '1' ? 1 : 0, preferred.has(c[0]) ? 1 : 0]);
    if (batch.length >= 2000) await flush();
    if ((++n % 500_000) === 0) process.stdout.write(`\r  descriptions: ${n} rows`);
  }
  await flush();
  process.stdout.write(`\r  descriptions: ${n} rows\n`);
  return n;
}

// 4) Unified terminology_cache: one term per active concept ----------------------------------
async function buildTerminologyCache() {
  // Baseline: FSN for every active concept.
  await pool.query(
    `INSERT INTO terminology_cache (source, code, term)
       SELECT 'SNOMEDCT_US', d.concept_id, SUBSTRING(d.term, 1, 512)
         FROM snomed_descriptions d
         JOIN snomed_concepts c ON c.id = d.concept_id AND c.active = 1
        WHERE d.active = 1 AND d.type_id = ?
     ON DUPLICATE KEY UPDATE term = VALUES(term), updated_at = NOW()`, [TYPE_FSN]);
  // Override with the US-preferred synonym where one exists (cleaner clinician-facing term).
  await pool.query(
    `INSERT INTO terminology_cache (source, code, term)
       SELECT 'SNOMEDCT_US', d.concept_id, SUBSTRING(d.term, 1, 512)
         FROM snomed_descriptions d
         JOIN snomed_concepts c ON c.id = d.concept_id AND c.active = 1
        WHERE d.active = 1 AND d.us_preferred = 1 AND d.type_id = ?
     ON DUPLICATE KEY UPDATE term = VALUES(term), updated_at = NOW()`, [TYPE_SYNONYM]);
}

console.log('Loading SNOMED CT US Edition (RF2 Snapshot)…');
const preferred = await loadPreferredSet();
const nc = await loadConcepts();  console.log(`  concepts: ${nc} rows`);
const nd = await loadDescriptions(preferred);
console.log('  building unified terminology_cache (preferred term / FSN per active concept)…');
await buildTerminologyCache();
const [[cc]] = [(await pool.query('SELECT COUNT(*) n FROM snomed_concepts'))[0]];
const [[dc]] = [(await pool.query('SELECT COUNT(*) n FROM snomed_descriptions'))[0]];
const [[tc]] = [(await pool.query("SELECT COUNT(*) n FROM terminology_cache WHERE source='SNOMEDCT_US'"))[0]];
console.log(`\nDONE — snomed_concepts=${cc.n}, snomed_descriptions=${dc.n}, terminology_cache[SNOMEDCT_US]=${tc.n}`);
await pool.end();
process.exit(0);
