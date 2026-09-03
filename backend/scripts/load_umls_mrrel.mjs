/**
 * Stream UMLS MRREL.RRF (stdin) and load the concept-to-concept relationships for the medication-class
 * sources into umls_rel. REAL UMLS data. These are the genuinely missing edges — MED-RT's drug→class
 * relationships (incl. `ci_chemclass` = allergen chemical class, `has_MoA`, `has_PE`, `isa`), the ATC
 * hierarchy, and RxNorm ingredient links — that let allergen-class screening run locally & deterministically.
 *
 * By default loads SAB ∈ {MED-RT, ATC, RXNORM}. Pass --sabs to override. Loading only the medication
 * sources (not all ~100M rows) keeps it to the "needed complete datasets", not literally every edge.
 *
 * Usage: unzip -p umls-2026AA-metathesaurus-full.zip 2026AA/META/MRREL.RRF | node scripts/load_umls_mrrel.mjs
 */
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SABS = new Set(String(arg('sabs', 'MED-RT,ATC,RXNORM')).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean));

// MRREL: CUI1_0 AUI1_1 STYPE1_2 REL_3 CUI2_4 AUI2_5 STYPE2_6 RELA_7 RUI_8 SRUI_9 SAB_10 SL_11 RG_12 DIR_13 SUPPRESS_14 CVF_15
let batch = []; let scanned = 0; let kept = 0;
async function flush() {
  if (!batch.length) return; const rows = batch; batch = [];
  await pool.query('INSERT INTO umls_rel (cui1, cui2, rel, rela, sab, aui1, aui2) VALUES ?', [rows]);
  kept += rows.length;
}

console.log('Streaming MRREL for SABs:', [...SABS].join(', '), '(complete, no sampling)…');
await pool.query('DELETE FROM umls_rel WHERE sab IN (?)', [[...SABS]]);   // idempotent re-run

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if ((++scanned % 5_000_000) === 0) process.stdout.write(`\r  scanned ${scanned}, kept ${kept + batch.length}`);
  if (line.charCodeAt(0) !== 67) continue;         // every CUI starts with 'C'
  const c = line.split('|');
  const sab = c[10];
  if (!SABS.has(sab)) continue;
  const cui1 = c[0]; const cui2 = c[4];
  if (!cui1 || !cui2) continue;
  batch.push([cui1, cui2, c[3] || null, c[7] || null, sab, (c[1] || '').slice(0, 12) || null, (c[5] || '').slice(0, 12) || null]);
  if (batch.length >= 5000) await flush();
}
await flush();
process.stdout.write(`\r  scanned ${scanned}, kept ${kept}\n`);

console.log('=== relationships loaded by (sab, rela) ===');
const [rows] = await pool.query(
  'SELECT sab, rela, COUNT(*) n FROM umls_rel GROUP BY sab, rela ORDER BY sab, n DESC');
for (const r of rows) console.log(`  ${r.sab.padEnd(8)} ${String(r.rela).padEnd(22)} ${r.n}`);
const [[tot]] = [(await pool.query('SELECT COUNT(*) n FROM umls_rel'))[0]];
console.log(`DONE — umls_rel=${tot.n}`);
await pool.end();
process.exit(0);
