/**
 * Stream UMLS MRCONSO.RRF (stdin) and load ALL English RXNORM atoms into umls_atoms. REAL UMLS data.
 * This supplies the missing `rxcui` ↔ UMLS `CUI` bridge (RXNORM atom CODE = rxcui, CUI = field 0),
 * which lets us join RxNorm ingredients to their ATC / MED-RT class concepts entirely locally.
 *
 * Focused on umls_atoms ONLY — it deliberately does NOT touch terminology_cache (the RxNorm med-search
 * cache is populated separately by load_rxnorm.mjs and must not be overwritten).
 *
 * Usage: unzip -p umls-2026AA-metathesaurus-full.zip 2026AA/META/MRCONSO.RRF | node scripts/load_umls_rxnorm_atoms.mjs
 */
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

// MRCONSO: CUI0 LAT1 TS2 LUI3 STT4 SUI5 ISPREF6 AUI7 SAUI8 SCUI9 SDUI10 SAB11 TTY12 CODE13 STR14 SRL15 SUPPRESS16 CVF17
let batch = []; let scanned = 0; let kept = 0;
async function flush() {
  if (!batch.length) return; const rows = batch; batch = [];
  await pool.query('INSERT INTO umls_atoms (cui, sab, code, tty, str, is_pref, ts, suppress) VALUES ?', [rows]);
  kept += rows.length;
}

console.log('Streaming MRCONSO → RXNORM English atoms (complete, no sampling)…');
await pool.query("DELETE FROM umls_atoms WHERE sab='RXNORM'");   // idempotent re-run

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if ((++scanned % 2_000_000) === 0) process.stdout.write(`\r  scanned ${scanned}, kept ${kept + batch.length}`);
  if (line.charCodeAt(0) !== 67) continue;         // every CUI starts with 'C'
  const c = line.split('|');
  if (c[1] !== 'ENG' || c[11] !== 'RXNORM') continue;
  const code = c[13]; const str = c[14];
  if (!code || code === 'NOCODE' || !str) continue;
  batch.push([c[0] || null, 'RXNORM', code.slice(0, 64), c[12] || null, str.slice(0, 1000),
    c[6] === 'Y' ? 1 : 0, c[2] || null, c[16] || null]);
  if (batch.length >= 4000) await flush();
}
await flush();
process.stdout.write(`\r  scanned ${scanned}, kept ${kept}\n`);

const [[a]] = [(await pool.query("SELECT COUNT(*) n FROM umls_atoms WHERE sab='RXNORM'"))[0]];
const [[b]] = [(await pool.query("SELECT COUNT(DISTINCT cui) n FROM umls_atoms WHERE sab='RXNORM'"))[0]];
console.log(`DONE — RXNORM atoms=${a.n}, distinct CUIs=${b.n}`);
await pool.end();
process.exit(0);
