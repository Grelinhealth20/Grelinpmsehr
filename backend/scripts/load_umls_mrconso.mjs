/**
 * Stream UMLS Metathesaurus MRCONSO.RRF (from stdin) and load high-value source vocabularies
 * into umls_atoms + the unified terminology_cache. REAL UMLS data only.
 *
 * The full Metathesaurus (~40GB extracted) cannot be fully loaded on constrained disk, and the
 * clinical core (SNOMED CT US, ICD-10-CM, CPT) is already loaded from authoritative sources.
 * This targets the vocabularies still missing: RxNorm, HCPCS, LOINC, CVX — English atoms only.
 *
 * Usage:
 *   unzip -p umls-...zip 2026AA/META/MRCONSO.RRF | \
 *     node scripts/load_umls_mrconso.mjs --sabs RXNORM,HCPCS,LNC,CVX
 */
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SABS = new Set(String(arg('sabs', 'RXNORM,HCPCS,LNC,CVX')).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean));

// MRCONSO columns: CUI0 LAT1 TS2 LUI3 STT4 SUI5 ISPREF6 AUI7 SAUI8 SCUI9 SDUI10 SAB11 TTY12 CODE13 STR14 SRL15 SUPPRESS16 CVF17
let batch = []; let scanned = 0; let kept = 0;
async function flush() {
  if (!batch.length) return; const rows = batch; batch = [];
  await pool.query(
    'INSERT INTO umls_atoms (cui, sab, code, tty, str, is_pref, ts, suppress) VALUES ?', [rows]);
  kept += rows.length;
}

console.log('Streaming MRCONSO for:', [...SABS].join(', '));
// Start clean so re-runs are idempotent for these SABs.
await pool.query('DELETE FROM umls_atoms WHERE sab IN (?)', [[...SABS]]);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if ((++scanned % 2_000_000) === 0) process.stdout.write(`\r  scanned ${scanned} atoms, kept ${kept + batch.length}`);
  if (line.charCodeAt(0) !== 67) continue;        // fast skip: every CUI starts with 'C'
  const c = line.split('|');
  if (c[1] !== 'ENG') continue;
  const sab = c[11];
  if (!SABS.has(sab)) continue;
  const code = c[13];
  const str = c[14];
  if (!code || code === 'NOCODE' || !str) continue;
  batch.push([c[0] || null, sab, code.slice(0, 64), c[12] || null, str.slice(0, 1000),
    c[6] === 'Y' ? 1 : 0, c[2] || null, c[16] || null]);
  if (batch.length >= 2000) await flush();
}
await flush();
process.stdout.write(`\r  scanned ${scanned} atoms, kept ${kept}\n`);

// Build unified terminology_cache: one preferred English term per (sab, code).
console.log('  building terminology_cache (preferred atom per code)…');
for (const sab of SABS) {
  await pool.query('DELETE FROM terminology_cache WHERE source = ?', [sab]);
  await pool.query(
    `INSERT INTO terminology_cache (source, code, term)
       SELECT sab, code, term FROM (
         SELECT sab, code, SUBSTRING(str,1,512) AS term,
                ROW_NUMBER() OVER (PARTITION BY sab, code
                  ORDER BY (suppress='N') DESC, (is_pref=1) DESC, (ts='P') DESC, CHAR_LENGTH(str)) rn
           FROM umls_atoms WHERE sab = ?
       ) x WHERE rn = 1
     ON DUPLICATE KEY UPDATE term = VALUES(term), updated_at = NOW()`, [sab]);
  const [[n]] = [(await pool.query('SELECT COUNT(*) n FROM terminology_cache WHERE source=?', [sab]))[0]];
  console.log(`    ${sab}: ${n.n} codes`);
}

const [[tot]] = [(await pool.query('SELECT COUNT(*) n FROM umls_atoms'))[0]];
console.log(`\nDONE — umls_atoms=${tot.n}`);
await pool.end();
process.exit(0);
